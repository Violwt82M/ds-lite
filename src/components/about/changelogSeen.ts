import { create } from 'zustand'
import { APP_VERSION } from '../../version.js'

/**
 * 「这一版更新了什么」的已读记录（0.9.34）。
 * 存版本号而不是布尔值：下一个版本自动重新弹一次，改文案不会重弹。
 * 新装用户不弹（首次启动该看的是免责声明和 API Key 引导，三弹叠在一起体验很差）。
 */
const STORAGE_KEY = 'ds-lite:changelog-seen'

const readSeen = (): string => {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

export const useChangelogSeen = create(() => ({ seen: readSeen(), open: false }))

export const markChangelogSeen = () => {
  try {
    localStorage.setItem(STORAGE_KEY, APP_VERSION)
  } catch {
    // 存储不可用时只在本次会话内生效
  }
  useChangelogSeen.setState({ seen: APP_VERSION, open: false })
}

export const openChangelogDialog = () => useChangelogSeen.setState({ open: true })
