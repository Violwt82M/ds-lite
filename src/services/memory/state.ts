import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'

/** 记忆面板的界面状态：开关、正在整理、上一次失败原因。数据本身存在会话里。 */
/** 自动整理完成后的一次性提示：让用户知道"刚才它做过什么" */
type MemoryNotice = { rounds: number; at: number }

type MemoryPanelState = {
  open: boolean
  /** 正在整理记忆的会话 id */
  compacting: Record<string, boolean>
  errors: Record<string, TranslationMessage | undefined>
  notices: Record<string, MemoryNotice | undefined>
}

export const useMemoryPanel = create<MemoryPanelState>(() => ({
  open: false,
  compacting: {},
  errors: {},
  notices: {},
}))

export const setMemoryNotice = (sessionId: string, rounds: number) =>
  useMemoryPanel.setState((state) => ({
    notices: { ...state.notices, [sessionId]: { rounds, at: Date.now() } },
  }))

export const clearMemoryNotice = (sessionId: string) =>
  useMemoryPanel.setState((state) => ({
    notices: { ...state.notices, [sessionId]: undefined },
  }))

export const openMemoryPanel = () => useMemoryPanel.setState({ open: true })

export const closeMemoryPanel = () => useMemoryPanel.setState({ open: false })

export const setCompacting = (sessionId: string, compacting: boolean) =>
  useMemoryPanel.setState((state) => ({
    compacting: { ...state.compacting, [sessionId]: compacting },
    ...(compacting ? { errors: { ...state.errors, [sessionId]: undefined } } : {}),
  }))

export const setMemoryError = (sessionId: string, error: TranslationMessage | undefined) =>
  useMemoryPanel.setState((state) => ({ errors: { ...state.errors, [sessionId]: error } }))
