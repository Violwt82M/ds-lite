/**
 * Session 级全量同步引擎
 *
 * Phase 1：收到对方的 session-full → 如果对方 updatedAt 更新 → 写入本机 IndexedDB
 * Phase 1：本机调用 pushSessionToPeer → 把指定 Session 推给对方
 *
 * 不涉及 Zustand store 的 import（避免循环依赖）——用 db 层直接读写。
 */

import * as db from '../chat/db.js'
import type { Session } from '../chat/types.js'
import type { SyncTransport } from './transport.js'
import type { SyncMessage, SyncSession as SyncSessionMsg } from './protocol.js'
import { detectDevice } from './transport.js'

export class SyncEngine extends EventTarget {
  private transport: SyncTransport
  private deviceId: string
  private sessionsToPush = new Set<string>()
  private pushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(transport: SyncTransport, opts: { deviceId?: string } = {}) {
    super()
    this.transport = transport
    this.deviceId = opts.deviceId ?? getOrCreateDeviceId()
    this.bindTransport()
  }

  /** 主动推一个 Session 到对端（如果当前 connected） */
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

  /** 收到对方的全量 Session → 判断要不要写入本机 */
  private async handleSessionFull(msg: SyncSessionMsg) {
    const incoming = msg.session as Session
    if (!incoming || !incoming.id) {
      this.emit('error', '收到的 Session 缺少 id')
      return
    }

    // 从 IndexedDB 读本机同 id 的版本
    const local = await db.loadSession(incoming.id)

    if (local) {
      // 存在 → 谁 updatedAt 更新谁赢
      const localUpdated = local.updatedAt ?? 0
      const remoteUpdated = incoming.updatedAt ?? 0
      if (remoteUpdated <= localUpdated) {
        this.emit('skipped', { sessionId: incoming.id, reason: '本机版本更新或相等' })
        return
      }
    }

    // 覆盖式写入（Phase 1 简化：不做消息级 diff）
    try {
      await db.saveSession(incoming)
      this.emit('session-written', { sessionId: incoming.id, isNew: !local })
    } catch (e) {
      this.emit('error', `写入 Session ${incoming.id} 失败: ${(e as Error).message}`)
    }
  }

  private bindTransport() {
    this.transport.on('message', (raw) => {
      const msg = raw as SyncMessage
      if (!msg || typeof msg !== 'object' || !('type' in msg)) return

      switch (msg.type) {
        case 'hello': {
          this.emit('peer-hello', msg)
          // 自动回复我们自己的 hello
          this.transport.send({
            type: 'hello',
            device: detectDevice(),
            deviceId: this.deviceId,
            appVersion: APP_VERSION,
            capabilities: ['session-full'],
          })
          break
        }
        case 'session-full': {
          void this.handleSessionFull(msg)
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
        default:
          break
      }
    })

    this.transport.on('open', () => {
      this.emit('connected', null)
      // 发送 hello
      this.transport.send({
        type: 'hello',
        device: detectDevice(),
        deviceId: this.deviceId,
        appVersion: APP_VERSION,
        capabilities: ['session-full'],
      })
    })

    this.transport.on('state', (s) => this.emit('transport-state', s))

    // 定期 ping（每 10 秒）
    const pingTimer = setInterval(() => {
      if (this.transport.isConnected) {
        this.transport.send({ type: 'ping', ts: Date.now() })
      } else {
        clearInterval(pingTimer)
      }
    }, 10000)
  }

  private schedulePush() {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      void this.flushPush()
    }, 300) // debounce
  }

  private async flushPush() {
    if (!this.transport.isConnected) return
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
        fromDevice: detectDevice(),
      }
      this.transport.send(msg)
      this.emit('session-sent', id)
    }
  }
}

// --- 设备 ID 持久化（每台设备一个稳定 ID） ---

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

// 从 version.ts 读版本号
import { APP_VERSION } from '../../version.js'
