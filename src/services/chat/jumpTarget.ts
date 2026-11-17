import { create } from 'zustand'

/**
 * 从搜索结果跳到某条消息：搜索在侧边栏里，消息列表在另一个组件里，
 * 用一个一次性的目标把它们连起来——MessageList 渲染出这条消息后滚动并清空。
 */
type JumpTarget = { sessionId: string; messageId: string } | null

export const useJumpTarget = create<{ target: JumpTarget }>(() => ({ target: null }))

export const requestJump = (sessionId: string, messageId: string) =>
  useJumpTarget.setState({ target: { sessionId, messageId } })

export const clearJump = () => useJumpTarget.setState({ target: null })
