/**
 * 角色卡文本里的宏替换。
 *
 * 支持（大小写不敏感）：
 * - {{char}} / <BOT>：替换为角色名；
 * - {{user}} / <USER>：替换为用户名；
 * - {{random::候选一::候选二}}：取第一个候选（候选内允许嵌套一层简单宏）。
 * 未识别的宏原样保留，输入异常时返回空字符串，不抛异常。
 */

/** {{random::a::b}}，候选内允许出现 {{char}} 这类单层宏 */
const RANDOM_MACRO = /\{\{\s*random\s*::((?:[^{}]|\{\{[^{}]*\}\})*)\}\}/gi
const CHAR_MACRO = /\{\{\s*char\s*\}\}/gi
const USER_MACRO = /\{\{\s*user\s*\}\}/gi
const BOT_TAG = /<BOT>/gi
const USER_TAG = /<USER>/gi

export const substituteMacros = (
  text: string,
  vars: { char: string; user: string },
): string => {
  if (typeof text !== 'string' || text === '') {
    return ''
  }
  const char = typeof vars?.char === 'string' ? vars.char : ''
  const user = typeof vars?.user === 'string' ? vars.user : ''

  const withRandom = text.replace(
    RANDOM_MACRO,
    (whole: string, candidates: string): string => {
      if (typeof candidates !== 'string') {
        return whole
      }
      const first = candidates.split('::')[0] ?? ''
      return first.trim()
    },
  )

  return withRandom
    .replace(CHAR_MACRO, () => char)
    .replace(USER_MACRO, () => user)
    .replace(BOT_TAG, () => char)
    .replace(USER_TAG, () => user)
}
