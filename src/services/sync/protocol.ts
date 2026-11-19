/**
 * 同步消息协议 —— DataChannel 上传输的所有 JSON 消息类型定义
 *
 * Phase 1 只做 Level 1：Session 级全量同步 + 双向心跳
 * Phase 2 扩展 Level 2：消息级 diff + 分支合并
 */

export type SyncMessage =
  | SyncPing
  | SyncPong
  | SyncHello
  | SyncSession
  | SyncRequestDiff
  | SyncDiff
  | SyncAck
  | SyncError

/** 心跳 */
export interface SyncPing { type: 'ping'; ts: number }
export interface SyncPong { type: 'pong'; ts: number; rtt?: number }

/** 握手 —— 双方交换设备信息 */
export interface SyncHello {
  type: 'hello'
  device: string
  deviceId: string          // crypto.randomUUID() 生成的稳定设备 ID
  appVersion: string
  capabilities: string[]    // ['session-full', 'session-diff', 'file-blob']
}

/** 全量推送一个 Session */
export interface SyncSession {
  type: 'session-full'
  sessionId: string
  session: unknown          // Session 对象（import * as SessionType 避免循环依赖）
  updatedAt: number
  fromDevice: string
}

/** 请求对方发 diff 来（可选） */
export interface SyncRequestDiff {
  type: 'request-diff'
  sinceAt: number            // 我上次同步的时间戳
  sessionIds: string[]       // 可选：只关心这些会话
}

/** 增量 diff（Phase 2） */
export interface SyncDiff {
  type: 'session-diff'
  sessionId: string
  addedMessages?: unknown[]
  updatedMessages?: unknown[]
  removedMessageIds?: string[]
  updatedSession?: unknown
  fromDevice: string
  updatedAt: number
}

/** 收到确认 */
export interface SyncAck { type: 'ack'; messageId?: string; at: number }

export interface SyncError {
  type: 'error'
  code: string
  message: string
}
