import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

// 将源码中 TS 惯例的 .js 相对导入映射到 .ts/.tsx，以便 Node 24 原生直跑 TypeScript 单测
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      if (specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
        const stem = specifier.slice(0, -3)
        for (const ext of ['.ts', '.tsx']) {
          const candidate = new URL(stem + ext, context.parentURL)
          if (existsSync(fileURLToPath(candidate))) {
            return nextResolve(stem + ext, context)
          }
        }
      }
      throw err
    }
  },
})

// 最小浏览器全局桩（纯函数测试不依赖真实 DOM，仅避免模块顶层读取 localStorage / __API_ORIGIN__ 报错）
if (typeof globalThis.__API_ORIGIN__ === 'undefined') {
  globalThis.__API_ORIGIN__ = 'https://api.deepseek.com'
}
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map()
  globalThis.localStorage = {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key) {
      return store.has(key) ? store.get(key) : null
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null
    },
    removeItem(key) {
      store.delete(key)
    },
    setItem(key, value) {
      store.set(key, String(value))
    },
  }
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis
}
