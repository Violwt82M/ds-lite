import { create } from 'zustand'

/** 引导文案版本：文案有实质变化时递增，老用户会再看一次 */
const GUIDE_VERSION = '1'
const STORAGE_KEY = 'ds-lite:context-guide'

const readSeen = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === GUIDE_VERSION
  } catch {
    return false
  }
}

/** 第一次填完 API Key 后弹出一次的上下文引导 */
export const useContextGuide = create(() => ({ seen: readSeen(), open: false }))

/** 只在没看过时弹一次；已经看过就直接返回 */
export const maybeShowContextGuide = () => {
  if (!useContextGuide.getState().seen && !useContextGuide.getState().open) {
    useContextGuide.setState({ open: true })
  }
}

export const closeContextGuide = () => {
  try {
    localStorage.setItem(STORAGE_KEY, GUIDE_VERSION)
  } catch {
    // 存储不可用时只在本次会话内生效
  }
  useContextGuide.setState({ seen: true, open: false })
}

export const openContextGuide = () => useContextGuide.setState({ open: true })
