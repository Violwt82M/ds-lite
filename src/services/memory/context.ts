import { getVisibleMessages } from '../chat/branches.js'
import { getContextRounds } from '../chat/reply.js'
import type { Message, Session } from '../chat/types.js'

/** 官方模型上下文上限：deepseek-flash / deepseek-v4-pro 均为 1M（输出上限 384K） */
export const CONTEXT_LIMIT_TOKENS = 1_000_000

/**
 * 四色水位（占上下文上限的比例）：
 * 蓝 <20% 正常；橙 20%~35% 该整理了；红 35%~70% 会自动整理；黄黑 70%~ 再长就发不出去。
 */
export const CONTEXT_LEVELS = { mid: 0.2, high: 0.35, critical: 0.7 } as const

export type ContextLevel = 'low' | 'mid' | 'high' | 'critical'

export const getContextLevel = (ratio: number): ContextLevel => {
  if (ratio >= CONTEXT_LEVELS.critical) {
    return 'critical'
  }
  if (ratio >= CONTEXT_LEVELS.high) {
    return 'high'
  }
  return ratio >= CONTEXT_LEVELS.mid ? 'mid' : 'low'
}

/** 自动整理线：45%（红色区间内），到这条线就把较早的轮次压缩成记忆笔记 */
export const AUTO_COMPACT_RATIO = 0.45
/** 系统提示词、角色卡、记忆笔记与协议头的粗估占用 */
const SYSTEM_OVERHEAD_TOKENS = 500
/**
 * 一个汉字按 0.75 token 估（偏保守：宁可高估用量，也不要让用户以为还有空间）。
 * ASCII 约 0.3 token。只用于展示和阈值判断，不进入请求。
 */
const CJK_CHAR_COST = 0.75
const ASCII_CHAR_COST = 0.3
/** 每条消息的角色标记与分隔符开销 */
const MESSAGE_OVERHEAD_TOKENS = 8
/** 图片按官方惯例折算；文档无法得知页数，取中庸值 */
const IMAGE_TOKENS = 1024
const DOCUMENT_TOKENS = 2048

const isCjk = (codePoint: number) =>
  (codePoint >= 0x2e80 && codePoint <= 0x9fff) ||
  (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
  (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
  (codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
  (codePoint >= 0xff00 && codePoint <= 0xffef) ||
  (codePoint >= 0x3000 && codePoint <= 0x303f)

/** 本地粗估文本 token 数：不调用任何接口，允许有 10%~20% 误差。 */
export const estimateTextTokens = (text: string): number => {
  let tokens = 0
  for (const char of text) {
    tokens += isCjk(char.codePointAt(0) ?? 0) ? CJK_CHAR_COST : ASCII_CHAR_COST
  }
  return Math.ceil(tokens)
}

/** 单条消息的粗估；历史思考块服务端会丢弃，不计入。 */
export const estimateMessageTokens = (message: Message): number => {
  if (message.role === 'user') {
    let tokens = estimateTextTokens(message.content) + MESSAGE_OVERHEAD_TOKENS
    for (const file of message.files) {
      tokens += file.isImage ? IMAGE_TOKENS : DOCUMENT_TOKENS
    }
    return tokens
  }
  let tokens = MESSAGE_OVERHEAD_TOKENS
  for (const block of message.blocks) {
    if (block.type === 'text') {
      tokens += estimateTextTokens(block.text)
    }
  }
  return tokens
}

/** 已被折叠、不再进入请求上下文的回答消息 id */
export const getFoldedIds = (session: Session): Set<string> =>
  new Set(session.memory?.foldedIds ?? [])

/** 当前仍会进入请求的历史轮次（提问 + 可用回答） */
export const getUnfoldedRounds = (session: Session) => {
  const folded = getFoldedIds(session)
  return getContextRounds(getVisibleMessages(session)).filter(([, reply]) => !folded.has(reply.id))
}

export type ContextUsage = {
  /** 粗估的已用 token 数（含系统提示词与记忆笔记） */
  usedTokens: number
  limitTokens: number
  /** 已用比例，0~1，可能因粗估误差略超 1 */
  ratio: number
  /** 会进入请求的历史轮数 */
  rounds: number
  /** 已折叠的轮数 */
  foldedRounds: number
}

/**
 * 结果缓存：会话对象在每次修改时都是新对象，但为了防御就地修改，
 * 这里同时比对 messages 与 memory 的引用，变了才重算。
 * 几千条消息的会话每帧重算会明显卡顿，顶栏百分比是高频渲染的。
 */
const usageCache = new WeakMap<
  Session,
  { messages: Session['messages']; memory: Session['memory']; usage: ContextUsage }
>()

/** 当前会话的上下文占用；纯本地计算，不产生任何请求。 */
export const getContextUsage = (session: Session): ContextUsage => {
  const cached = usageCache.get(session)
  if (cached && cached.messages === session.messages && cached.memory === session.memory) {
    return cached.usage
  }
  let usedTokens = SYSTEM_OVERHEAD_TOKENS
  for (const note of session.memory?.notes ?? []) {
    usedTokens += estimateTextTokens(note.text) + MESSAGE_OVERHEAD_TOKENS
  }
  const rounds = getUnfoldedRounds(session)
  for (const [user, reply] of rounds) {
    usedTokens += estimateMessageTokens(user) + estimateMessageTokens(reply)
  }
  const usage: ContextUsage = {
    usedTokens,
    limitTokens: CONTEXT_LIMIT_TOKENS,
    ratio: usedTokens / CONTEXT_LIMIT_TOKENS,
    rounds: rounds.length,
    foldedRounds: session.memory?.foldedRounds ?? 0,
  }
  usageCache.set(session, { messages: session.messages, memory: session.memory, usage })
  return usage
}

/** 把估算 token 换成"大约多少汉字"，给不看 token 的用户看 */
export const formatCharCount = (tokens: number): string => {
  const chars = Math.round(tokens / CJK_CHAR_COST)
  if (chars >= 10_000) {
    return `${(chars / 10_000).toFixed(1).replace(/\.0$/, '')} 万字`
  }
  if (chars >= 1000) {
    return `${(chars / 1000).toFixed(1).replace(/\.0$/, '')} 千字`
  }
  return `${chars} 字`
}

/** 数量缩写：1234 → 1.2k，123456 → 123k，1_240_000 → 1.2M */
export const formatTokenCount = (tokens: number): string => {
  if (tokens < 1000) {
    return String(tokens)
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  }
  if (tokens < 100_000) {
    return `${(tokens / 1000).toFixed(1)}k`
  }
  return `${Math.round(tokens / 1000)}k`
}
