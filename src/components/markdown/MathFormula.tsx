import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ensureKatex, type Katex } from '../../services/markdown/katex.js'
import { KATEX_MACROS, prepareLatex } from '../../services/markdown/latex.js'

/** renderToString 外层包裹的标签，组件自己渲染外层，这里切掉 */
const KATEX_WRAPPER = {
  inline: ['<span class="katex">', '</span>'],
  display: ['<span class="katex-display"><span class="katex">', '</span></span>'],
} as const

type MathHtmlResult = {
  html: string
  renderMode: 'katex' | 'fallback'
}

const noop = () => {}

/** KaTeX 渲染公式；出错时保留上次成功的结果（流式中公式未写完），没有则展示原文 */
const useMathHtml = (input: string, isInline: boolean): MathHtmlResult => {
  const previousResultRef = useRef<MathHtmlResult | null>(null)
  const katexRef = useRef(ensureKatex())
  const [katex, setKatex] = useState<Katex | null>(
    katexRef.current instanceof Promise ? null : katexRef.current
  )

  useEffect(() => {
    if (katexRef.current instanceof Promise) {
      katexRef.current.then(setKatex, noop)
    }
  }, [])

  return useMemo((): MathHtmlResult => {
    if (!katex) {
      return { html: input, renderMode: 'fallback' }
    }
    const [prefix, suffix] = KATEX_WRAPPER[isInline ? 'inline' : 'display']
    /** 渲染一次 KaTeX，把组件自己的外层包掉（MathBlock/InlineMath 会自己套） */
    const render = (source: string): MathHtmlResult => ({
      html: katex
        .renderToString(source, {
          throwOnError: true,
          strict: false,
          displayMode: !isInline,
          macros: { ...KATEX_MACROS },
        })
        .slice(prefix.length, -suffix.length),
      renderMode: 'katex',
    })
    try {
      const result = render(input)
      previousResultRef.current = result
      return result
    } catch {
      // 「美化包」会把数学符号塞进 \text、\raisebox 这类文本模式参数里，KaTeX 不像
      // 真 LaTeX 会自动补 $，直接报 Undefined control sequence。先按原样渲染一次，
      // 失败再用兼容层补数学岛重试；兼容层只在失败路径上跑，不影响普通公式。
      try {
        const result = render(prepareLatex(input))
        previousResultRef.current = result
        return result
      } catch {
        return previousResultRef.current ?? { html: input, renderMode: 'fallback' }
      }
    }
  }, [input, isInline, katex])
}

export const MathBlock = memo(function MathBlock({ value }: { value: string }) {
  const { html, renderMode } = useMathHtml(value, false)
  if (renderMode === 'fallback') {
    return <p className="ds-markdown-paragraph">{html}</p>
  }
  return (
    <span className="katex-display ds-markdown-math">
      <span className="katex" dangerouslySetInnerHTML={{ __html: html }}></span>
    </span>
  )
})

export const InlineMath = memo(function InlineMath({ value }: { value: string }) {
  const { html, renderMode } = useMathHtml(value, true)
  if (renderMode === 'fallback') {
    return html
  }
  return <span className="katex" dangerouslySetInnerHTML={{ __html: html }}></span>
})
