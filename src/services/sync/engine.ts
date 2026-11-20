/**
 * 同步引擎 — Phase 2C：消息级 diff + 增量推送
 *
 * 卡死修复（Android WebView）：
 *   接收路径（handleXxx）→ 纯内存操作 + 塞 ioQueue → 绝不 await db 或 localStorage
 *   发送路径（flushPush）→ debounced setTimeout → 串行 await db + transport.send
 *   IO 串行刷新（flushIoQueue）→ requestIdleCallback / setTimeout → 串行 IndexedDB + localStorage
 *
 * 根因：Android WebView 单线程 + IndexedDB 比桌面慢 5-10x，
 *       多个并发 IndexedDB 事务 + 同步 localStorage.setItem 阻塞了 WebRTC DataChannel 回调，
 *       导致双方都收不到对方的下一条消息 → 卡死。
 */

import * as db from '../chat/db.js'
import type { Session, Message } from '../chat/types.js'
import type { SyncTransport } from './transport.js'
import type {
  SyncMessage,
  SyncSession as SyncSessionMsg,
  SyncDiff,
  SyncSummaryList,
  SyncSettings,
  SyncPersona,
  SyncAppearance,
  SyncWallpaperMeta,
  SyncWallpaperChunk,
} from './protocol.js'
import { detectDevice } from './transport.js'
import { notifyRemoteSessionsChanged, notifyRemoteSessionMerge } from './bridge.js'
import { mergePersonaState, personaUpdatedAt } from '../persona/store.js'
import { applySyncedSettings, settingsSyncMeta } from '../settings.js'
import { refreshWallpaperFromStorage, readWallpaperBlob, wallpaperUpdatedAt, applySyncedWallpaper, WALLPAPER_TS_KEY } from '../wallpaper.js'
import { APP_VERSION } from '../../version.js'

/** 接收路径待写入队列 —— flushIoQueue 里串行落地 */
type PendingWrite =
  | { kind: 'session-full'; session: Session }
  | { kind: 'session-diff'; sessionId: string; applied: Session }
  | { kind: 'settings'; settings: Record<string, string | null>; meta?: Record<string, number>; includeApiKey: boolean }
  | { kind: 'persona'; persona: unknown; updatedAt: number }
  | { kind: 'appearance'; avatar: string | null; bubble: string | null; aiBubble: string | null }
  | { kind: 'wallpaper'; blob: Blob; updatedAt: number }

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

  // --- 发送路径队列（主动推给对方）---
  /** 本机有变更、还没 push 的 Session id（full 兜底） */
  private sessionsToPush = new Set<string>()
  /** 本机有新增/修改 message、还没 push 的 Session id（实时 diff） */
  private sessionsToDiff = new Map<string, { added: Message[]; updated: Message[] }>()
  /** summary-list 协商出的「对方没有，需要推 diff 过去」的 Session id */
  private sessionsToDiffNew = new Set<string>()
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  /** 「推送全部」按钮的进度（仅 UI 展示，不参与协议） */
  private manualPushIds = new Set<string>()
  private manualPushTotal = 0
  private manualPushDone = 0

  // --- 接收路径队列（对方发来的，需要落地到本地）---
  private ioQueue: PendingWrite[] = []
  private ioFlushing = false

  // --- 内部状态 ---
  private listeners = new Map<string, Set<(data: unknown) => void>>()
  /** 对端的 capabilities（握手后拿到） */
  private peerCaps = new Set<string>()
  /** 本机 Session 缓存的 updatedAt（用来快速判断要不要增量 push） */
  private cachedUpdatedAt = new Map<string, number>()
  /** 每条 message 上次同步出去的指纹（id -> 内容签名），用来只推真正变了的 */
  private sentSignatures = new Map<string, Map<string, string>>()
  /** 每条会话上次同步出去的压缩 memory 指纹；messages 没变但压缩结果变了也要推 */
  private sentMemorySig = new Map<string, string>()
  /** 正在接收的自定义背景图分块（传输 id -> 状态） */
  private pendingWallpapers = new Map<string, { mime: string; total: number; updatedAt: number; parts: (string | null)[]; got: number }>()

  // ============ 自定义事件 API ============

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

  // ============ 构造 + transport 绑定 ============

  constructor(transport: SyncTransport, opts: { deviceId?: string } = {}) {
    this.transport = transport
    this.deviceId = opts.deviceId ?? getOrCreateDeviceId()
    this.deviceName = detectDevice()
    this.bindTransport()
  }

  private bindTransport() {
    // 连接建立 → 发 hello
    this.transport.on('open', () => {
      this.emit('connected', null)
      this.startPing()
      this.transport.send({
        type: 'hello',
        device: this.deviceName,
        deviceId: this.deviceId,
        appVersion: APP_VERSION,
        capabilities: ['session-full', 'session-diff', 'summary-sync'],
      })
    })

    this.transport.on('state', (s) => this.emit('transport-state', s))
    this.startPing()

    // === 消息路由 —— 全部 handler 纯内存操作，绝不 await db ===
    this.transport.on('message', (raw: unknown) => {
      let msg: SyncMessage
      try {
        msg = typeof raw === 'string' ? JSON.parse(raw) : (raw as SyncMessage)
      } catch {
        this.emit('error', '收到的消息 JSON 解析失败')
        return
      }
      switch (msg.type) {
        case 'hello':         this.handleHello(msg); break
        case 'session-full':   this.handleSessionFull(msg); break
        case 'session-diff':   this.handleSessionDiff(msg); break
        case 'summary-list':  void this.handleSummaryList(msg); break // 内部也纯内存
        case 'settings-full': this.handleSettings(msg); break
        case 'persona-full':   this.handlePersona(msg); break
        case 'appearance-full':this.handleAppearance(msg); break
        case 'wallpaper-meta': this.handleWallpaperMeta(msg as SyncWallpaperMeta); break
        case 'wallpaper-chunk':this.handleWallpaperChunk(msg as SyncWallpaperChunk); break
        case 'ping':
          this.transport.send({ type: 'pong', ts: (msg as any).ts })
          break
        case 'pong': {
          const ts = Number((msg as any).ts)
          this.emit('pong', Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null)
          break
        }
        default:
          // ack / error / request-diff — Phase 2 暂不处理
      }
    })
  }

  /** 定期 ping（10 秒）；断线自动停，重连时由 open 重新启动 */
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private startPing() {
    if (this.pingTimer) return
    this.pingTimer = setInterval(() => {
      if (this.transport.isConnected) {
        this.transport.send({ type: 'ping', ts: Date.now() })
      } else {
        if (this.pingTimer) clearInterval(this.pingTimer)
        this.pingTimer = null
      }
    }, 10000)
  }

  // ============ 对外 API ============

  /** 主动推一个 Session 到对端（全量，兜底用） */
  pushSession(sessionId: string) {
    this.sessionsToPush.add(sessionId)
    this.schedulePush()
  }

  /** 推送全部本地 Session（新配对时常用） */
  async pushAll() {
    const summaries = await db.loadSessionSummaries()
    summaries.forEach((s) => this.sessionsToPush.add(s.id))
    this.schedulePush()
  }

  /** 批量推送指定会话（导入历史后调用） */
  pushSessionIds(ids: string[]) {
    if (!this.transport.isConnected) return
    for (const id of ids) this.sessionsToPush.add(id)
    this.schedulePush()
  }

  /** 「推送全部（会话 + 设定）」：带进度上报，UI 用进度条展示 */
  async pushAllWithConfig() {
    if (!this.transport.isConnected) return
    const summaries = await db.loadSessionSummaries()
    const configSteps =
      (this.syncSettings ? 1 : 0) + (this.syncPersona ? 1 : 0) + (this.syncAppearance ? 2 : 0)
    const total = summaries.length + configSteps
    if (total <= 0) return

    this.manualPushIds = new Set(summaries.map((s) => s.id))
    this.manualPushTotal = total
    this.manualPushDone = 0
    this.emit('push-progress', { done: 0, total })

    summaries.forEach((s) => this.sessionsToPush.add(s.id))
    this.schedulePush()

    if (this.syncSettings) { this.sendSettings(); this.bumpManualPush() }
    if (this.syncPersona) { this.sendPersona(); this.bumpManualPush() }
    if (this.syncAppearance) {
      this.sendAppearance()
      this.bumpManualPush()
      void this.sendWallpaper().then(() => this.bumpManualPush())
    }
  }

  /** 推进一格进度；推满后停留一小会儿再隐藏进度条 */
  private bumpManualPush() {
    if (this.manualPushTotal <= 0) return
    this.manualPushDone = Math.min(this.manualPushTotal, this.manualPushDone + 1)
    const done = this.manualPushDone
    const total = this.manualPushTotal
    this.emit('push-progress', { done, total })
    if (done >= total) {
      this.manualPushTotal = 0
      this.manualPushDone = 0
      this.manualPushIds.clear()
      setTimeout(() => this.emit('push-progress', null), 800)
    }
  }

  /** 标记某个 Session 有新 message，下次 flush 时走 diff */
  markSessionDirty(sessionId: string, opts: { added?: Message[]; updated?: Message[] } = {}) {
    const cur = this.sessionsToDiff.get(sessionId) ?? { added: [] as Message[], updated: [] as Message[] }
    if (opts.added) cur.added.push(...opts.added)
    if (opts.updated) cur.updated.push(...opts.updated)
    this.sessionsToDiff.set(sessionId, cur)
    this.schedulePush()
  }

  /**
   * 本机会话落盘后由 store 调用：只把真正新增/改过的 message 推给对端。
   * 生成中的消息先跳过，等收尾（status 不再是 pending/streaming）时整条推一次。
   */
  notifyLocalChange(session: Session) {
    if (!this.transport.isConnected) return
    const generating = session.messages.some(
      (m) => m.role === 'assistant' && ((m as any).status === 'pending' || (m as any).status === 'streaming')
    )
    if (generating) return

    const known = this.sentSignatures.get(session.id)
    const added: Message[] = []
    const updated: Message[] = []
    for (const m of session.messages) {
      const sig = messageSignature(m)
      if (!known || !known.has(m.id)) added.push(m)
      else if (known.get(m.id) !== sig) updated.push(m)
    }
    if (added.length === 0 && updated.length === 0) {
      // 消息没变但压缩 memory 变了（自动压缩 / 手动总结）：推一条只带元数据的 diff，把压缩结果同步过去
      if (this.sentSignatures.has(session.id) && this.sentMemorySig.get(session.id) !== memorySig(session)) {
        if (!this.sessionsToDiff.has(session.id)) this.sessionsToDiff.set(session.id, { added: [], updated: [] })
        this.schedulePush()
      }
      return
    }

    const cur = this.sessionsToDiff.get(session.id) ?? { added: [] as Message[], updated: [] as Message[] }
    const merge = (list: Message[], next: Message[]) => {
      const map = new Map(list.map((m) => [m.id, m]))
      for (const m of next) map.set(m.id, m)
      return [...map.values()]
    }
    this.sessionsToDiff.set(session.id, {
      added: merge(cur.added, added),
      updated: merge(cur.updated, updated),
    })
    this.schedulePush()
  }

  /** 记录已经同步出去的消息指纹，避免重复推送 */
  private rememberSent(sessionId: string, messages: Message[]) {
    let known = this.sentSignatures.get(sessionId)
    if (!known) { known = new Map(); this.sentSignatures.set(sessionId, known) }
    for (const m of messages) known.set(m.id, messageSignature(m))
  }

  // ================================================================
  //  接收路径 —— 全部纯内存操作 + 塞 ioQueue，零 IO 零 await
  // ================================================================

  /** 握手：记下对方 capabilities，然后 fire-and-forget 发 summary-list */
  private handleHello(msg: { device: string; deviceId: string; capabilities?: string[] }) {
    const caps = new Set(msg.capabilities ?? [])
    this.peerCaps = caps
    this.emit('peer-hello', msg)

    // 先发 summary-list 协商同步方向，再发 config（让对方先收到 summary 再收到设置）
    if (caps.has('summary-sync')) {
      void this.sendSummaryList()
    }
    void this.sendAllConfig()
  }

  /** 收到对方的全量 Session —— 塞 ioQueue */
  private handleSessionFull(msg: SyncSessionMsg) {
    const incoming = msg.session as Session
    if (!incoming?.id) return
    this.ioQueue.push({ kind: 'session-full', session: incoming })
    this.scheduleIoFlush()
  }

  /** 收到对方的增量 diff —— 内存合并 messages → 塞 ioQueue */
  private handleSessionDiff(msg: SyncDiff) {
    const messageMap = new Map<string, Message>()
    for (const m of (msg.addedMessages ?? []) as Message[]) messageMap.set(m.id, m)
    for (const m of (msg.updatedMessages ?? []) as Message[]) messageMap.set(m.id, m)

    const applied: Session = {
      id: msg.sessionId,
      title: (msg.updatedSession as Partial<Session> | undefined)?.title ?? '(来自同步)',
      createdAt: Date.now(),
      updatedAt: msg.updatedAt,
      messages: [...messageMap.values()],
      rootMessageId: (msg.updatedSession as any)?.rootMessageId ?? null,
      memory: (msg.updatedSession as any)?.memory,
    }
    this.ioQueue.push({ kind: 'session-diff', sessionId: msg.sessionId, applied })
    this.scheduleIoFlush()
  }

  /** 收到对方的 summary-list —— 纯内存对比，决定推哪些给对方
   *
   *  注意：这个方法仍然是 async 因为要 await db.loadSessionSummaries() 拿本机列表。
   *  但它在 message 回调里被 void 掉（fire-and-forget），所以 await 不会阻塞事件循环。
   *  内部的 pushSessionDiffForNew 已经不再 await，而是把 id 加到 Set 里让 flushPush 串行处理。
   */
  private async handleSummaryList(msg: SyncSummaryList) {
    const local = await db.loadSessionSummaries()
    const remoteMap = new Map(msg.summaries.map((s) => [s.id, s.updatedAt]))

    for (const l of local) {
      const r = remoteMap.get(l.id)
      if (!r) {
        // 对方没有 → 推 diff（对方没有整个 session，走 diff-new）
        this.sessionsToDiffNew.add(l.id)
      } else if (l.updatedAt > r) {
        // 对方版本旧 → 走 diff 还是 full 看对方 capabilities
        if (this.peerCaps.has('session-diff')) {
          this.sessionsToPush.add(l.id) // flushPush 里会判断是 diff 还是 full
        } else {
          this.sessionsToPush.add(l.id)
        }
      }
      // 对方版本更新或相等 → 跳过（对端会推过来）
    }
    this.schedulePush()
  }

  /** 设置同步 —— 塞 ioQueue */
  private handleSettings(msg: SyncSettings) {
    this.ioQueue.push({
      kind: 'settings',
      settings: msg.settings,
      meta: msg.meta,
      includeApiKey: msg.includeApiKey ?? false,
    })
    this.scheduleIoFlush()
  }

  /** Persona 同步 —— 塞 ioQueue */
  private handlePersona(msg: SyncPersona) {
    this.ioQueue.push({ kind: 'persona', persona: msg.persona, updatedAt: msg.updatedAt })
    this.scheduleIoFlush()
  }

  /** Appearance 同步 —— 塞 ioQueue */
  private handleAppearance(msg: SyncAppearance) {
    const { userAvatar, bubbleColor, aiBubbleColor } = msg.appearance
    this.ioQueue.push({
      kind: 'appearance',
      avatar: userAvatar,
      bubble: bubbleColor,
      aiBubble: aiBubbleColor,
    })
    this.scheduleIoFlush()
  }

  /** 背景图元信息：本机图更新就直接不收分块；否则开一个接收槽 */
  private handleWallpaperMeta(msg: SyncWallpaperMeta) {
    if (!this.syncAppearance) return
    if (msg.updatedAt > 0 && msg.updatedAt <= wallpaperUpdatedAt()) return
    if (msg.total <= 0 || msg.total > 200) return
    this.pendingWallpapers.set(msg.id, {
      mime: msg.mime,
      total: msg.total,
      updatedAt: msg.updatedAt,
      parts: new Array<string | null>(msg.total).fill(null),
      got: 0,
    })
  }

  /** 背景图分块：纯内存拼接，齐了转 Blob 塞 ioQueue */
  private handleWallpaperChunk(msg: SyncWallpaperChunk) {
    const p = this.pendingWallpapers.get(msg.id)
    if (!p || msg.seq < 0 || msg.seq >= p.total || p.parts[msg.seq] !== null) return
    p.parts[msg.seq] = msg.data
    p.got += 1
    if (p.got < p.total) return
    this.pendingWallpapers.delete(msg.id)
    this.ioQueue.push({ kind: 'wallpaper', blob: base64ToBlob(p.parts.join(''), p.mime), updatedAt: p.updatedAt })
    this.scheduleIoFlush()
  }

  // ================================================================
  //  IO 串行刷新（IndexedDB + localStorage）
  // ================================================================

  private scheduleIoFlush() {
    if (this.ioFlushing) return
    this.ioFlushing = true
    const run = () => { void this.flushIoQueue() }
    const ric = (globalThis as any).requestIdleCallback
    if (typeof ric === 'function') {
      ric(run, { timeout: 2000 })
    } else {
      setTimeout(run, 50)
    }
  }

  private async flushIoQueue() {
    // 拷贝出来逐串行处理，避免 handleXxx 在 flush 期间 push 导致 while 无限循环
    // （我们希望 flush 完当前队列再 flush 新的，requestIdleCallback 会在下一帧再触发）
    const batch = this.ioQueue.splice(0, this.ioQueue.length)
    for (const op of batch) {
      try {
        await this.executeIoOp(op)
      } catch (e) {
        this.emit('error', `写入失败: ${(e as Error).message}`)
      }
    }
    // 如果 flush 期间有新的 push，立即触发下一轮 flush（不重复 scheduleIoFlush）
    if (this.ioQueue.length > 0) {
      this.ioFlushing = false
      this.scheduleIoFlush()
    } else {
      this.ioFlushing = false
    }
  }

  private async executeIoOp(op: PendingWrite): Promise<void> {
    switch (op.kind) {
      case 'session-full': {
        // 先记指纹再合并：合并会同步触发 store 的 persist → notifyLocalChange，
        // 若此时还没记住这些消息，它们会被当成「本机新消息」回推给发送方
        this.rememberSent(op.session.id, op.session.messages)
        this.sentMemorySig.set(op.session.id, memorySig(op.session))
        // 首选：交给聊天 store 合并（store 是会话唯一写入者，避免旧内存覆盖同步结果）
        const merged = await notifyRemoteSessionMerge(op.session)
        if (merged) {
          this.cachedUpdatedAt.set(op.session.id, op.session.updatedAt ?? Date.now())
          this.emit('session-written', { sessionId: op.session.id, isNew: merged.isNew, added: merged.added })
          notifyRemoteSessionsChanged()
          break
        }
        // 兜底：store 钩子没注册（理论上不会发生）才由引擎直接写库
        const local = await db.loadSession(op.session.id)
        if (!local) {
          await db.saveSession(op.session)
          this.cachedUpdatedAt.set(op.session.id, op.session.updatedAt ?? Date.now())
          this.rememberSent(op.session.id, op.session.messages)
          this.emit('session-written', { sessionId: op.session.id, isNew: true })
          notifyRemoteSessionsChanged()
          break
        }
        // 关键：整条会话也是「合并」而不是覆盖 —— 两边各自新增的消息都保留
        const messageMap = new Map(local.messages.map((m) => [m.id, m]))
        for (const m of op.session.messages) messageMap.set(m.id, m)
        const mergedSession: Session = { ...local, messages: [...messageMap.values()] }
        if ((op.session.updatedAt ?? 0) > (local.updatedAt ?? 0)) {
          if (op.session.title !== undefined) mergedSession.title = op.session.title
          mergedSession.updatedAt = op.session.updatedAt ?? mergedSession.updatedAt
          if (op.session.rootMessageId !== undefined) mergedSession.rootMessageId = op.session.rootMessageId
          if (op.session.memory !== undefined) mergedSession.memory = op.session.memory
        }
        await db.saveSession(mergedSession)
        this.cachedUpdatedAt.set(mergedSession.id, mergedSession.updatedAt ?? Date.now())
        this.rememberSent(mergedSession.id, op.session.messages)
        this.emit('session-written', { sessionId: mergedSession.id, isNew: false })
        notifyRemoteSessionsChanged()
        break
      }
      case 'session-diff': {
        // 先记指纹再合并（同 session-full，防止刚收到的消息被回推）
        this.rememberSent(op.sessionId, op.applied.messages)
        if (op.applied.memory !== undefined) this.sentMemorySig.set(op.sessionId, memorySig(op.applied))
        const merged = await notifyRemoteSessionMerge(op.applied)
        if (merged) {
          this.cachedUpdatedAt.set(op.sessionId, op.applied.updatedAt ?? Date.now())
          this.emit('session-diff-applied', {
            sessionId: op.sessionId,
            isNew: merged.isNew,
            added: merged.added,
          })
          notifyRemoteSessionsChanged()
          break
        }
        // 兜底：引擎直接读库合并写库
        const local = await db.loadSession(op.sessionId)
        if (local) {
          // 合并：对方 messages 覆盖本机同 id 的，本机独有消息保留
          const incomingMap = new Map(op.applied.messages.map((m) => [m.id, m]))
          const localMap = new Map(local.messages.map((m) => [m.id, m]))
          for (const [id, m] of incomingMap) localMap.set(id, m)
          local.messages = [...localMap.values()]
          if (op.applied.title !== undefined) local.title = op.applied.title
          if (op.applied.updatedAt !== undefined) local.updatedAt = op.applied.updatedAt
          if (op.applied.rootMessageId !== undefined) local.rootMessageId = op.applied.rootMessageId
          if (op.applied.memory !== undefined) local.memory = op.applied.memory
          await db.saveSession(local)
          this.cachedUpdatedAt.set(local.id, local.updatedAt ?? Date.now())
          this.rememberSent(local.id, op.applied.messages)
          this.emit('session-diff-applied', { sessionId: local.id, isNew: false, added: op.applied.messages.length })
        } else {
          // 本机没有 → 直接存对方版本
          await db.saveSession(op.applied)
          this.cachedUpdatedAt.set(op.applied.id, op.applied.updatedAt ?? Date.now())
          this.rememberSent(op.applied.id, op.applied.messages)
          this.emit('session-diff-applied', { sessionId: op.applied.id, isNew: true, added: op.applied.messages.length })
        }
        notifyRemoteSessionsChanged()
        break
      }
      case 'settings': {
        if (!this.syncSettings) { this.emit('settings-received-skipped', null); return }
        const entries: Record<string, string | null> = {}
        for (const [key, value] of Object.entries(op.settings)) {
          if (key === 'chat-demo:api-key' && !op.includeApiKey) continue
          entries[key] = value
        }
        // 按项比较最后修改时间，只接收对方更新的项；不会整包覆盖本机设置
        const applied = applySyncedSettings(entries, op.meta)
        // 壁纸预设只在启动时读一次，这里同步后立即重读应用
        if (op.settings['chat-demo:wallpaper'] !== undefined) void refreshWallpaperFromStorage()
        if (applied > 0) this.emit('settings-applied', { keys: applied, from: 'remote' })
        else this.emit('skipped', { sessionId: 'settings', reason: '本机设置更新' })
        break
      }
      case 'persona': {
        if (!this.syncPersona) { this.emit('persona-received-skipped', null); return }
        try {
          // 合并而不是覆盖：本机独有的角色卡保留，对方新增的卡并进来
          mergePersonaState(op.persona, op.updatedAt || Date.now())
          this.emit('persona-applied', { from: 'remote' })
        } catch {
          this.emit('error', '写入 Persona 失败')
        }
        break
      }
      case 'appearance': {
        if (!this.syncAppearance) { this.emit('appearance-received-skipped', null); return }
        const { avatar, bubble, aiBubble } = op
        try {
          // 合并式：只补齐本机没有的项，不覆盖本机已设置的头像/气泡
          if (avatar !== null && !localStorage.getItem('chat-demo:user-avatar')) {
            localStorage.setItem('chat-demo:user-avatar', avatar)
          }
          if (bubble !== null && !localStorage.getItem('chat-demo:user-bubble')) {
            localStorage.setItem('chat-demo:user-bubble', bubble)
          }
          if (aiBubble !== null && !localStorage.getItem('chat-demo:ai-bubble')) {
            localStorage.setItem('chat-demo:ai-bubble', aiBubble)
          }
          this.emit('appearance-applied', { from: 'remote' })
        } catch {
          this.emit('error', '写入 Appearance 失败')
        }
        break
      }
      case 'wallpaper': {
        if (!this.syncAppearance) { this.emit('skipped', { sessionId: 'wallpaper', reason: '外观同步已关闭' }); break }
        if (op.updatedAt > 0 && op.updatedAt <= wallpaperUpdatedAt()) {
          this.emit('skipped', { sessionId: 'wallpaper', reason: '本机背景更新' })
          break
        }
        try {
          await applySyncedWallpaper(op.blob)
          this.emit('appearance-applied', { from: 'remote', wallpaper: true })
        } catch {
          this.emit('error', '写入背景图失败')
        }
        break
      }
    }
  }

  // ================================================================
  //  发送路径 —— 主动推给对方（flushPush 在 debounced setTimeout 里执行，
  //  所以里面的 await db.loadSession 不会阻塞 WebRTC 回调）
  // ================================================================

  private schedulePush() {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.flushPush()
    }, 300) // debounce 300ms
  }

  private async flushPush() {
    if (!this.transport.isConnected) {
      // 推送到一半断线：进度条不能卡在「推送中」
      if (this.manualPushTotal > 0) {
        this.manualPushTotal = 0
        this.manualPushDone = 0
        this.manualPushIds.clear()
        this.emit('push-progress', null)
      }
      return
    }

    // 1️⃣ summary-list 协商出的 diff-new（对方没有整个 session → 发全量 messages 当 diff）
    const diffNewIds = [...this.sessionsToDiffNew]
    this.sessionsToDiffNew.clear()
    for (const id of diffNewIds) {
      try {
        await this.pushSessionDiffForNew(id)
      } catch (e) {
        this.emit('error', `推送 diff-new ${id} 失败: ${(e as Error).message}`)
      }
    }

    // 2️⃣ markSessionDirty 标记的实时 diff（连接期间的新/改 message）
    const diffEntries = [...this.sessionsToDiff.entries()]
    this.sessionsToDiff.clear()
    for (const [sessionId, diff] of diffEntries) {
      try {
        const baseSession = await db.loadSession(sessionId)
        if (!baseSession) continue
        const meta = {
          id: sessionId,
          title: baseSession.title,
          updatedAt: baseSession.updatedAt,
          rootMessageId: baseSession.rootMessageId ?? null,
          memory: baseSession.memory,
        }
        // 消息太多时拆成多段发，避免超过 DataChannel 单条上限被静默丢弃
        const chunks = chunkMessages([...diff.added, ...diff.updated])
        if (chunks.length === 0) {
          // 只带元数据的一条 diff：同步压缩 memory，不带消息
          this.transport.send({
            type: 'session-diff',
            sessionId,
            addedMessages: [],
            updatedMessages: [],
            removedMessageIds: [],
            updatedSession: meta,
            fromDevice: this.deviceName,
            updatedAt: baseSession.updatedAt ?? Date.now(),
          })
        }
        let sent = 0
        for (const chunk of chunks) {
          const diffMsg: SyncDiff = {
            type: 'session-diff',
            sessionId,
            addedMessages: chunk,
            updatedMessages: [],
            removedMessageIds: [],
            updatedSession: meta,
            fromDevice: this.deviceName,
            updatedAt: baseSession.updatedAt ?? Date.now(),
          }
          if (!this.transport.send(diffMsg)) {
            this.emit('error', `推送会话 ${sessionId} 分段失败（数据过大）`)
            break
          }
          sent += chunk.length
          this.rememberSent(sessionId, chunk)
        }
        this.emit('session-sent-diff', {
          sessionId,
          added: sent,
          updated: diff.updated.length,
        })
        this.cachedUpdatedAt.set(sessionId, baseSession.updatedAt ?? Date.now())
        this.sentMemorySig.set(sessionId, memorySig(baseSession))
      } catch (e) {
        this.emit('error', `推送实时 diff ${sessionId} 失败: ${(e as Error).message}`)
      }
    }

    // 3️⃣ full 兜底
    const ids = [...this.sessionsToPush]
    this.sessionsToPush.clear()
    for (const id of ids) {
      try {
        await this.pushSessionFull(id)
      } catch (e) {
        this.emit('error', `推送 full ${id} 失败: ${(e as Error).message}`)
      }
      // 手动「推送全部」时，每处理完一个会话推进一格
      if (this.manualPushIds.delete(id)) this.bumpManualPush()
    }
  }

  /** 推全量 session-full（兜底）；超过单条上限时自动拆成多段 diff */
  private async pushSessionFull(sessionId: string) {
    const session = await db.loadSession(sessionId)
    if (!session) return
    const msg: SyncSessionMsg = {
      type: 'session-full',
      sessionId,
      session,
      updatedAt: session.updatedAt ?? Date.now(),
      fromDevice: this.deviceName,
    }
    let bytes = 0
    try {
      bytes = new TextEncoder().encode(JSON.stringify(session)).length
    } catch {}
    if (bytes > SESSION_FULL_MAX_BYTES) {
      this.sendSessionAsDiffs(session)
      return
    }
    if (!this.transport.send(msg)) {
      // 发送失败（大概率是数据过大），退回分段 diff
      this.sendSessionAsDiffs(session)
      return
    }
    this.rememberSent(sessionId, session.messages)
    this.sentMemorySig.set(sessionId, memorySig(session))
    this.emit('session-sent', sessionId)
    this.cachedUpdatedAt.set(sessionId, session.updatedAt ?? Date.now())
  }

  /** 推新 Session 的 diff 版本（整个 messages 数组都是 added，自动分段） */
  private async pushSessionDiffForNew(sessionId: string) {
    const session = await db.loadSession(sessionId)
    if (!session) return
    this.sendSessionAsDiffs(session)
  }

  /** 把整条会话按 DataChannel 可承受的段大小拆开发送 */
  private sendSessionAsDiffs(session: Session) {
    const meta = {
      id: session.id,
      title: session.title,
      updatedAt: session.updatedAt,
      rootMessageId: session.rootMessageId ?? null,
      memory: session.memory,
    }
    const chunks = chunkMessages(session.messages)
    let sent = 0
    for (const chunk of chunks) {
      const diff: SyncDiff = {
        type: 'session-diff',
        sessionId: session.id,
        addedMessages: chunk,
        updatedMessages: [],
        removedMessageIds: [],
        updatedSession: meta,
        fromDevice: this.deviceName,
        updatedAt: session.updatedAt ?? Date.now(),
      }
      if (!this.transport.send(diff)) {
        this.emit('error', `会话 ${session.id} 分段发送失败（数据过大）`)
        break
      }
      sent += chunk.length
      this.rememberSent(session.id, chunk)
    }
    this.emit('session-sent-diff', { sessionId: session.id, added: sent })
    this.cachedUpdatedAt.set(session.id, session.updatedAt ?? Date.now())
    this.sentMemorySig.set(session.id, memorySig(session))
  }

  // ================================================================
  //  Config 同步（settings / persona / appearance）
  // ================================================================

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

  /** 一次性发完所有非 Session 配置（握手后立即发） */
  async sendAllConfig() {
    if (!this.transport.isConnected) return
    // 轻微串行：先发 settings，再 persona，再 appearance
    // 但都是 sync 读 localStorage + send，不会阻塞
    if (this.syncSettings) this.sendSettings()
    if (this.syncPersona) this.sendPersona()
    if (this.syncAppearance) {
      this.sendAppearance()
      void this.sendWallpaper()
    }
  }

  /** 设置同步：除 API Key 外，localStorage 里所有配置项都同步 */
  sendSettings() {
    const settings = collectSyncedSettings(this.syncApiKey)
    const msg: SyncSettings = {
      type: 'settings-full',
      settings,
      meta: settingsSyncMeta(),
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
      // 用本机真实修改时间，而不是发送时间——对方才能判断谁更新
      updatedAt: personaUpdatedAt() || Date.now(),
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

  /** 自定义聊天背景图：blob 转 base64 分块发送（图在 IndexedDB，localStorage 通道带不动） */
  async sendWallpaper() {
    if (!this.transport.isConnected) return
    let preset = 'none'
    try { preset = localStorage.getItem('chat-demo:wallpaper') || 'none' } catch {}
    if (preset !== 'custom') return
    const blob = await readWallpaperBlob()
    if (!blob) return
    const data = await blobToBase64(blob)
    const total = Math.ceil(data.length / WALLPAPER_CHUNK_B64)
    const id = `${this.deviceId}:${blob.size}`
    const meta: SyncWallpaperMeta = {
      type: 'wallpaper-meta',
      id,
      mime: blob.type || 'image/jpeg',
      total,
      bytes: data.length,
      updatedAt: wallpaperUpdatedAt(),
      fromDevice: this.deviceName,
    }
    if (!this.transport.send(meta)) { this.emit('error', '背景元信息发送失败'); return }
    for (let seq = 0; seq < total; seq++) {
      const chunk: SyncWallpaperChunk = {
        type: 'wallpaper-chunk',
        id,
        seq,
        data: data.slice(seq * WALLPAPER_CHUNK_B64, (seq + 1) * WALLPAPER_CHUNK_B64),
      }
      if (!this.transport.send(chunk)) {
        this.emit('error', `背景图分块 ${seq + 1}/${total} 发送失败`)
        return
      }
    }
    this.emit('appearance-sent', { wallpaper: true })
  }
}

// ============ 常量 ============

/** DataChannel 单条消息的保守上限（字节）；超过就拆成多段 */
const MESSAGE_CHUNK_BYTES = 60_000
const SESSION_FULL_MAX_BYTES = 60_000

/** 按 UTF-8 字节数把消息切成多段，避免单条超过 DataChannel 上限被丢弃 */
function chunkMessages(messages: Message[]): Message[][] {
  if (messages.length === 0) return []
  const encoder = new TextEncoder()
  const chunks: Message[][] = []
  let current: Message[] = []
  let size = 0
  for (const message of messages) {
    let bytes = 0
    try {
      bytes = encoder.encode(JSON.stringify(message)).length
    } catch {
      bytes = 1024
    }
    if (current.length > 0 && size + bytes > MESSAGE_CHUNK_BYTES) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(message)
    size += bytes
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** 消息内容指纹（比对象引用可靠，能发现流式结束后内容变化） */
function messageSignature(message: Message): string {
  try {
    return JSON.stringify(message)
  } catch {
    return message.id
  }
}

/** 会话压缩 memory 的指纹：messages 没变但压缩结果变了也要同步 */
function memorySig(session: Session): string {
  try {
    return JSON.stringify(session.memory ?? null)
  } catch {
    return ''
  }
}

/** 背景图分块的 base64 长度：单条约 64KB，控制在 DataChannel 上限内 */
const WALLPAPER_CHUNK_B64 = 48_000

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const step = 8192
  for (let i = 0; i < buf.length; i += step) {
    binary += String.fromCharCode(...buf.subarray(i, i + step))
  }
  return btoa(binary)
}

function base64ToBlob(b64: string, mime: string): Blob {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * 同步时排除的 localStorage key：
 * - API Key 走单独开关
 * - Persona / 外观有专门的协议通道
 * - 设备身份、同步面板自身开关、时间戳元数据不跨设备复制
 */
const SETTINGS_EXCLUDE = new Set([
  'chat-demo:api-key',
  'chat-demo:sync-meta',
  'ds-lite:persona',
  'ds-lite:persona-updatedAt',
  'chat-demo:user-avatar',
  'chat-demo:user-bubble',
  'chat-demo:ai-bubble',
  'ds-lite.sync.deviceId',
  'ds-sync-code',
  WALLPAPER_TS_KEY,
])

/** 收集要同步的 localStorage 项：默认全量，只排除上面这些特殊 key */
function collectSyncedSettings(includeApiKey: boolean): Record<string, string | null> {
  const settings: Record<string, string | null> = {}
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (!key) continue
      // 同步面板自己的开关按设备保留，不跨设备改
      if (key.startsWith('ds-sync:')) continue
      if (SETTINGS_EXCLUDE.has(key) && !(key === 'chat-demo:api-key' && includeApiKey)) continue
      settings[key] = localStorage.getItem(key)
    }
  } catch {}
  return settings
}

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
