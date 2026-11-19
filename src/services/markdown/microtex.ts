/**
 * MicroTeX：官方同款的 LaTeX 降级排版引擎（wasm → SVG）。
 *
 * 为什么需要它：美化包公式把数学符号塞进 \raisebox / \text 这类「文本模式」参数里，
 * KaTeX 会直接报 Undefined control sequence；官方前端遇到解析失败的公式时，会降级到
 * MicroTeX（C++ 的 TeX 排版引擎，编译成 wasm，输出 SVG），所以同一串公式在官方和在我们
 * 这里会被排成两个样子（详见 docs/待办与须知.md 的排查记录）。
 *
 * 这里只做「按需加载 + 排版 + 缓存」：只有第一张 KaTeX 排不了的公式才会拉 wasm，
 * 平时（普通公式）完全走 KaTeX，不影响首屏体积和速度。
 */

type MicrotexRenderOptions = {
  textSize: number
  color: number
  isInline: boolean
  strict: boolean
}

type MicrotexRenderResult = {
  svg?: string
  baseline?: number
  error?: string
}

type MicrotexInstance = {
  init: () => void
  render: (source: string, options: MicrotexRenderOptions) => MicrotexRenderResult
}

export type MathSvg = {
  svg: string
  /** 行内公式按官方写法做的基线偏移（vertical-align 的 px 值），拿不到高度时为 null */
  baselineOffset: number | null
}

declare global {
  interface Window {
    __dsMicrotexFactory?: (config: Record<string, unknown>) => Promise<MicrotexInstance>
  }
}

/** 和官方一致：按 20px 字号排版，显示时交给 CSS 的 max-width 缩放 */
const TEXT_SIZE = 20
/** 0xff000000 = 黑色（官方传的同一个值） */
const BLACK_COLOR = 0xff000000
/** 官方的做法：把纯黑笔触换成 currentColor，深色主题下公式跟着正文颜色走 */
const BLACK_PAINT = /(fill|stroke)="rgb\(0,0,0\)"/g
const SVG_HEIGHT = /<svg\b[^>]*\sheight="([^"]+)"/i
/** 流式输出会反复拿同一段公式来问，缓存住；给个上限防止长对话里无限涨 */
const CACHE_LIMIT = 256

const assetUrl = (path: string) => new URL(path, document.baseURI).href

let instancePromise: Promise<MicrotexInstance | null> | null = null
const resultCache = new Map<string, MathSvg | null>()

const loadScript = (url: string) =>
  new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('latex engine load failed'))
    document.head.appendChild(script)
  })

const readBaselineOffset = (svg: string, baseline: number | undefined): number | null => {
  if (baseline === undefined) {
    return null
  }
  const height = Number.parseFloat(SVG_HEIGHT.exec(svg)?.[1] ?? '')
  return Number.isFinite(height) ? height - baseline : null
}

/**
 * 加载并初始化引擎。加载器是打包进 public/microtex 的普通脚本（内部是官方那份 rspack chunk
 * 加一层模块表外壳），wasm 自己 fetch 再以 wasmBinary 交给 emscripten：
 * Capacitor 的本地服务器对 .wasm 的 MIME 不一定标准，用 wasmBinary 可以免掉
 * instantiateStreaming 对 application/wasm 的要求。
 */
const loadInstance = async (): Promise<MicrotexInstance | null> => {
  try {
    if (!window.__dsMicrotexFactory) {
      await loadScript(assetUrl('microtex/microtex-loader.js'))
    }
    const factory = window.__dsMicrotexFactory
    if (!factory) {
      return null
    }
    const response = await fetch(assetUrl('microtex/microtex.wasm'))
    if (!response.ok) {
      return null
    }
    const wasmBinary = await response.arrayBuffer()
    const instance = await factory({
      wasmBinary,
      locateFile: () => assetUrl('microtex/microtex.wasm'),
    })
    instance.init()
    return instance
  } catch {
    // 引擎没起来（离线打开、file:// 打开、资源被删）不影响聊天：调用侧还有兼容层兜底
    return null
  }
}

export const ensureMicrotex = () => {
  instancePromise ??= loadInstance()
  return instancePromise
}

/**
 * 用 MicroTeX 排一条公式；同一串公式只排一次。失败返回 null，调用侧继续走兼容层兜底。
 * 失败结果也缓存（缺资源时别每帧重试），但引擎没加载起来时不缓存，等下一次有网再试。
 */
export const renderMathSvg = async (source: string, isInline: boolean): Promise<MathSvg | null> => {
  const key = (isInline ? 'i:' : 'd:') + source
  const cached = resultCache.get(key)
  if (cached !== undefined) {
    return cached
  }
  const instance = await ensureMicrotex()
  if (!instance) {
    return null
  }
  let result: MathSvg | null = null
  try {
    const rendered = instance.render(source, {
      textSize: TEXT_SIZE,
      color: BLACK_COLOR,
      isInline,
      strict: true,
    })
    if (!rendered.error && rendered.svg) {
      const svg = rendered.svg.replace(BLACK_PAINT, '$1="currentColor"')
      result = { svg, baselineOffset: readBaselineOffset(svg, rendered.baseline) }
    }
  } catch {
    result = null
  }
  if (resultCache.size >= CACHE_LIMIT) {
    resultCache.clear()
  }
  resultCache.set(key, result)
  return result
}
