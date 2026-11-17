import { create } from 'zustand'

/**
 * 网页版更新检测（0.9.34）。
 *
 * 走 waiting 模型（0.9.32 时决定）：构建脚本不再在 install 里 skipWaiting，
 * 新 SW 装好后停在 waiting，等用户点「立即刷新」才发 SKIP_WAITING 接管。
 * 这样用户正开着旧页面时，异步 chunk 不会因为新 SW 立刻清缓存而 404。
 */
type WebUpdateState = {
  /** 有新版本在等待接管 */
  available: boolean
  /** 用户点了刷新，正在切换 */
  applying: boolean
}

export const useWebUpdate = create<WebUpdateState>(() => ({ available: false, applying: false }))

let registration: ServiceWorkerRegistration | null = null

/** 用户确认：让 waiting 的 SW 接管，然后刷新一次（controllerchange 里刷新，避免刷到旧 SW） */
export const applyWebUpdate = () => {
  useWebUpdate.setState({ applying: true })
  const waiting = registration?.waiting
  if (!waiting) {
    window.location.reload()
    return
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {
    once: true,
  })
  waiting.postMessage({ type: 'SKIP_WAITING' })
}

/** 挂上 SW 更新监听；没有 SW 时什么都不做（APK 里 localhost 不注册 SW） */
export const watchWebUpdate = async () => {
  if (!('serviceWorker' in navigator)) {
    return
  }
  // 首次安装时 controller 为空：此时「新 SW 接管」不是升级，不该弹提示
  const hadController = Boolean(navigator.serviceWorker.controller)
  try {
    registration = await navigator.serviceWorker.ready
  } catch {
    return
  }
  const markAvailable = () => {
    if (hadController) {
      useWebUpdate.setState({ available: true })
    }
  }
  if (registration.waiting) {
    markAvailable()
  }
  registration.addEventListener('updatefound', () => {
    const installing = registration?.installing
    installing?.addEventListener('statechange', () => {
      // waiting 模型下新 SW 走到 'installed' 就停住等用户确认，不会再变 'activated'，
      // 所以提示必须挂在 installed + waiting 上（0.9.34 实测踩到过：只认 activated 永远不弹）
      if (installing.state === 'installed' && registration?.waiting) {
        markAvailable()
      }
      // 兜底：万一哪次真的直接接管了（旧缓存里的 sw.js 或手动 skipWaiting）
      if (installing.state === 'activated') {
        markAvailable()
      }
    })
  })
  // 浏览器只在自己觉得该查的时候查（≤24 小时一次）；主屏 PWA 常驻不导航，永远不会触发，
  // 所以回前台和每 6 小时各主动查一次。查完再看有没有 waiting，免得漏掉 updatefound。
  const refresh = () => {
    if (document.visibilityState !== 'visible') {
      return
    }
    void registration
      ?.update()
      .then(() => {
        if (registration?.waiting) {
          markAvailable()
        }
      })
      .catch(() => {})
  }
  document.addEventListener('visibilitychange', refresh)
  window.setInterval(refresh, 6 * 60 * 60 * 1000)
}
