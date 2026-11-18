import type {
  Node as MdAstNode,
  Nodes,
  Parent,
  PhrasingContent,
  RootContent,
  Root,
  Text,
} from 'mdast'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-llm-math'
import type { Source } from '../chat/view.js'

/** 正文里的 [citation:N]，已换成对应来源 */
export interface CitationNode extends MdAstNode {
  type: 'citation'
  source: Source
}

/** 白名单内联 HTML 收成的元素节点，见下面 groupInlineHtml */
export interface HtmlElementNode extends MdAstNode {
  type: 'htmlElement'
  tag: string
  children: PhrasingContent[]
}

declare module 'mdast' {
  interface RootContentMap {
    citation: CitationNode
  }

  interface PhrasingContentMap {
    citation: CitationNode
    htmlElement: HtmlElementNode
  }
}

const text = (value: string): Text => ({ type: 'text', value })

/**
 * 解析正文，并把渲染器不单独处理的节点提前换掉，渲染时无需再读原文：
 * - 传入 sources 时，[citation:N] 换成角标节点，找不到来源的直接去掉
 * - disableLink 时链接只保留文字
 * - 删除线保留原样的 ~ 定界符，脚注、引用式链接与定义显示原文
 */
export function toMdAst(
  input: string,
  { sources, disableLink }: { sources: Source[] | undefined; disableLink: boolean }
): Root {
  const ast = fromMarkdown(input, {
    extensions: [
      // codeIndented 语法导致有前导空格的列表无法正常渲染
      { ...gfm(), disable: { null: ['codeIndented'] } },
      math({ singleDollarTextMath: true }),
    ],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  })
  if (sources) {
    const sourcesByIndex = new Map(sources.map((source) => [source.index, source]))
    findAndReplace(
      ast,
      [
        /\[citation:(\d+)\]/g,
        (_: string, index: string): CitationNode | '' => {
          const source = sourcesByIndex.get(Number(index))
          return source ? { type: 'citation', source } : ''
        },
      ],
      { ignore: ['linkReference'] }
    )
  }
  groupInlineHtml(ast)
  const raw = (node: Nodes) => input.slice(node.position?.start.offset, node.position?.end.offset)
  // 先处理子节点，再按需把当前节点换成若干节点
  const simplify = (node: Nodes): Nodes[] => {
    if ('children' in node) {
      ;(node as Parent).children = (node.children as unknown as Nodes[]).flatMap(
        simplify
      ) as RootContent[]
    }
    switch (node.type) {
      case 'link':
        return disableLink ? (node.children as unknown as Nodes[]) : [node]
      case 'delete': {
        // 解析器保证首尾定界符等长
        const delimiter = raw(node).match(/^~+/)?.[0] ?? ''
        return [text(delimiter), ...(node.children as unknown as Nodes[]), text(delimiter)]
      }
      case 'footnoteReference':
      case 'imageReference':
      case 'linkReference':
        return [text(raw(node))]
      case 'footnoteDefinition':
      case 'definition':
        return [{ type: 'paragraph', children: [text(raw(node))] }]
      default:
        return [node]
    }
  }
  simplify(ast)
  return ast
}

/**
 * 内联 HTML 白名单：美化包 / 角色卡里常用 <u>、<mark>、<sub>、<sup> 做排版。
 * Markdown 会把 <u>文字</u> 拆成三个平级节点（html / text / html），组件层按节点
 * 渲染既包不住文字、还会把闭标签当正文漏出来（正文里出现 </u>），所以必须在 AST
 * 层先把开闭标签配对收成一个节点。属性一律丢弃，落单的标签直接丢掉。
 */
const INLINE_HTML_TAGS = new Set([
  'u',
  'mark',
  'b',
  'strong',
  'i',
  'em',
  's',
  'del',
  'sub',
  'sup',
  'small',
])

const OPEN_TAG = /^<([a-zA-Z][\w-]*)(?:\s[^>]*)?>$/
const CLOSE_TAG = /^<\/([a-zA-Z][\w-]*)\s*>$/

const groupInlineHtml = (node: Nodes): void => {
  if (!('children' in node)) {
    return
  }
  const children = node.children as Nodes[]
  const output: Nodes[] = []
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (child.type === 'html') {
      const value = child.value.trim()
      const open = OPEN_TAG.exec(value)
      const tag = open ? open[1].toLowerCase() : ''
      if (open && INLINE_HTML_TAGS.has(tag)) {
        let depth = 1
        let end = -1
        for (let cursor = index + 1; cursor < children.length; cursor += 1) {
          const candidate = children[cursor]
          if (candidate.type !== 'html') {
            continue
          }
          const text = candidate.value.trim()
          const openCandidate = OPEN_TAG.exec(text)
          const closeCandidate = CLOSE_TAG.exec(text)
          if (openCandidate && openCandidate[1].toLowerCase() === tag) {
            depth += 1
          } else if (closeCandidate && closeCandidate[1].toLowerCase() === tag) {
            depth -= 1
            if (depth === 0) {
              end = cursor
              break
            }
          }
        }
        if (end !== -1) {
          const element = {
            type: 'htmlElement',
            tag,
            children: children.slice(index + 1, end),
          } as unknown as Nodes
          output.push(element)
          index = end
          continue
        }
      }
      // 落单的开闭标签（或恶意标签的子串）不显示尖括号；其它 html（注释等）保持原样
      if (open || CLOSE_TAG.test(value)) {
        continue
      }
      output.push(child)
      continue
    }
    output.push(child)
  }
  ;(node as Parent).children = output as RootContent[]
  for (const child of output) {
    groupInlineHtml(child)
  }
}
