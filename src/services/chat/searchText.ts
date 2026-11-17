import type { Message } from './types.js'

/**
 * 搜索用的纯文本工具：折叠空白、找命中区间、切高亮片段、从消息里取正文。
 * 不放 IO 也不放 React，正文索引（searchIndex.ts）和结果渲染（SessionSearch.tsx）共用同一套下标规则。
 */

/** 命中词在文本中的位置，左闭右开；标题和正文片段共用同一份下标，渲染时据此切文本，不拼 HTML。 */
export type SearchRange = { start: number; end: number }

/** 按命中区间切好的片段；match 为 true 的交给组件渲染成高亮。 */
export type SearchTextPart = { text: string; match: boolean }

/**
 * 查询和正文走同一套空白折叠：中文输入法、从别处粘贴的换行/制表符都能按「词」命中，
 * 也保证标题、正文片段、匹配下标三者基于同一份文本。
 */
export const collapseSpaces = (text: string): string => text.replace(/\s+/g, ' ')

export const normalizeQuery = (query: string): string => collapseSpaces(query).trim()

/** 关键词一律按字面量匹配：`C++`、`(测试)`、`.` 这类全标点输入不能当正则，也不该被截胡。 */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/** 返回 text 中 keyword 的全部命中区间；keyword 必须已归一化且非空。 */
export const findRanges = (text: string, keyword: string): SearchRange[] => {
  if (!text || !keyword) {
    return []
  }
  // g 循环取全部命中，i 让英文大小写都能命中；模式已转义，不会把标点解释成元字符。
  const pattern = new RegExp(escapeRegExp(keyword), 'gi')
  const ranges: SearchRange[] = []
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }
  return ranges
}

/** 把文本按命中区间切成普通/高亮片段：组件直接 map 成 React 节点，不用 dangerouslySetInnerHTML。 */
export const splitByRanges = (text: string, ranges: readonly SearchRange[]): SearchTextPart[] => {
  if (!text) {
    return []
  }
  if (ranges.length === 0) {
    return [{ text, match: false }]
  }
  const parts: SearchTextPart[] = []
  let cursor = 0
  for (const range of ranges) {
    // 区间由本模块生成，正常不会越界；这里钳一下，调用方传错时最多不高亮，不会切出 undefined。
    const start = Math.max(cursor, Math.min(range.start, text.length))
    const end = Math.max(start, Math.min(range.end, text.length))
    if (start > cursor) {
      parts.push({ text: text.slice(cursor, start), match: false })
    }
    if (end > start) {
      parts.push({ text: text.slice(start, end), match: true })
    }
    cursor = end
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), match: false })
  }
  return parts
}

/** 一段命中的正文上下文；前后是否还有原文由组件补省略号，这样下标不用跟着「…」变。 */
export type SearchSnippet = {
  text: string
  ranges: SearchRange[]
  clippedStart: boolean
  clippedEnd: boolean
}

/**
 * 截取命中词前后 contextChars 字；边界避开代理对，避免把 emoji 切成半个导致乱码。
 * matchIndex 是已知的命中位置（索引阶段已经找过一遍，不用再扫）。
 */
export const buildSnippet = (
  text: string,
  keyword: string,
  matchIndex: number,
  contextChars: number
): SearchSnippet => {
  const first = { start: matchIndex, end: matchIndex + keyword.length }
  let start = Math.max(0, first.start - contextChars)
  let end = Math.min(text.length, first.end + contextChars)
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) {
    start -= 1
  }
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) {
    end += 1
  }
  // 折叠后的空格落在窗口两端只是浪费展示宽度，但匹配词内部的空白要留着。
  while (start < first.start && text[start] === ' ') {
    start += 1
  }
  while (end > first.end && text[end - 1] === ' ') {
    end -= 1
  }
  const snippetText = text.slice(start, end)
  return {
    text: snippetText,
    ranges: findRanges(snippetText, keyword),
    clippedStart: start > 0,
    clippedEnd: end < text.length,
  }
}

/** 正文只算用户输入和助手的文本回答：思考过程、工具调用、附件元信息都不是「聊过的内容」。 */
export const messageText = (message: Message): string => {
  if (message.role === 'user') {
    return collapseSpaces(message.content).trim()
  }
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'text') {
      parts.push(block.text)
    }
  }
  return collapseSpaces(parts.join(' ')).trim()
}
