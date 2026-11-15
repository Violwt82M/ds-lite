import { create } from 'zustand'

/** 说明版本号：内容有实质变化时改这里，老用户会重新看到一次 */
const DISCLAIMER_VERSION = '2'
const STORAGE_KEY = 'ds-lite:disclaimer'

const readAccepted = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === DISCLAIMER_VERSION
  } catch {
    return false
  }
}

/** 首次启动必须看到一次；之后只能在设置里主动打开 */
export const useDisclaimer = create(() => ({
  accepted: readAccepted(),
  open: false,
}))

export const acceptDisclaimer = () => {
  try {
    localStorage.setItem(STORAGE_KEY, DISCLAIMER_VERSION)
  } catch {
    // 存储不可用时只在本次会话内生效
  }
  useDisclaimer.setState({ accepted: true, open: false })
}

export const openDisclaimer = () => useDisclaimer.setState({ open: true })
