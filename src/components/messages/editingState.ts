import { create } from 'zustand'

/**
 * 记录当前正在行内编辑的历史消息集合（用户消息 / AI 回复共用）。
 * 编辑任意历史消息时，会话页自动隐藏底部 ChatInput，腾出完整空间避免软键盘+底部框双重遮挡。
 */
type EditingState = {
  ids: Record<string, true>
}

export const useMessageEditing = create<EditingState>(() => ({ ids: {} }))

export const startMessageEditing = (id: string) => {
  useMessageEditing.setState((state) =>
    state.ids[id] ? state : { ids: { ...state.ids, [id]: true } }
  )
}

export const stopMessageEditing = (id: string) => {
  useMessageEditing.setState((state) => {
    if (!state.ids[id]) {
      return state
    }
    return {
      ids: Object.fromEntries(Object.entries(state.ids).filter(([key]) => key !== id)) as Record<
        string,
        true
      >,
    }
  })
}

export const clearAllMessageEditing = () => {
  useMessageEditing.setState({ ids: {} })
}

export const useHasEditingMessage = () =>
  useMessageEditing((state) => Object.keys(state.ids).length > 0)
