import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ensureKatex, type Katex } from '../../services/markdown/katex.js'
import { KATEX_MACROS, prepareLatex } from '../../services/markdown/latex.js'
import { renderMathSvg, type MathSvg } from '../../services/markdown/microtex.js'

/** renderToString 外层包裹的标签，组件自己渲染外层，这里切掉 */
const KATEX_WRAPPER = {
  inline: ['<span class="katex">', '</span>'],
  display: ['<span class="katex-display"><span class="katex">', '</span></span>'],
} as const

type MathResult =
  | { renderMode: 'katex'; html: string }
  | { renderMode: 'microtex'; html: string; baselineOffset: number | null }
  | { renderMode: 'fallback'; html: string }

const noop = () => {}

/**
 * 一条公式的排版结果，和官方同一套顺序：
 * 1. KaTeX 原样排（普通公式全走这里，不碰 wasm）；
 * 2. 失败 → 先按兼容层补数学岛再交给 KaTeX（旧兜底，页面不至于空着）；
 * 3. 同时异步用 MicroTeX 排成 SVG，排出来了就换成它 —— 这才是官方那种美化包效果。
 */
const useMathHtml = (input: string, isInline: boolean): MathResult => {
  const previousResultRef = useRef<MathResult | null>(null)
  const katexRef = useRef(ensureKatex())
  const [katex, setKatex] = useState<Katex | null>(
    katexRef.current instanceof Promise ? null : katexRef.current
  )

  useEffect(() => {
    if (katexRef.current instanceof Promise) {
      katexRef.current.then(setKatex, noop)
    }
  }, [])

  /** 同步的 KaTeX 尝试结果：成功 / 兼容层成功 / 都失败（失败时先顶上一次成功的内容） */
  const attempt = useMemo(():
    | { status: 'katex'; html: string }
    | { status: 'patched'; html: string }
    | { status: 'failed'; html: string } => {
    if (!katex) {
      return { status: 'failed', html: input }
    }
    const [prefix, suffix] = KATEX_WRAPPER[isInline ? 'inline' : 'display']
    const render = (source: string): string =>
      katex
        .renderToString(source, {
          throwOnError: true,
          strict: false,
          displayMode: !isInline,
          macros: { ...KATEX_MACROS },
        })
        .slice(prefix.length, -suffix.length)
    try {
      const html = render(input)
      const result: MathResult = { renderMode: 'katex', html }
      previousResultRef.current = result
      return { status: 'katex', html }
    } catch {
      try {
        const html = render(prepareLatex(input))
        const result: MathResult = { renderMode: 'katex', html }
        previousResultRef.current = result
        return { status: 'patched', html }
      } catch {
        const previous = previousResultRef.current
        return { status: 'failed', html: previous?.html ?? input }
      }
    }
  }, [input, isInline, katex])

  const key = (isInline ? 'i:' : 'd:') + input
  const [svg, setSvg] = useState<{ key: string; value: MathSvg | null } | null>(null)

  useEffect(() => {
    if (attempt.status === 'katex' || !katex) {
      return
    }
    let cancelled = false
    // 流式输出时这段公式每个 delta 都会变，稍等一下再排，免得每帧都起一次 wasm 渲染
    const timer = window.setTimeout(() => {
      void renderMathSvg(input, isInline).then((value) => {
        if (!cancelled) {
          setSvg({ key, value })
        }
      })
    }, 120)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [attempt.status, input, isInline, katex, key])

  if (attempt.status === 'katex') {
    return { renderMode: 'katex', html: attempt.html }
  }
  if (svg !== null && svg.key === key && svg.value !== null) {
    return { renderMode: 'microtex', html: svg.value.svg, baselineOffset: svg.value.baselineOffset }
  }
  if (attempt.status === 'patched') {
    return { renderMode: 'katex', html: attempt.html }
  }
  return { renderMode: 'fallback', html: attempt.html }
}

/** 块级公式（\[...\]）：官方在 wasm 模式下用 SVG 块容器，其它情况保持原来的 KaTeX 结构 */
export const MathBlock = memo(function MathBlock({ value }: { value: string }) {
  const result = useMathHtml(value, false)
  if (result.renderMode === 'fallback') {
    return <p className="ds-markdown-paragraph">{result.html}</p>
  }
  if (result.renderMode === 'microtex') {
    return (
      <span
        className="ds-markdown-math ds-markdown-math-svg ds-markdown-math-display"
        dangerouslySetInnerHTML={{ __html: result.html }}
      ></span>
    )
  }
  return (
    <span className="katex-display ds-markdown-math">
      <span className="katex" dangerouslySetInnerHTML={{ __html: result.html }}></span>
    </span>
  )
})

/** 行内公式：SVG 模式按官方写法用 vertical-align 对齐基线 */
export const InlineMath = memo(function InlineMath({ value }: { value: string }) {
  const result = useMathHtml(value, true)
  if (result.renderMode === 'fallback') {
    return result.html
  }
  if (result.renderMode === 'microtex') {
    return (
      <span
        className="ds-markdown-math-svg"
        style={
          result.baselineOffset === null
            ? undefined
            : { verticalAlign: `${result.baselineOffset + 1}px` }
        }
        dangerouslySetInnerHTML={{ __html: result.html }}
      ></span>
    )
  }
  return <span className="katex" dangerouslySetInnerHTML={{ __html: result.html }}></span>
})
