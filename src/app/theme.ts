import { useSyncExternalStore } from 'react'
import { useSettings, type ThemePreference } from '../services/settings.js'
import { syncStatusBarAppearance } from '../services/wallpaper.js'

export type Theme = 'light' | 'dark'

const query = window.matchMedia('(prefers-color-scheme: dark)')

const subscribeOsTheme = (listener: () => void) => {
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}

const getOsTheme = (): Theme => (query.matches ? 'dark' : 'light')

const resolveTheme = (preference: ThemePreference, osTheme: Theme): Theme =>
  preference === 'system' ? osTheme : preference

/** 当前实际生效的深浅色：手动选择优先，「跟随系统」时取系统设置 */
export const useTheme = (): Theme => {
  const preference = useSettings((state) => state.themePreference)
  const osTheme = useSyncExternalStore(subscribeOsTheme, getOsTheme)
  return resolveTheme(preference, osTheme)
}

const syncPageBackground = () => {
  const backgroundColor = getComputedStyle(document.body).backgroundColor
  document.documentElement.style.backgroundColor = backgroundColor
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', backgroundColor)
}

/** 同步页面主题、根画布背景和支持 theme-color 的浏览器栏。 */
const applyTheme = (theme: Theme) => {
  const body = document.body
  // 主题切换帧禁用过渡，使页面颜色同步更新
  body.classList.add('change-theme')
  body.classList.toggle('dark', theme === 'dark')
  body.classList.toggle('light', theme === 'light')
  if (theme === 'dark') {
    body.setAttribute('data-ds-dark-theme', 'dark')
  } else {
    body.removeAttribute('data-ds-dark-theme')
  }
  document.documentElement.style.colorScheme = theme
  syncStatusBarAppearance()
  // 首次背景色同步在样式表加载完成后执行，适配 WebKit 的 defer 脚本执行顺序。
  if (document.readyState === 'complete') {
    syncPageBackground()
  }
  setTimeout(() => {
    body.classList.remove('change-theme')
  }, 0)
}

let appliedTheme: Theme | null = null

const syncTheme = () => {
  const theme = resolveTheme(useSettings.getState().themePreference, getOsTheme())
  if (theme !== appliedTheme) {
    appliedTheme = theme
    applyTheme(theme)
  }
}

/**
 * 字号缩放：整页缩放而不是改每个 font-size，改动小、覆盖全。
 * 用 body 上的 zoom（Chromium/WebKit 都支持），弹窗也挂在 body 下，一起缩放。
 */
const syncFontScale = () => {
  const scale = useSettings.getState().fontScale
  const zoom = scale === 100 ? 1 : scale / 100
  const root = document.documentElement.style
  root.setProperty('--app-zoom', String(zoom))
  // 视口单位（vh/vw）不会跟着 zoom 变，这里按比例换算成新值。
  // 用字面量而不是 CSS 里的 calc(100vh / var(--app-zoom))：老内核对
  // 「除以变量」支持不一致，值失效会让整页高度塌成 0（荣耀白屏同源问题）。
  if (zoom === 1) {
    root.removeProperty('--app-vh')
    root.removeProperty('--app-vw')
    root.removeProperty('--app-dvh')
  } else {
    root.setProperty('--app-vh', `calc(100vh / ${zoom})`)
    root.setProperty('--app-vw', `calc(100vw / ${zoom})`)
    root.setProperty('--app-dvh', `calc(100dvh / ${zoom})`)
  }
  document.body.style.zoom = zoom === 1 ? '' : String(zoom)
}

/** 首屏渲染前同步应用一次，之后随主题设置与系统深浅色变化更新 */
export const setupTheme = () => {
  syncTheme()
  syncFontScale()
  useSettings.subscribe(syncFontScale)
  if (document.readyState !== 'complete') {
    window.addEventListener('load', syncPageBackground, { once: true })
  }
  query.addEventListener('change', syncTheme)
  useSettings.subscribe(syncTheme)
}
