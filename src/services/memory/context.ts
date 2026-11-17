import { CJK_CHAR_COST, estimateTextTokens } from '../../utils/textTokens.js'
import { getVisibleMessages } from '../chat/branches.js'
import { getContextRounds } from '../chat/reply.js'
import type { AssistantMessage, Message, Session, UserMessage } from '../chat/types.js'

export { estimateTextTokens }

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
/**
 * 整理后仍保留原文的最近内容（token）。风格靠这段原文，不靠笔记里抄的台词：
 * 24k token 约 3.7 万字；手动整理也至少留 12k。
 */
export const MEMORY_KEEP_TOKENS = 24_000
export const MANUAL_KEEP_TOKENS = 12_000
/** 不管正文多长都至少保留的轮数，避免一条超长消息把整个窗口吃光 */
export const MEMORY_MIN_KEEP_ROUNDS = 3
/**
 * 值得为它跑一次整理的最小量：低于这个数，整理一次要发好几个请求，
 * 换来的空间却很有限，界面不该在这种时候催「立即整理」。
 */
export const MIN_FOLDABLE_TOKENS = 50_000
/** 系统提示词、角色卡、记忆笔记与协议头的粗估占用 */
const SYSTEM_OVERHEAD_TOKENS = 500
/** 每条消息的角色标记与分隔符开销 */
const MESSAGE_OVERHEAD_TOKENS = 8
/** 图片按官方惯例折算；文档按原文件体积估（见 DOCUMENT_BYTES_PER_TOKEN） */
const IMAGE_TOKENS = 1024
/** 文档最小折算值，避免小文件被估成 0 */
const DOCUMENT_TOKENS = 2048
/**
 * 文档按原文件体积估 token：中文 UTF-8 约 3 字节/字、约 4 字节/token。
 * 实测 785 KB 的 txt 服务端算出 170,791 token，约 4.6 字节/token，
 * 取 4 略偏保守即可 —— 关键是别再拿 2048 打发，否则水位条显示 0% 却在发送时炸。
 */
const DOCUMENT_BYTES_PER_TOKEN = 4

/** 单个附件的粗估：图片按官方惯例；文档有实测/估算 token 就用它，否则按体积折算 */
export const estimateFileTokens = (file: {
  isImage: boolean
  size: number
  tokens?: number
}): number => {
  if (file.isImage) {
    return IMAGE_TOKENS
  }
  if (typeof file.tokens === 'number' && file.tokens > 0) {
    return file.tokens
  }
  return Math.max(DOCUMENT_TOKENS, Math.ceil(file.size / DOCUMENT_BYTES_PER_TOKEN))
}

/** 单条消息的粗估；历史思考块服务端会丢弃，不计入。 */
export const estimateMessageTokens = (message: Message): number => {
  if (message.role === 'user') {
    let tokens = estimateTextTokens(message.content) + MESSAGE_OVERHEAD_TOKENS
    for (const file of message.files) {
      tokens += estimateFileTokens(file)
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

/**
 * 把未折叠轮次切成「保留原文」与「可以折叠」两堆，规则与真正整理时完全一致：
 * 从尾部往前累加到 keepTokens 为止（至少 MEMORY_MIN_KEEP_ROUNDS 轮）；
 * 带附件的轮次只要不是最后一轮就优先折叠（附件块会跟着轮次每轮重发）。
 */
export const splitFoldableRounds = (
  rounds: [UserMessage, AssistantMessage][],
  keepTokens: number,
  keepCountOverride?: number
): { kept: [UserMessage, AssistantMessage][]; foldable: [UserMessage, AssistantMessage][] } => {
  let keepCount = keepCountOverride ?? 0
  if (keepCountOverride === undefined) {
    let used = 0
    for (let i = rounds.length - 1; i >= 0; i--) {
      const [user, reply] = rounds[i]
      used += estimateMessageTokens(user) + estimateMessageTokens(reply)
      keepCount += 1
      if (used >= keepTokens && keepCount >= MEMORY_MIN_KEEP_ROUNDS) {
        break
      }
    }
  }
  const keepFrom = Math.max(0, rounds.length - keepCount)
  const kept: [UserMessage, AssistantMessage][] = []
  const foldable: [UserMessage, AssistantMessage][] = []
  rounds.forEach((round, index) => {
    const hasFiles = round[0].files.length > 0 && index < rounds.length - 1
    if (index < keepFrom || hasFiles) {
      foldable.push(round)
    } else {
      kept.push(round)
    }
  })
  return { kept, foldable }
}

/** 这次整理大概能腾出多少 token：横幅与面板据此决定要不要劝用户整理 */
export const getFoldableTokens = (session: Session, keepTokens = MEMORY_KEEP_TOKENS): number => {
  const { foldable } = splitFoldableRounds(getUnfoldedRounds(session), keepTokens)
  return foldable.reduce(
    (sum, [user, reply]) => sum + estimateMessageTokens(user) + estimateMessageTokens(reply),
    0
  )
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
