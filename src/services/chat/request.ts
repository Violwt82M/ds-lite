import type { ChatModel, CreateMessageRequest, MessageParam } from '../api/types.js'
import { sanitizeSurrogates } from '../../utils/safeText.js'

/**
 * 服务端「扩展模式」的输入上限：32768 token（约 5 万字）。
 *
 * 判定扩展模式的条件不是「用户点了什么」，而是「请求体里有没有扩展字段」：
 * 声明了 deepseek_read_url / deepseek_web_search、safety_check.level 为 high、
 * 或者带了 title 请求，任意一个成立就把输入上限从 1M 砍到 32768。
 * 实测（2026-11-16）：同一份 76k token 的文档，只加 title 请求就 400，去掉就 200。
 *
 * 所以「构造请求」必须只有一个出口，否则每加一个字段就会悄悄把上限砍掉一次。
 */
export const EXTENDED_INPUT_LIMIT_TOKENS = 30_000

/** 本轮提问里是否带链接：只有带链接才需要阅读链接工具 */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/i

export type SafetyLevel = 'low' | 'high'

export type BuildRequestOptions = {
  model: ChatModel
  system: string
  messages: MessageParam[]
  /** 本轮提问正文，用来判断要不要声明阅读链接工具 */
  questionText?: string
  /** 用户是否开了智能搜索 */
  search?: boolean
  /** 设置里的内容审查等级 */
  safety?: SafetyLevel
  thinking?: boolean
  effort?: 'low' | 'high' | 'max'
  /** 本轮是否要向服务端要会话标题 */
  wantTitle?: boolean
  /** 本轮请求的估算输入 token（历史 + 提问 + 附件展开） */
  inputTokens?: number
  /** 上一次已经撞过 32768 的墙，强制标准模式重发 */
  forceStandard?: boolean
}

export type BuiltRequest = {
  body: CreateMessageRequest
  /** 因为输入过长，本轮放弃了工具 / 严格审查 / 服务端标题，界面需要提示 */
  degraded: boolean
  /** 是否真的向服务端要了标题（长输入时为 false，调用方自行兜一个本地标题） */
  titleRequested: boolean
}

/**
 * 内部请求的固定字段（整理记忆、生成概述、生成记录都用它）：
 * 不声明工具、不请求标题、审查用默认档 —— 三者任一都会把输入上限砍到 32768 token。
 */
export const STANDARD_MODE = {
  thinking: { type: 'disabled' as const },
  tools: [] as CreateMessageRequest['tools'],
  safety_check: { level: 'low' as const },
}

/** 内部请求（整理记忆、生成记录）：不带任何扩展字段，永远标准模式 */
export const buildInternalRequest = (options: {
  model: ChatModel
  system: string
  messages: MessageParam[]
}): { body: CreateMessageRequest } => ({ body: buildRequest(options).body })

/** 孤立代理会让服务端 JSON 解析直接 400，所有字符串出口都过一遍 */
const cleanMessages = (messages: MessageParam[]): MessageParam[] =>
  messages.map((message) => {
    // latest_reminder 的 content 一定是字符串，单独处理保持联合类型收窄
    if (message.role === 'latest_reminder') {
      return { role: 'latest_reminder' as const, content: sanitizeSurrogates(message.content) }
    }
    const { content } = message
    const cleaned =
      typeof content === 'string'
        ? sanitizeSurrogates(content)
        : content.map((block) =>
            block.type === 'text' ? { ...block, text: sanitizeSurrogates(block.text) } : block
          )
    return { ...message, content: cleaned } as MessageParam
  })

/**
 * 唯一的 CreateMessageRequest 构造出口。
 *
 * 内部请求（整理记忆、生成记录）也用这个函数，不要传 tools / title，
 * 保持标准的「纯文本 → 纯文本」形态即可。
 */
export const buildRequest = (options: BuildRequestOptions): BuiltRequest => {
  const {
    model,
    system,
    messages,
    questionText = '',
    search = false,
    safety = 'low',
    thinking = false,
    effort,
    wantTitle = false,
    inputTokens = 0,
    forceStandard = false,
  } = options

  const hasUrl = URL_PATTERN.test(questionText)
  /** 只要出现任意扩展字段，本轮就落进 32768 token 的小房间 */
  const wantsExtended = search || safety === 'high' || hasUrl
  const tooLong = inputTokens > EXTENDED_INPUT_LIMIT_TOKENS
  /** 长输入一律标准模式：扩展能力全部让位，否则请求必被拒 */
  const standardOnly = tooLong || forceStandard

  const tools: CreateMessageRequest['tools'] = []
  if (!standardOnly) {
    if (hasUrl) {
      tools.push({ type: 'deepseek_read_url', name: 'deepseek_read_url' })
    }
    if (search) {
      tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
    }
  }

  const body: CreateMessageRequest = {
    model,
    system: sanitizeSurrogates(system),
    messages: cleanMessages(messages),
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    ...(thinking && effort ? { output_config: { effort } } : {}),
    safety_check: { level: standardOnly ? 'low' : safety },
    tools,
    ...(wantTitle && !standardOnly ? { title: { enabled: true } } : {}),
  }

  return { body, degraded: tooLong && wantsExtended, titleRequested: wantTitle && !standardOnly }
}
