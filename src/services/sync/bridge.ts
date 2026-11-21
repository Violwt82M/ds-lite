/**
 * 同步与聊天 store 之间的桥。
 *
 * 单独放一个零依赖模块，避免 store → sync client → store 的循环 import：
 *   store 只调 notifyLocalSessionSaved()
 *   sync client 只注册 hooks
 */
import type { Session } from '../chat/types.js'

type Hooks = {
  /** 本机会话落盘后通知同步引擎 */
  onLocalSessionSaved?: (session: Session) => void
  /** 本机批量导入 / 替换历史后通知同步引擎（导入不走 persist） */
  onLocalSessionsReplaced?: (sessionIds: string[]) => void
  /** 对端数据写进本机库后，通知界面重新读取 */
  onRemoteSessionsChanged?: () => void
  /**
   * 对端会话进来后交给聊天 store 合并（store 是会话的唯一写入者）。
   * 引擎直接写库 + store 旧内存再落盘会互相覆盖，丢消息的根因就在这。
   */
  onRemoteSessionMerge?: (session: Session) => Promise<{ isNew: boolean; added: number }>
}

const hooks: Hooks = {}

export const setSyncHooks = (next: Hooks) => {
  hooks.onLocalSessionSaved = next.onLocalSessionSaved
  hooks.onLocalSessionsReplaced = next.onLocalSessionsReplaced
  hooks.onRemoteSessionsChanged = next.onRemoteSessionsChanged
  hooks.onRemoteSessionMerge = next.onRemoteSessionMerge
}

export const notifyLocalSessionSaved = (session: Session) => {
  hooks.onLocalSessionSaved?.(session)
}

export const notifyLocalSessionsReplaced = (sessionIds: string[]) => {
  hooks.onLocalSessionsReplaced?.(sessionIds)
}

export const notifyRemoteSessionsChanged = () => {
  hooks.onRemoteSessionsChanged?.()
}

/** 没注册钩子时返回 null，调用方退回直接写库的旧路径 */
export const notifyRemoteSessionMerge = (
  session: Session
): Promise<{ isNew: boolean; added: number }> | null => hooks.onRemoteSessionMerge?.(session) ?? null
