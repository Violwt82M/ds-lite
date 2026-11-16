import './app/compat.js'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'

/** 网页版注册 Service Worker：第一次成功打开后即可离线启动；安卓包内（localhost）和鸿蒙外壳跳过 */
function setupOffline() {
  if (!('serviceWorker' in navigator)) {
    return
  }
  if (window.__DS_LITE_PLATFORM__ === 'harmonyos') {
    return
  }
  const { hostname, protocol } = window.location
  if (hostname === 'localhost') {
    return
  }
  if (protocol !== 'https:' && hostname !== '127.0.0.1') {
    return
  }
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {})
  })
}

ensureKatex()
setupTheme()
setupOffline()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)

// 启动成功的标记：index.html 里的兜底脚本用它判断要不要显示“没能启动”
;(window as Window & { __dsLiteBooted?: boolean }).__dsLiteBooted = true
