/**
 * 酒馆（SillyTavern）角色卡解析与系统提示词渲染。
 *
 * 支持的输入：
 * - JSON 文本：v2/v3 的 { spec, data } 结构，或 v1 的顶层扁平结构（v2/v3 优先）；
 * - PNG 图片：按 PNG 块结构读取 tEXt / iTXt 中 keyword 为 chara 或 ccv3 的数据，
 *   值可以是 base64（允许带 data:application/json;base64, 前缀），也可以已经是 JSON。
 *
 * 所有解析函数都不抛异常，统一返回 ParseResult；字段类型不符时按空字符串处理。
 */

import { substituteMacros } from './macros.js'

export type PersonaCard = {
  name: string
  description: string
  personality: string
  /** 说话风格 */
  style: string
  /** 行为准则（该做 / 不该做） */
  rules: string
  /** 私密互动与行为模式 */
  behavior: string
  scenario: string
  firstMessage: string
  messageExamples: string
  systemPrompt: string
  postHistoryInstructions: string
  creatorNotes?: string
  source: 'png' | 'json'
}

export type ParseResult = { ok: true; card: PersonaCard } | { ok: false; error: string }

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 只接受字符串，其它类型一律视为空 */
const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

/** mes_example 可能是字符串，也可能是字符串数组（数组按空行拼接） */
const readMessageExamples = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return ''
  }
  return value
    .map((item) => asString(item))
    .filter((item) => item.trim() !== '')
    .join('\n\n')
}

/** 把任意 JSON 值归一化为 PersonaCard；v2/v3 优先取 data，否则按 v1 顶层字段读取 */
const parseCardObject = (root: unknown, source: 'png' | 'json'): ParseResult => {
  if (!isRecord(root)) {
    return { ok: false, error: '角色卡数据不是 JSON 对象' }
  }
  const data: JsonRecord = isRecord(root.data) ? root.data : root

  const name = asString(data.name).trim() || asString(data.nickname).trim()
  if (name === '') {
    return { ok: false, error: '角色卡缺少 name 字段（或 name 内容为空）' }
  }

  const creatorNotes = asString(data.creator_notes)
  const card: PersonaCard = {
    name,
    description: asString(data.description),
    personality: asString(data.personality),
    style: asString(data.style),
    rules: asString(data.rules),
    behavior: asString(data.behavior),
    scenario: asString(data.scenario),
    firstMessage: asString(data.first_mes),
    messageExamples: readMessageExamples(data.mes_example),
    systemPrompt: asString(data.system_prompt),
    postHistoryInstructions: asString(data.post_history_instructions),
    source,
  }
  if (creatorNotes !== '') {
    card.creatorNotes = creatorNotes
  }
  return { ok: true, card }
}

/** 解析角色卡 JSON 文本 */
export const parsePersonaJson = (text: string): ParseResult => {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: '角色卡 JSON 内容为空' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return { ok: false, error: '角色卡 JSON 解析失败：内容不是合法的 JSON' }
  }
  return parseCardObject(parsed, 'json')
}

/** PNG 文件头签名 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_SIGNATURE_LENGTH = PNG_SIGNATURE.length

type CardTextChunk = { keyword: string; value: string } | { keyword: string; error: string }

const isPngSignature = (bytes: Uint8Array): boolean => {
  if (bytes.length < PNG_SIGNATURE_LENGTH) {
    return false
  }
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

const readUint32BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) >>> 0) +
  (bytes[offset + 1] << 16) +
  (bytes[offset + 2] << 8) +
  bytes[offset + 3]

/** tEXt 用的是 latin1，这里逐字节还原，避免 TextDecoder 的 windows-1252 差异 */
const decodeLatin1 = (bytes: Uint8Array): string => {
  let out = ''
  const step = 0x8000
  for (let index = 0; index < bytes.length; index += step) {
    out += String.fromCharCode(...bytes.subarray(index, Math.min(index + step, bytes.length)))
  }
  return out
}

const decodeUtf8 = (bytes: Uint8Array, fatal: boolean): string | null => {
  try {
    return new TextDecoder('utf-8', { fatal }).decode(bytes)
  } catch {
    return null
  }
}

/** 读取以 0 结尾的字符串，返回值和下一段起始位置 */
const readCString = (
  bytes: Uint8Array,
  start: number,
): { value: string; next: number } | null => {
  let end = start
  while (end < bytes.length && bytes[end] !== 0) {
    end += 1
  }
  if (end >= bytes.length) {
    return null
  }
  return { value: decodeLatin1(bytes.subarray(start, end)), next: end + 1 }
}

/** tEXt：keyword\0text，text 为 latin1 */
const parseTEXt = (bytes: Uint8Array, start: number, end: number): CardTextChunk | null => {
  const segment = bytes.subarray(start, end)
  const keyword = readCString(segment, 0)
  if (keyword === null) {
    return null
  }
  return {
    keyword: keyword.value.trim().toLowerCase(),
    value: decodeLatin1(segment.subarray(keyword.next)),
  }
}

/** iTXt：keyword\0 压缩标记 压缩方法 语言标签\0 翻译关键词\0 text(UTF-8) */
const parseITXt = (bytes: Uint8Array, start: number, end: number): CardTextChunk | null => {
  const segment = bytes.subarray(start, end)
  const keyword = readCString(segment, 0)
  if (keyword === null) {
    return null
  }
  if (keyword.next + 2 > segment.length) {
    return null
  }
  const compressionFlag = segment[keyword.next]
  const keywordName = keyword.value.trim().toLowerCase()
  let cursor = keyword.next + 2

  const languageTag = readCString(segment, cursor)
  if (languageTag === null) {
    return null
  }
  cursor = languageTag.next
  const translatedKeyword = readCString(segment, cursor)
  if (translatedKeyword === null) {
    return null
  }
  cursor = translatedKeyword.next

  if (compressionFlag === 1) {
    return { keyword: keywordName, error: '角色卡数据块是压缩的 iTXt，当前无法解析' }
  }
  if (compressionFlag !== 0) {
    return { keyword: keywordName, error: '角色卡数据块的 iTXt 压缩标记无效' }
  }
  const text = decodeUtf8(segment.subarray(cursor), true)
  if (text === null) {
    return { keyword: keywordName, error: '角色卡数据块不是有效的 UTF-8 文本' }
  }
  return { keyword: keywordName, value: text }
}

/** 顺序扫描 PNG 块，收集 keyword 为 chara / ccv3 的文本块 */
const readCardChunks = (
  bytes: Uint8Array,
): { chunks: CardTextChunk[]; truncated: boolean } => {
  const chunks: CardTextChunk[] = []
  let truncated = false
  let offset = PNG_SIGNATURE_LENGTH

  while (offset + 8 <= bytes.length) {
    const length = readUint32BE(bytes, offset)
    const typeName = decodeLatin1(bytes.subarray(offset + 4, offset + 8))
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) {
      truncated = true
      break
    }
    if (typeName === 'tEXt' || typeName === 'iTXt') {
      const chunk =
        typeName === 'tEXt'
          ? parseTEXt(bytes, dataStart, dataEnd)
          : parseITXt(bytes, dataStart, dataEnd)
      if (chunk !== null && (chunk.keyword === 'chara' || chunk.keyword === 'ccv3')) {
        chunks.push(chunk)
      }
    }
    offset = dataEnd + 4
    if (typeName === 'IEND') {
      break
    }
  }

  return { chunks, truncated }
}

/** 去掉 data URI 前缀并做 base64 → UTF-8 解码；已经是 JSON 的值直接返回 */
const decodeChunkValue = (raw: string): { text: string } | { error: string } => {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return { error: '角色卡数据块内容为空' }
  }
  if (trimmed.startsWith('{')) {
    return { text: trimmed }
  }
  const payload = trimmed.replace(/^\s*data:[^,]*,/i, '')
  let binary: string
  try {
    binary = atob(payload)
  } catch {
    return { error: '角色卡数据块 base64 解码失败' }
  }
  if (binary === '') {
    return { error: '角色卡数据块 base64 解码结果为空' }
  }
  const decoded = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    decoded[index] = binary.charCodeAt(index) & 0xff
  }
  const text = decodeUtf8(decoded, true)
  if (text === null) {
    return { error: '角色卡数据块 base64 解码后不是有效的 UTF-8 文本' }
  }
  return { text }
}

const parseCardText = (text: string): ParseResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    return { ok: false, error: '角色卡 JSON 解析失败：PNG 内嵌数据不是合法的 JSON' }
  }
  return parseCardObject(parsed, 'png')
}

/** 从 PNG 字节中解析角色卡：ccv3（v3）优先，其次 chara */
export const parsePersonaPng = (bytes: ArrayBuffer | Uint8Array): ParseResult => {
  let view: Uint8Array
  if (bytes instanceof Uint8Array) {
    view = bytes
  } else if (bytes instanceof ArrayBuffer) {
    view = new Uint8Array(bytes)
  } else {
    return { ok: false, error: 'PNG 数据格式不正确：需要 ArrayBuffer 或 Uint8Array' }
  }

  if (!isPngSignature(view)) {
    return { ok: false, error: '不是 PNG 文件：文件头签名不匹配' }
  }

  const { chunks, truncated } = readCardChunks(view)
  if (chunks.length === 0) {
    return {
      ok: false,
      error: truncated
        ? 'PNG 数据不完整：数据块被截断，未找到角色卡数据块'
        : 'PNG 中未找到角色卡数据块（tEXt/iTXt 的 chara 或 ccv3）',
    }
  }

  const ordered = [
    ...chunks.filter((chunk) => chunk.keyword === 'ccv3'),
    ...chunks.filter((chunk) => chunk.keyword === 'chara'),
  ]
  let firstError = ''
  for (const chunk of ordered) {
    if ('error' in chunk) {
      if (firstError === '') {
        firstError = chunk.error
      }
      continue
    }
    const decoded = decodeChunkValue(chunk.value)
    if ('error' in decoded) {
      if (firstError === '') {
        firstError = decoded.error
      }
      continue
    }
    const result = parseCardText(decoded.text)
    if (result.ok) {
      return result
    }
    if (firstError === '') {
      firstError = result.error
    }
  }
  return { ok: false, error: firstError === '' ? '角色卡数据块解析失败' : firstError }
}

/**
 * 把角色卡拼成系统提示词。
 * 顺序：systemPrompt → description → personality → scenario → 对话示例 → postHistoryInstructions；
 * 空字段跳过，所有文本都经过宏替换（char = card.name，user = opts.userName）。
 */
export const renderSystemPrompt = (
  card: PersonaCard,
  opts: { userName: string },
): string => {
  const charName = typeof card.name === 'string' ? card.name.trim() : ''
  const userName = typeof opts?.userName === 'string' ? opts.userName.trim() : ''
  const vars = { char: charName, user: userName }

  const header =
    userName === ''
      ? `你现在正在扮演「${charName}」。`
      : `你现在正在扮演「${charName}」，对话的另一方是「${userName}」。`

  const sections: { title: string; text: string }[] = [
    { title: '系统设定', text: card.systemPrompt },
    { title: '角色设定', text: card.description },
    { title: '性格', text: card.personality },
    { title: '说话风格', text: card.style },
    { title: '行为准则', text: card.rules },
    { title: '互动模式', text: card.behavior },
    { title: '场景', text: card.scenario },
    { title: '对话示例', text: card.messageExamples },
    { title: '补充要求', text: card.postHistoryInstructions },
  ]

  const blocks: string[] = [header]
  for (const section of sections) {
    const raw = typeof section.text === 'string' ? section.text : ''
    if (raw.trim() === '') {
      continue
    }
    const content = substituteMacros(raw, vars).trim()
    if (content === '') {
      continue
    }
    blocks.push(`【${section.title}】\n${content}`)
  }
  blocks.push('请不要出戏。')
  return blocks.join('\n\n')
}

/** 新建空卡：本地自建角色卡从这份骨架开始 */
export const emptyCard = (): PersonaCard => ({
  name: '',
  description: '',
  personality: '',
  style: '',
  rules: '',
  behavior: '',
  scenario: '',
  firstMessage: '',
  messageExamples: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  source: 'json',
})

/** 导出为酒馆 v2 结构的 JSON 文本，便于玩家互相分享；扩展字段也一并写出 */
export const cardToJsonText = (card: PersonaCard): string =>
  JSON.stringify(
    {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: card.name,
        description: card.description,
        personality: card.personality,
        scenario: card.scenario,
        first_mes: card.firstMessage,
        mes_example: card.messageExamples,
        system_prompt: card.systemPrompt,
        post_history_instructions: card.postHistoryInstructions,
        creator_notes: card.creatorNotes ?? '',
        style: card.style,
        rules: card.rules,
        behavior: card.behavior,
      },
    },
    null,
    2,
  )
