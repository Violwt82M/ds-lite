/**
 * 同步引擎 — Phase 2C：消息级 diff + 增量推送
 *
 * 策略：
 *   连接握手 → 协商 capabilities（双方都报 session-diff）
 *   摘要交换 → 比较 updatedAt，补齐 Session 级新增/修改
 *   连接期间 → 每条新 message 即时推 session-diff
 *   兜底    → session-full 始终可用（Phase 1 的完整实现保留）
 *
 * 不涉及 Zustand store 的 import（避免循环依赖）——用 db 层直接读写。
 */

import * as db from '../chat/db.js'
import type { Session, Message } from '../chat/types.js'
import type { SyncTransport } from './transport.js'
import type {
  SyncMessage,
  SyncSession as SyncSessionMsg,
  SyncDiff,
  SyncSummaryList,
  SyncSummary,
  SyncSettings,
  SyncPersona,
  SyncAppearance,
} from './protocol.js'
import { detectDevice } from './transport.js'
import { APP_VERSION } from '../../version.js'

export class SyncEngine {
  private transport: SyncTransport
  private deviceId: string
  private deviceName: string
  /** 要不要把 apiKey 一起同步过去（安全警告） */
  public syncApiKey = false
  /** 要不要同步外观（头像、气泡色）——头像可能几百 KB */
  public syncAppearance = true
  /** 要不要同步设置（模型、主题、语言、思考强度等） */
  public syncSettings = true
  /** 要不要同步 Persona（角色卡、启用开关） */
  public syncPersona = true
  /** 本机有变更、还没 push 的 Session id */
  private sessionsToPush = new Set<string>()
  /** 本机有新增/修改 message、还没 push 的 Session id（diff 模式优先） */
  private sessionsToDiff = new Map<string, { added: Message[]; updated: Message[] }>()
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Map<string, Set<(data: unknown) => void>>()
  /** 对端的 capabilities（握手后拿到） */
  private peerCaps = new Set<string>()
  /** 上次成功同步的时间戳（session-full 或 session-diff 收齐后） */
  private lastSyncAt = 0
  /** 本机 Session 缓存的 updatedAt（用来快速判断要不要增量 push） */
  private cachedUpdatedAt = new Map<string, number>()

  // --- 自定义事件 API ---
  on(event: string, listener: (data: unknown) => void) {
    let set = this.listeners.get(event)
    if (!set) { set = new Set(); this.listeners.set(event, set) }
    set.add(listener)
    return () => this.off(event, listener)
  }
  off(event: string, listener: (data: unknown) => void) {
    this.listeners.get(event)?.delete(listener)
  }
  private emit(event: string, data: unknown) {
    const set = this.listeners.get(event)
    if (set) for (const l of set) l(data)
  }

  constructor(transport: SyncTransport, opts: { deviceId?: string } = {}) {
    this.transport = transport
    this.deviceId = opts.deviceId ?? getOrCreateDeviceId()
    this.deviceName = detectDevice()
    this.bindTransport()
  }

  // ============ 对外 API ============

  /** 主动推一个 Session 到对端（全量，兜底用） */
  async pushSession(sessionId: string) {
    this.sessionsToPush.add(sessionId)
    this.schedulePush()
  }

  /** 推送全部本地 Session（新配对时常用） */
  async pushAll() {
    const summaries = await db.loadSessionSummaries()
    summaries.forEach((s) => this.sessionsToPush.add(s.id))
    this.schedulePush()
  }

  /** 标记某个 Session 有新 message，下次 flush 时走 diff */
  markSessionDirty(sessionId: string, opts: { added?: Message[]; updated?: Message[] } = {}) {
    const cur = this.sessionsToDiff.get(sessionId) ?? { added: [] as Message[], updated: [] as Message[] }
    if (opts.added) cur.added.push(...opts.added)
    if (opts.updated) cur.updated.push(...opts.updated)
    this.sessionsToDiff.set(sessionId, cur)
    this.schedulePush()
  }

  // ============ 接收路径 ============

  private bindTransport() {
    this.transport.on('message', (raw) => {
      const msg = raw as SyncMessage
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return

      switch (msg.type) {
        case 'hello': {
          this.handleHello(msg)
          break
        }
        case 'session-full': {
          void this.handleSessionFull(msg)
          break
        }
        case 'session-diff': {
          void this.handleSessionDiff(msg)
          break
        }
        case 'summary-list': {
          void this.handleSummaryList(msg)
          break
        }
        case 'pong': {
          const rtt = Date.now() - (msg as { ts: number }).ts
          this.emit('pong', rtt)
          break
        }
        case 'ping': {
          this.transport.send({ type: 'pong', ts: (msg as { ts: number }).ts })
          break
        }
        case 'error': {
          this.emit('peer-error', msg.message)
          break
        }
        case 'settings-full': {
          void this.handleSettings(msg as SyncSettings)
          break
        }
        case 'persona-full': {
          void this.handlePersona(msg as SyncPersona)
          break
        }
        case 'appearance-full': {
          void this.handleAppearance(msg as SyncAppearance)
          break
        }
        default:
          break
      }
    })

    this.transport.on('open', () => {
      this.emit('connected', null)
      this.transport.send({
        type: 'hello',
        device: this.deviceName,
        deviceId: this.deviceId,
        appVersion: APP_VERSION,
        capabilities: ['session-full', 'session-diff', 'summary-sync'],
      })
    })

    this.transport.on('state', (s) => this.emit('transport-state', s))

    // 定期 ping
    const pingTimer = setInterval(() => {
      if (this.transport.isConnected) {
        this.transport.send({ type: 'ping', ts: Date.now() })
      } else {
        clearInterval(pingTimer)
      }
    }, 10000)
  }

  /** 握手：记下对方 capabilities，然后发 summary-list 比 updatedAt */
  private handleHello(msg: { device: string; deviceId: string; capabilities?: string[] }) {
    const caps = msg.capabilities ?? []
    this.peerCaps = new Set(caps)
    this.emit('peer-hello', msg)

    // 发 summary-list 协商哪些 Session 需要同步
    if (caps.includes('summary-sync')) {
      void this.sendSummaryList()
    }

    // 立即发本机设置 / Persona / Appearance（小对象，一次传完）
    void this.sendAllConfig()
  }

  /** 把本机 Session 摘要列表发给对端，让它决定推哪些过来 */
  private async sendSummaryList() {
    const summaries = await db.loadSessionSummaries()
    const list: SyncSummaryList = {
      type: 'summary-list',
      deviceId: this.deviceId,
      summaries: summaries.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
      })),
    }
    this.transport.send(list)
  }

  /** 收到对方的 summary-list → 比 updatedAt → 推我们更新的过去 */
  private async handleSummaryList(msg: SyncSummaryList) {
    const local = await db.loadSessionSummaries()
    const localMap = new Map(local.map((s) => [s.id, s.updatedAt]))
    const remoteMap = new Map(msg.summaries.map((s) => [s.id, s.updatedAt]))

    // 本机新增的 → 推
    for (const l of local) {
      const r = remoteMap.get(l.id)
      if (!r) {
        // 对方没有 → 用 diff 还是 full？对方支持 diff 就用 diff
        if (this.peerCaps.has('session-diff')) {
          await this.pushSessionDiffForNew(l.id)
        } else {
          this.sessionsToPush.add(l.id)
        }
      } else if (l.updatedAt > r) {
        // 对方版本旧 → 用 diff
        if (this.peerCaps.has('session-diff')) {
          await this.pushSessionDiffForUpdate(l.id)
        } else {
          this.sessionsToPush.add(l.id)
        }
      }
    }
    this.schedulePush()
  }

  /** 推新 Session 的 diff 版本（整个 messages 数组都是 added） */
  private async pushSessionDiffForNew(sessionId: string) {
    const session = await db.loadSession(sessionId)
    if (!session) return
    const diff: SyncDiff = {
      type: 'session-diff',
      sessionId,
      addedMessages: [...session.messages],
      updatedMessages: [],
      removedMessageIds: [],
      updatedSession: {
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        rootMessageId: session.rootMessageId ?? null,
        memory: session.memory,
      },
      fromDevice: this.deviceName,
      updatedAt: session.updatedAt ?? Date.now(),
    }
    this.transport.send(diff)
    this.emit('session-sent-diff', { sessionId, added: session.messages.length })
  }

  /** 推修改过的 Session（对比本地 vs 对方上一次看到的版本） */
  private async pushSessionDiffForUpdate(sessionId: string) {
    const session = await db.loadSession(sessionId)
    if (!session) return
    // Phase 2C 简化：Session 有修改时直接用 session-full 兜底
    // 精确的 message 级 diff 在实时连接期间（markSessionDirty）已经在做了
    const localUpdated = session.updatedAt ?? 0
    const cached = this.cachedUpdatedAt.get(sessionId) ?? 0
    if (localUpdated <= cached) {
      // 没有新变更 → 不推
      return
    }
    this.sessionsToPush.add(sessionId)
    this.cachedUpdatedAt.set(sessionId, localUpdated)
  }

  /** 收到对方的全量 Session → updatedAt 赢的那个覆盖 */
  private async handleSessionFull(msg: SyncSessionMsg) {
    const incoming = msg.session as Session
    if (!incoming || !incoming.id) {
      this.emit('error', '收到的 Session 缺少 id')
      return
    }
    const local = await db.loadSession(incoming.id)
    if (local) {
      const localUpdated = local.updatedAt ?? 0
      const remoteUpdated = incoming.updatedAt ?? 0
      if (remoteUpdated <= localUpdated) {
        this.emit('skipped', { sessionId: incoming.id, reason: '本机版本更新或相等' })
        return
      }
    }
    try {
      await db.saveSession(incoming)
      this.cachedUpdatedAt.set(incoming.id, incoming.updatedAt ?? Date.now())
      this.emit('session-written', { sessionId: incoming.id, isNew: !local })
    } catch (e) {
      this.emit('error', `写入 Session ${incoming.id} 失败: ${(e as Error).message}`)
    }
  }

  /** 收到对方的增量 diff → 合并到本机 */
  private async handleSessionDiff(msg: SyncDiff) {
    const local = await db.loadSession(msg.sessionId)
    let target: Session
    let isNew = false

    if (local) {
      target = local
    } else {
      target = {
        id: msg.sessionId,
        title: (msg.updatedSession as Partial<Session> | undefined)?.title ?? '(来自同步)',
        createdAt: Date.now(),
        updatedAt: msg.updatedAt,
        messages: [],
        rootMessageId: (msg.updatedSession as any)?.rootMessageId ?? null,
        memory: (msg.updatedSession as any)?.memory,
      }
      isNew = true
    }

    // 合并 messages（按 id 唯一，同 id 的后来的覆盖）
    const messageMap = new Map(target.messages.map((m) => [m.id, m]))

    for (const m of msg.addedMessages ?? []) {
      messageMap.set(m.id, m as Message)
    }
    for (const m of msg.updatedMessages ?? []) {
      messageMap.set(m.id, m as Message)
    }
    // removedMessageIds Phase 2C 暂时不处理（DS Lite 不会真删除 message）

    target.messages = [...messageMap.values()]

    // Session 元数据覆盖（如果对方 updatedAt 更新）
    if (msg.updatedSession && (!target.updatedAt || msg.updatedAt > target.updatedAt)) {
      const meta = msg.updatedSession as Partial<Session>
      if (meta.title !== undefined) target.title = meta.title
      if (meta.updatedAt !== undefined) target.updatedAt = meta.updatedAt
      if (meta.rootMessageId !== undefined) target.rootMessageId = meta.rootMessageId
      if (meta.memory !== undefined) target.memory = meta.memory
      if (meta.records !== undefined) target.records = meta.records
    }

    try {
      await db.saveSession(target)
      this.cachedUpdatedAt.set(target.id, target.updatedAt ?? Date.now())
      this.emit('session-diff-applied', {
        sessionId: target.id,
        isNew,
        added: msg.addedMessages?.length ?? 0,
        updated: msg.updatedMessages?.length ?? 0,
      })
    } catch (e) {
      this.emit('error', `写入 Session ${target.id} 失败: ${(e as Error).message}`)
    }
  }

  // ============ 推送节流 ============

  private schedulePush() {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.flushPush()
    }, 300) // debounce
  }

  private async flushPush() {
    if (!this.transport.isConnected) return

    // 1. 先发 diff 模式的增量
    const diffEntries = [...this.sessionsToDiff.entries()]
    this.sessionsToDiff.clear()
    for (const [sessionId, diff] of diffEntries) {
      const baseSession = await db.loadSession(sessionId)
      if (!baseSession) continue

      const diffMsg: SyncDiff = {
        type: 'session-diff',
        sessionId,
        addedMessages: diff.added,
        updatedMessages: diff.updated,
        removedMessageIds: [],
        updatedSession: {
          id: sessionId,
          title: baseSession.title,
          updatedAt: baseSession.updatedAt,
        },
        fromDevice: this.deviceName,
        updatedAt: baseSession.updatedAt ?? Date.now(),
      }
      this.transport.send(diffMsg)
      this.emit('session-sent-diff', {
        sessionId,
        added: diff.added.length,
        updated: diff.updated.length,
      })
      this.cachedUpdatedAt.set(sessionId, baseSession.updatedAt ?? Date.now())
    }

    // 2. 再发全量 session-full（兜底，优先级低于 diff）
    const ids = [...this.sessionsToPush]
    this.sessionsToPush.clear()
    for (const id of ids) {
      const session = await db.loadSession(id)
      if (!session) continue
      const msg: SyncSessionMsg = {
        type: 'session-full',
        sessionId: id,
        session,
        updatedAt: session.updatedAt ?? Date.now(),
        fromDevice: this.deviceName,
      }
      this.transport.send(msg)
      this.emit('session-sent', id)
      this.cachedUpdatedAt.set(id, session.updatedAt ?? Date.now())
    }
  }

  // ============ 设置 / Persona / Appearance 同步 ============

  /** 一次性发完所有非 Session 配置（握手后立即发，之后按需重发） */
  async sendAllConfig() {
    if (!this.transport.isConnected) return
    if (this.syncSettings) this.sendSettings()
    if (this.syncPersona) this.sendPersona()
    if (this.syncAppearance) this.sendAppearance()
  }

  /** 设置同步（所有 chat-demo:* key，apiKey 默认跳过） */
  sendSettings() {
    const settings: Record<string, string | null> = {}
    for (const key of SETTINGS_KEYS) {
      let v: string | null = null
      try { v = localStorage.getItem(key) } catch { continue }
      // apiKey 除非显式允许，否则故意不传（对方保持自己的）
      if (key === 'chat-demo:api-key' && !this.syncApiKey) continue
      settings[key] = v
    }
    const msg: SyncSettings = {
      type: 'settings-full',
      settings,
      includeApiKey: this.syncApiKey,
      fromDevice: this.deviceName,
      updatedAt: Date.now(),
    }
    this.transport.send(msg)
    this.emit('settings-sent', { keys: Object.keys(settings).length })
  }

  /** Persona 同步（整颗 JSON） */
  sendPersona() {
    let raw: string | null = null
    try { raw = localStorage.getItem(PERSONA_KEY) } catch {}
    if (!raw) return
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { return }
    const msg: SyncPersona = {
      type: 'persona-full',
      persona: parsed,
      fromDevice: this.deviceName,
      updatedAt: Date.now(),
    }
    this.transport.send(msg)
    this.emit('persona-sent', null)
  }

  /** Appearance 同步（三个 key） */
  sendAppearance() {
    let avatar: string | null = null, bubble: string | null = null, aiBubble: string | null = null
    try { avatar = localStorage.getItem('chat-demo:user-avatar') } catch {}
    try { bubble = localStorage.getItem('chat-demo:user-bubble') } catch {}
    try { aiBubble = localStorage.getItem('chat-demo:ai-bubble') } catch {}
    const msg: SyncAppearance = {
      type: 'appearance-full',
      appearance: { userAvatar: avatar, bubbleColor: bubble, aiBubbleColor: aiBubble },
      fromDevice: this.deviceName,
      updatedAt: Date.now(),
    }
    this.transport.send(msg)
    this.emit('appearance-sent', null)
  }

  private async handleSettings(msg: SyncSettings) {
    if (!this.syncSettings) { this.emit('settings-received-skipped'); return }
    const applied: string[] = []
    for (const [key, value] of Object.entries(msg.settings)) {
      // 对方没带 apiKey 也不带我这边的（两边都跳过）
      if (key === 'chat-demo:api-key' && !msg.includeApiKey) continue
      try {
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
        applied.push(key)
      } catch {}
    }
    // 触发 Zustand store 刷新——settings.ts 的 useSettings 有 localStorage 订阅吗？
    // 实际没有自动订阅，用户下次刷新页面就生效。
    this.emit('settings-applied', { keys: applied.length, from: msg.fromDevice })
  }

  private async handlePersona(msg: SyncPersona) {
    if (!this.syncPersona) { this.emit('persona-received-skipped'); return }
    try {
      localStorage.setItem(PERSONA_KEY, JSON.stringify(msg.persona))
      this.emit('persona-applied', { from: msg.fromDevice })
    } catch {
      this.emit('error', '写入 Persona 失败')
    }
  }

  private async handleAppearance(msg: SyncAppearance) {
    if (!this.syncAppearance) { this.emit('appearance-received-skipped'); return }
    const { userAvatar, bubbleColor, aiBubbleColor } = msg.appearance
    try {
      userAvatar === null
        ? localStorage.removeItem('chat-demo:user-avatar')
        : localStorage.setItem('chat-demo:user-avatar', userAvatar)
      bubbleColor === null
        ? localStorage.removeItem('chat-demo:user-bubble')
        : localStorage.setItem('chat-demo:user-bubble', bubbleColor)
      aiBubbleColor === null
        ? localStorage.removeItem('chat-demo:ai-bubble')
        : localStorage.setItem('chat-demo:ai-bubble', aiBubbleColor)
      this.emit('appearance-applied', { from: msg.fromDevice })
    } catch {
      this.emit('error', '写入 Appearance 失败')
    }
  }
}

// ============ 同步用的 key 列表 ============

/** settings.ts 里所有 localStorage key（apiKey 单独处理） */
const SETTINGS_KEYS = [
  'chat-demo:api-key',
  'chat-demo:locale',
  'chat-demo:location',
  'chat-demo:theme-preference',
  'chat-demo:tts-voice',
  'chat-demo:thinking',
  'chat-demo:thinking-effort',
  'chat-demo:search',
  'chat-demo:sider-collapsed',
  'chat-demo:safety',
  'chat-demo:auto-memory',
  'chat-demo:show-balance',
  'chat-demo:model',
  'chat-demo:font-scale',
  'chat-demo:record-model',
  'chat-demo:memory-mode',
  'chat-demo:document-budget',
  'chat-demo:bubble-skin',
] as const

const PERSONA_KEY = 'ds-lite:persona'

const DEVICE_ID_KEY = 'ds-lite.sync.deviceId'
function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY)
    if (existing) return existing
  } catch {}
  const id = crypto.randomUUID()
  try { localStorage.setItem(DEVICE_ID_KEY, id) } catch {}
  return id
}
