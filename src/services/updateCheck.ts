import { create } from 'zustand'
import { Capacitor } from '@capacitor/core'
import { APP_VERSION } from '../version.js'

/**
 * APK 更新检测（0.9.34）。
 *
 * 为什么只做「检测 + 提示」不自动下载：Android WebView 没有下载监听、
 * 也没声明 REQUEST_INSTALL_PACKAGES，应用内下载安装不可行（要做就得加原生插件）。
 * api.github.com 在 WebView 里 CORS 放行（实测 Access-Control-Allow-Origin: *），
 * 但未认证限流 60 次/小时/IP，所以：24 小时最多一次、失败一律静默。
 */
const RELEASES_LATEST = 'https://api.github.com/repos/Violwt82M/ds-lite/releases/latest'
const STORAGE_KEY = 'ds-lite:update-check'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 8000

export type UpdateStatus = 'idle' | 'checking' | 'latest' | 'available' | 'failed'

type UpdateState = {
  status: UpdateStatus
  /** 远端最新版本号（去掉前缀 v） */
  latest: string | null
  /** 发布页地址，点「去下载」用它 */
  url: string | null
}

export const useUpdate = create<UpdateState>(() => ({
  status: 'idle',
  latest: null,
  url: null,
}))

export const isNativePlatform = () => Capacitor.isNativePlatform()

const parseVersion = (value: string) =>
  value
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number(part) || 0)

/** 逐段按数字比较：字符串比较会把 0.9.28.18 判成小于 0.9.28.8 */
export const isNewerVersion = (remote: string, local: string): boolean => {
  const a = parseVersion(remote)
  const b = parseVersion(local)
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) {
      return left > right
    }
  }
  return false
}

const readCache = (): { at: number; tag: string } | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as { at: number; tag: string }) : null
  } catch {
    return null
  }
}

const writeCache = (at: number, tag: string) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ at, tag }))
  } catch {
    // 存储不可用时退化为每次都查（仍受 status==='checking' 保护）
  }
}

/**
 * 查一次 GitHub 最新 Release。
 * force=false 时 24 小时内不重复请求（自动检测用）；force=true 时用户手动点也受最小间隔保护不了，
 * 但手动点本来就少，直接查。
 */
export const checkForUpdate = async (force = false): Promise<void> => {
  if (useUpdate.getState().status === 'checking') {
    return
  }
  if (!force) {
    const cache = readCache()
    if (cache && Date.now() - cache.at < CHECK_INTERVAL_MS) {
      return
    }
  }
  useUpdate.setState({ status: 'checking' })
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(RELEASES_LATEST, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = (await response.json()) as {
      tag_name?: string
      html_url?: string
      assets?: { name?: string }[]
    }
    const tag = (data.tag_name ?? '').replace(/^v/i, '')
    // 只有带 APK 资产的 Release 才算 APK 更新：仅网页版的 Release 不该提示装 APK
    const hasApk = (data.assets ?? []).some((asset) => (asset.name ?? '').endsWith('.apk'))
    writeCache(Date.now(), tag)
    if (tag && hasApk && isNewerVersion(tag, APP_VERSION)) {
      useUpdate.setState({ status: 'available', latest: tag, url: data.html_url ?? null })
    } else {
      useUpdate.setState({ status: 'latest', latest: tag || APP_VERSION, url: data.html_url ?? null })
    }
  } catch {
    // 网络 / 代理 / 限流：自动检测失败绝不打扰用户，只有手动点才把失败显示在关于页
    useUpdate.setState({ status: 'failed' })
  } finally {
    window.clearTimeout(timer)
  }
}
