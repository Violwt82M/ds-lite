import { create } from 'zustand'

/** 同步面板开关：侧边栏底部按钮、后续可能的更多入口都可以打开 */
export const useSyncPanel = create(() => ({
  open: false,
}))

export const openSyncPanel = () => useSyncPanel.setState({ open: true })
export const closeSyncPanel = () => useSyncPanel.setState({ open: false })
