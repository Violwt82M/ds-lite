/**
 * 本地 token 粗估：不调接口，允许 10%~20% 误差，只用于水位条、护栏与截断预算。
 * 实测（deepseek-flash，2026-11）：
 * - 中文散文 50,061 字 → 30,269 token，约 0.605 token/字；
 * - 纯 ASCII 50,000 字符 → 11,162 token，约 0.224 token/字符。
 * 取 0.65 / 0.25 留约 7% 余量：宁可高估一点，也不要让请求在服务端 400。
 */
export const CJK_CHAR_COST = 0.65
const ASCII_CHAR_COST = 0.25

const isCjk = (codePoint: number) =>
  (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
  (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
  (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
  (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
  (codePoint >= 0xff00 && codePoint <= 0xffef) ||
  (codePoint >= 0x3000 && codePoint <= 0x303f)

export const estimateTextTokens = (text: string): number => {
  let tokens = 0
  for (const char of text) {
    tokens += isCjk(char.codePointAt(0) ?? 0) ? CJK_CHAR_COST : ASCII_CHAR_COST
  }
  return Math.ceil(tokens)
}
