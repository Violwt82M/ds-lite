/**
 * 文本安全工具。
 *
 * JS 字符串按 UTF-16 存储，emoji / 扩展 B 区汉字占两个「代理」。任何按字符数的截断，
 * 只要切点落在代理对中间，就会留下一个孤立代理；JSON.stringify 会把它写成 \udXXX，
 * 服务端的 JSON 解析器直接 400（实测：unexpected end of hex escape）。
 * 所以：切字符串一律走这里；发送前再用 sanitizeSurrogates 兜一次底。
 */

/** 孤立代理替换成 U+FFFD；没有代理时原样返回（快路径） */
export const sanitizeSurrogates = (text: string): string => {
  if (!/[\uD800-\uDFFF]/.test(text)) {
    return text
  }
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1]
        i += 1
      } else {
        out += '\uFFFD'
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '\uFFFD'
    } else {
      out += text[i]
    }
  }
  return out
}

/** 起点落在低位代理上时后移一位，避免切出半个 emoji */
const alignStart = (text: string, start: number) => {
  if (start <= 0) {
    return 0
  }
  const code = text.charCodeAt(start)
  return code >= 0xdc00 && code <= 0xdfff ? start + 1 : start
}

/** 终点落在高位代理上时前移一位 */
const alignEnd = (text: string, end: number) => {
  if (end >= text.length) {
    return text.length
  }
  if (end <= 0) {
    return 0
  }
  const code = text.charCodeAt(end - 1)
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end
}

/** 安全切片：等价于 text.slice(start, end)，但不会切断代理对 */
export const safeSlice = (text: string, start: number, end: number = text.length): string => {
  const from = alignStart(text, Math.max(0, start))
  const to = alignEnd(text, Math.min(text.length, end))
  return from >= to ? '' : text.slice(from, to)
}

/** 保留开头：超出上限时截断并加省略号（切点对齐代理对） */
export const safeTruncate = (text: string, limit: number, suffix = '…'): string =>
  text.length <= limit ? text : `${safeSlice(text, 0, limit)}${suffix}`

/** 保留结尾（用于「…后面的内容」这类倒序截取） */
export const safeTail = (text: string, limit: number): string =>
  text.length <= limit ? text : `…${safeSlice(text, text.length - limit)}`
