import { create } from 'zustand'

/**
 * API 地址。默认用构建期注入的官方地址，用户可以在设置里换成自建/第三方兼容服务
 * （需要实现 DeepSeek 的 /anthropic/v1 与 /models 接口，并允许浏览器跨域）。
 */
const STORAGE_KEY = 'chat-demo:api-origin'

/** 官方地址：构建时注入，默认 https://api.deepseek.com */
export const OFFICIAL_API_ORIGIN = __API_ORIGIN__

/** 去掉末尾斜杠；不以 http(s):// 开头视为非法 */
export const normalizeApiOrigin = (value: string) => value.trim().replace(/\/+$/, '')

export const isValidApiOrigin = (value: string) => /^https?:\/\/[^\s/?#]+/i.test(value.trim())

const read = (): string => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && isValidApiOrigin(saved)) {
      return normalizeApiOrigin(saved)
    }
  } catch {
    // 存储不可用就退回官方
  }
  return OFFICIAL_API_ORIGIN
}

export const useApiOrigin = create<{ origin: string }>(() => ({ origin: read() }))

/** 同步读取，请求组装时用 */
export const getApiOrigin = () => useApiOrigin.getState().origin

/** 传 null 恢复官方地址 */
export const setApiOrigin = (value: string | null) => {
  const next = value && isValidApiOrigin(value) ? normalizeApiOrigin(value) : OFFICIAL_API_ORIGIN
  useApiOrigin.setState({ origin: next })
  try {
    if (next === OFFICIAL_API_ORIGIN) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, next)
    }
  } catch {
    // 存不下只影响下次打开
  }
}

export const isCustomApiOrigin = () => getApiOrigin() !== OFFICIAL_API_ORIGIN

/**
 * 把用户填的地址拼成具体接口地址。
 * 有人会把完整接口贴进来（`https://x.com/anthropic/v1` 甚至 `.../messages`），
 * 直接再拼一遍就会变成 `/messages/anthropic/v1/messages`，服务端只会回 404/405。
 */
export const apiUrl = (path: string): string => {
  let root = getApiOrigin()
  for (const suffix of ['/messages', '/models']) {
    if (root.endsWith(suffix)) {
      root = root.slice(0, -suffix.length)
    }
  }
  if (root.endsWith('/anthropic/v1')) {
    // 已经到接口根，只补 /messages 这类尾巴
    return `${root}${path.replace(/^\/anthropic\/v1/, '')}`
  }
  if (root.endsWith('/anthropic')) {
    return `${root}/v1${path.replace(/^\/anthropic\/v1/, '')}`
  }
  return `${root}${path}`
}
