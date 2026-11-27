import { filterStreamChunk, flushStreamPending } from '../../utils/specialTokens.js'
import { normalizeLatestReminder } from './latestReminder.js'
import type {
  AssistantBlockParam,
  FileBlockParam,
  MessageParam,
  MessageStreamEvent,
  OutputBlockStart,
  TextBlockParam,
} from '../api/types.js'
import type {
  AssistantMessage,
  FileAttachment,
  Message,
  ReplyBlock,
  ReplyStatus,
  UserMessage,
} from './types.js'

/**
 * 文件按 Files API 的 file_id（附件的 serverId）引用：图片用 image 块，其余用 document 块。
 * 发送前 streamReply 会先补齐 serverId；仍为 null 的是本地没有原件的附件，不进入请求。
 */
const toFileBlocks = (files: FileAttachment[]): FileBlockParam[] =>
  files.flatMap(({ serverId, isImage }) =>
    serverId
      ? [
          {
            type: isImage ? 'image' : 'document',
            source: { type: 'file', file_id: serverId },
          },
        ]
      : []
  )

const toReplyBlock = (block: OutputBlockStart, now: number): ReplyBlock | null => {
  switch (block.type) {
    case 'text': {
      // 首块正文也可能带标记；和增量走同一套流式过滤，pending 留给后续 delta
      const chunk = filterStreamChunk('', block.text)
      return {
        type: 'text',
        text: chunk.text,
        citations: block.citations ?? [],
        ...(chunk.pending ? { pendingText: chunk.pending } : {}),
      }
    }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
        startedAt: now,
      }
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
      return block
    default:
      return null
  }
}

const updateBlock = (
  reply: AssistantMessage,
  index: number,
  update: (block: ReplyBlock) => ReplyBlock
): AssistantMessage => {
  const block = reply.blocks[index]
  if (!block) {
    return reply
  }
  const blocks = [...reply.blocks]
  blocks[index] = update(block)
  return { ...reply, blocks }
}

/**
 * 把一个流式事件合并进回复：只追加可识别的内容块，用本次请求的临时索引映射处理增量。
 * 跳过的块不占位；续写直接追加到已有内容之后，message_delta 更新结束原因与累计用量。
 */
const mergeUsage = (
  prev: AssistantMessage['usage'],
  incoming: AssistantMessage['usage']
): AssistantMessage['usage'] => {
  if (!incoming) {
    return prev
  }
  if (!prev) {
    return incoming
  }
  const hasInput =
    incoming.input_tokens > 0 ||
    incoming.cache_creation_input_tokens > 0 ||
    incoming.cache_read_input_tokens > 0
  return {
    input_tokens: hasInput ? incoming.input_tokens : prev.input_tokens,
    cache_creation_input_tokens: hasInput
      ? incoming.cache_creation_input_tokens
      : prev.cache_creation_input_tokens,
    cache_read_input_tokens: hasInput ? incoming.cache_read_input_tokens : prev.cache_read_input_tokens,
    output_tokens: incoming.output_tokens > 0 ? incoming.output_tokens : prev.output_tokens,
  }
}

export const applyEvent = (
  reply: AssistantMessage,
  event: MessageStreamEvent,
  now: number,
  blockIndexes: Map<number, number>
): AssistantMessage => {
  const next: AssistantMessage =
    reply.status === 'streaming' ? reply : { ...reply, status: 'streaming' }
  switch (event.type) {
    case 'message_start':
      return { ...next, usage: mergeUsage(next.usage, event.message.usage) }
    case 'content_block_start': {
      blockIndexes.delete(event.index)
      const block = toReplyBlock(event.content_block, now)
      if (!block) {
        // 客户端工具内容不保存；未完成的工具往返也不能作为续写前缀。
        return event.content_block.type === 'tool_use' ? { ...next, prefix: false } : next
      }
      blockIndexes.set(event.index, next.blocks.length)
      return { ...next, blocks: [...next.blocks, block] }
    }
    case 'content_block_delta': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      const { delta } = event
      return updateBlock(next, index, (block) => {
        if (block.type === 'text' && delta.type === 'text_delta') {
          // 流式安全过滤：标记可能被切在两个 delta 之间，尾部可疑前缀先缓冲（见 utils/specialTokens.ts）
          const chunk = filterStreamChunk(block.pendingText ?? '', delta.text)
          return {
            ...block,
            text: block.text + chunk.text,
            pendingText: chunk.pending === '' ? undefined : chunk.pending,
          }
        }
        if (block.type === 'thinking' && delta.type === 'thinking_delta') {
          return { ...block, thinking: block.thinking + delta.thinking }
        }
        if (block.type === 'thinking' && delta.type === 'signature_delta') {
          return { ...block, signature: (block.signature ?? '') + delta.signature }
        }
        if (block.type === 'text' && delta.type === 'citations_delta') {
          return { ...block, citations: [...(block.citations ?? []), delta.citation] }
        }
        return block
      })
    }
    case 'content_block_stop': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      blockIndexes.delete(event.index)
      return updateBlock(next, index, (block) => {
        // 块结束时把缓冲的尾巴收掉：半截标记直接丢，不显示也不进库
        if (block.type === 'text' && block.pendingText !== undefined) {
          return { ...block, text: block.text + flushStreamPending(block.pendingText), pendingText: undefined }
        }
        return block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
          ? { ...block, endedAt: now }
          : block
      })
    }
    case 'message_delta':
      return {
        ...next,
        stopReason: event.delta.stop_reason,
        stopDetails: event.delta.stop_details,
        usage: mergeUsage(next.usage, event.usage),
      }
    default:
      return next
  }
}

/**
 * 回复结束：未结束的思考块以当前时间收尾。
 * 安全拒绝（stop_reason: refusal）时已下发的思考与正文不能撤回，按协议要求由客户端丢弃，只保留工具块。
 */
export const settleReply = (
  reply: AssistantMessage,
  status: Extract<ReplyStatus, 'done' | 'stopped' | 'error'>,
  now: number,
  error?: AssistantMessage['error']
): AssistantMessage => ({
  ...reply,
  status,
  error,
  blocks: reply.blocks.flatMap((block): ReplyBlock[] => {
    if (reply.stopReason === 'refusal' && (block.type === 'thinking' || block.type === 'text')) {
      return []
    }
    // 收尾兜底：异常/中止时可能没收到 content_block_stop，缓冲的正文尾巴在这里吐掉
    if (block.type === 'text' && block.pendingText !== undefined) {
      return [
        { ...block, text: block.text + flushStreamPending(block.pendingText), pendingText: undefined },
      ]
    }
    return block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
      ? [{ ...block, endedAt: now }]
      : [block]
  }),
})

/** 回复里所有文本块拼起来，用于复制与判断是否有回答 */
export const getReplyText = (reply: AssistantMessage) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

/**
 * 只有正常达到输出上限或被停止的回复可续写，报错回复不能续写。
 * 末条限制由调用方判断，拒绝和客户端工具调用不能续写。
 * 本轮含服务端工具调用或结果（含 READ_LINK 和孤立结果块）的回复不能续写。
 * 服务端模板提示不能作为续写前缀。
 */
export const canContinueReply = (reply: AssistantMessage): boolean => {
  if (
    !reply.prefix ||
    reply.stopReason === 'refusal' ||
    reply.stopReason === 'tool_use' ||
    reply.blocks.some(
      (block) =>
        block.type === 'server_tool_use' ||
        block.type === 'web_search_tool_result' ||
        block.type === 'web_fetch_tool_result' ||
        (block.type === 'text' && block.isTemplate)
    )
  ) {
    return false
  }
  return (
    reply.status === 'stopped' ||
    (reply.status === 'done' && reply.stopReason === 'max_tokens')
  )
}

/**
 * 已结束或停止且有回答文本的回复才放进上下文；被安全拒绝的轮次不回传。
 * 服务端模板提示不进入上下文。
 */
const isUsableReply = (message: Message): message is AssistantMessage =>
  message.role === 'assistant' &&
  (message.status === 'done' || message.status === 'stopped') &&
  message.stopReason !== 'refusal' &&
  !message.blocks.some((block) => block.type === 'text' && block.isTemplate) &&
  getReplyText(message) !== ''

/**
 * 有文件时用内容块数组：先文件后文本，文件按 Files API 的 file_id 引用。
 * textOnly（v4 pro）时丢掉图片块：该模型不支持图像理解，带图会被服务端整轮拒绝。
 */
const toUserParam = ({ content, files }: UserMessage, textOnly = false): MessageParam => {
  const blocks = toFileBlocks(textOnly ? files.filter((file) => !file.isImage) : files)
  return blocks.length === 0
    ? { role: 'user', content }
    : {
        role: 'user',
        content: [...blocks, ...(content ? [{ type: 'text' as const, text: content }] : [])],
      }
}

/**
 * assistant 的内容块按历史与续写场景转换：
 * - 历史思考及其签名不回传；开启思考时续写只保留本轮非空白思考及其签名；
 * - 文本块去掉 citations（服务端忽略）。相邻文本直接拼接，被思考或工具隔开的文本用空行连接；
 *   省略历史思考后仍保留其前后正文的空行；
 * - 工具调用和结果只保留 kind 为 read_link 的块，其他历史工具块不回传；
 * - 阅读链接结果原样回传，保留 signature：服务端解密后将页面拼回该轮提问末尾；
 */
const toAssistantParam = (
  { blocks }: AssistantMessage,
  prefix = false,
  thinking = false
): Extract<MessageParam, { role: 'assistant' }> => {
  const content: AssistantBlockParam[] = []
  // 成功阅读的网页靠签名恢复正文；缺少有效签名时，调用与结果都不回传。
  const unsignedReadLinks = new Set(
    blocks.flatMap((block) =>
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      block.content.type === 'web_fetch_result' &&
      !block.signature?.trim()
        ? [block.tool_use_id]
        : []
    )
  )
  /** 正在拼接的文本块；遇到任何非文本块（含不回传的思考块）就结束 */
  let text: TextBlockParam | null = null
  for (const block of blocks) {
    // 空思考不改变续写位置，也不应把两段正文隔开，导致后端额外插入空行。
    if (prefix && block.type === 'thinking' && !block.thinking.trim()) {
      continue
    }
    if (block.type === 'text') {
      if (text) {
        text.text += block.text
      } else {
        const previous = content.at(-1)
        text = {
          type: 'text',
          text: `${previous?.type === 'text' ? '\n\n' : ''}${block.text}`,
        }
        content.push(text)
      }
      continue
    }
    text = null
    if (prefix && thinking && block.type === 'thinking') {
      // 续写保留本轮思考，历史轮次的思考省略。
      const { type, thinking, signature } = block
      content.push({ type, thinking, signature: signature ?? '' })
    } else if (
      block.type === 'server_tool_use' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(block.id)
    ) {
      const { type, id, name, input, kind } = block
      content.push({ type, id, name, input, kind })
    } else if (
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(block.tool_use_id)
    ) {
      content.push(block)
    }
  }
  return {
    role: 'assistant',
    content: content.filter((block) => block.type !== 'text' || block.text !== ''),
  }
}

/** 历史中会进入请求上下文的轮次：提问后紧跟可用回答的才保留 */
export const getContextRounds = (history: Message[]): [UserMessage, AssistantMessage][] => {
  const rounds: [UserMessage, AssistantMessage][] = []
  for (let i = 0; i + 1 < history.length; i++) {
    const [user, reply] = [history[i], history[i + 1]]
    if (user.role === 'user' && isUsableReply(reply)) {
      rounds.push([user, reply])
      i++
    }
  }
  return rounds
}

/**
 * 单次请求中携带的历史图片总大小安全上限（200MB）。
 * 从最新轮次往前累计，超出上限的较早历史图片在本次请求中自动略去（绝不删除本地原图），
 * 避免老会话里累积过多未压缩大图导致服务端报 400 total size of image。
 */
export const MAX_REQUEST_IMAGE_BYTES = 200 * 1024 * 1024

/**
 * 把会话转成请求的 messages：只保留「提问 + 有回答的回复」成对的轮次，最后接上本轮提问。
 * 失败或没有回答的轮次不进上下文。续写时末尾再带上本轮 assistant。
 */
export const toRequestMessages = (
  history: Message[],
  question: UserMessage,
  prefix?: AssistantMessage,
  thinking = prefix?.thinking ?? false,
  latestReminder?: string,
  /** 已折叠进记忆的回答消息 id：原文仍在本机，但不再进入请求上下文 */
  folded?: ReadonlySet<string>,
  /** 只发文字附件（v4 pro 不支持图片） */
  textOnly = false,
  /** v4 pro 不支持 latest_reminder：跳过所有提醒消息（时间信息改由 system 携带） */
  dropReminder = false,
  /** 单次请求允许携带的图片总字节预算（默认 200MB；0 表示仅保留本轮提问图片、略去所有历史老图） */
  maxImageBytes: number = MAX_REQUEST_IMAGE_BYTES
): MessageParam[] => {
  const rounds = getContextRounds(history)
  // 从最新到最旧计算允许带入本次请求的历史图片 id：本轮 question 的图片永远优先计入
  const allowedHistoryImages = new Set<string>()
  if (!textOnly && maxImageBytes > 0) {
    let usedImageBytes = 0
    for (const file of question.files) {
      if (file.isImage && file.serverId) {
        usedImageBytes += Math.max(0, file.size)
      }
    }
    for (let i = rounds.length - 1; i >= 0; i -= 1) {
      const [user, reply] = rounds[i]
      if (folded?.has(reply.id)) {
        continue
      }
      for (let j = user.files.length - 1; j >= 0; j -= 1) {
        const file = user.files[j]
        if (!file.isImage || !file.serverId) {
          continue
        }
        const size = Math.max(0, file.size)
        if (usedImageBytes + size <= maxImageBytes) {
          usedImageBytes += size
          allowedHistoryImages.add(file.id)
        }
      }
    }
  }
  const filterHistoryUser = (user: UserMessage): UserMessage => {
    if (textOnly || user.files.every((f) => !f.isImage || allowedHistoryImages.has(f.id))) {
      return user
    }
    return {
      ...user,
      files: user.files.filter((f) => !f.isImage || allowedHistoryImages.has(f.id)),
    }
  }
  const messages: MessageParam[] = []
  let previousReminder: string | undefined
  const appendReminder = (reminder: string | undefined) => {
    // 仅在当前分支首次出现或内容变化时插入快照；格式不合规的历史坏快照静默丢弃，避免触发 400。
    const normalized = normalizeLatestReminder(reminder)
    if (dropReminder || !normalized || normalized === previousReminder) {
      return
    }
    messages.push({ role: 'latest_reminder', content: normalized })
    previousReminder = normalized
  }
  for (const [rawUser, reply] of rounds) {
    if (folded?.has(reply.id)) {
      continue
    }
    const user = filterHistoryUser(rawUser)
    // 历史提问没有文字、附件也都没有 serverId（或图片被预算略去）时，提问为空，连同回答一起省略。
    if (!user.content && toFileBlocks(textOnly ? user.files.filter((f) => !f.isImage) : user.files).length === 0) {
      continue
    }
    appendReminder(reply.latestReminder)
    messages.push(toUserParam(user, textOnly), toAssistantParam(reply))
  }
  appendReminder(latestReminder)
  messages.push(toUserParam(question, textOnly))
  if (prefix?.prefix) {
    const assistant = toAssistantParam(prefix, true, thinking)
    // 没有非空白正文或有效思考时直接重发原问题，避免服务端拒绝空 Prefill。
    if (
      assistant.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim()) ||
          (block.type === 'thinking' && block.thinking.trim())
      )
    ) {
      messages.push(assistant)
    }
  }
  return messages
}

/** 思考用时（秒），至少 1 秒 */
export const getThinkingSeconds = (startedAt: number, endedAt: number) =>
  Math.max(1, Math.round((endedAt - startedAt) / 1000))

/** 单条回复重新生成时的「这一次」篇幅提示（附在最后一条 user 消息尾部，不改 system 以保前缀缓存） */
export const formatTurnLengthHint = (
  override: 'detailed' | 'concise',
  locale: 'zh-CN' | 'en-US'
): string => {
  if (override === 'detailed') {
    return locale === 'en-US'
      ? '[One-turn length hint: Please elaborate in noticeably greater detail and depth for this reply only.]'
      : '[本轮篇幅提示: 仅针对这一次回复，请展开得更详尽充分、多保留细节与铺陈。]'
  }
  return locale === 'en-US'
    ? '[One-turn length hint: Please keep this reply noticeably more concise and direct for this turn only.]'
    : '[本轮篇幅提示: 仅针对这一次回复，请更精简凝练、直奔重点。]'
}

/**
 * 将本轮临时尾部附注（如静默时钟标记、单次篇幅覆盖提示）追加到最后一条 user 消息末尾；
 * 返回新数组，不修改原消息对象与 system 提示词，保证前缀缓存不受影响。
 */
export const appendUserTailNotes = (
  messages: MessageParam[],
  notes: readonly string[]
): MessageParam[] => {
  const valid = notes.map((item) => item.trim()).filter(Boolean)
  if (valid.length === 0) {
    return messages
  }
  const suffix = `\n\n${valid.join('\n')}`
  const next = [...messages]
  for (let idx = next.length - 1; idx >= 0; idx -= 1) {
    const msg = next[idx]
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        next[idx] = { ...msg, content: `${msg.content}${suffix}` }
      } else {
        next[idx] = {
          ...msg,
          content: [...msg.content, { type: 'text', text: suffix }],
        }
      }
      break
    }
  }
  return next
}
