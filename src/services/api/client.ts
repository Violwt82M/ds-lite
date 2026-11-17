import { translate, type TranslationMessage } from '../../i18n/index.js'
import { apiUrl, getApiOrigin, OFFICIAL_API_ORIGIN } from './base.js'
import { getCustomModel, usesOpenAiProtocol } from './protocol.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
} from './types.js'

/** 官方 API 地址，默认 https://api.deepseek.com；用户可在设置里换自定义地址 */
export const API_ORIGIN = OFFICIAL_API_ORIGIN
/** Anthropic 兼容接口的前缀（随自定义地址实时变化） */
const anthropicBase = () => apiUrl('/anthropic/v1')
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number,
    /** 出错的请求地址：排查「405 / 打到了别的服务」时靠它定位 */
    readonly url?: string
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText,
  url?: string
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message: string | TranslationMessage = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    } else if (typeof (body as { detail?: unknown }).detail === 'string') {
      // FastAPI 风格 { detail: "..." }：第三方兼容服务很常见，也要能读出来
      message = (body as { detail: string }).detail
    }
  } catch {
    // 返回 HTML 说明请求打到了网页而不是 API：多半是第三方中转/反代的地址。
    // 这类服务不在支持范围，直接给结论，不把整页 HTML 丢给用户。
    if (/^\s*<(!doctype|html|head|body)/i.test(text) || text.includes('<script')) {
      message = { key: 'errorNotApiEndpoint' }
    }
  }
  // 纯文本错误体也可能很长（nginx 整页堆栈），截断后再展示
  if (typeof message === 'string' && message.length > 400) {
    message = `${message.slice(0, 400)}…`
  }
  return new ApiError(kind, message, response.status, url)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response, 'http', response.statusText, url)
  }
  return response
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** OpenAI 兼容服务的接口根：容忍用户把 /v1 或完整 /chat/completions 贴进来 */
const openAiRoot = () =>
  getApiOrigin()
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/v1$/i, '')

const openAiUrl = (tail: string) => `${openAiRoot()}${tail}`

/** OpenAI 兼容协议的鉴权头 */
const openAiHeaders = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
})

/**
 * 内部请求体 → OpenAI chat/completions 的 body。
 * 只映射纯文本：附件、工具、标题、审查在 OpenAI 通道都不支持（见 protocol.ts 的说明），
 * 这些字段在这里直接丢弃，不要假装发过去。
 */
const openAiBody = (body: CreateMessageRequest) => {
  const messages: { role: string; content: string }[] = []
  if (body.system?.trim()) {
    messages.push({ role: 'system', content: body.system })
  }
  for (const message of body.messages) {
    const text =
      typeof message.content === 'string'
        ? message.content
        : message.content
            .map((block) => (block.type === 'text' ? block.text : ''))
            .filter(Boolean)
            .join('\n')
    if (text.trim() === '') {
      continue
    }
    messages.push({ role: message.role === 'latest_reminder' ? 'user' : message.role, content: text })
  }
  return { model: getCustomModel(), messages, stream: true }
}

/** 用 GET /models 校验 API Key（不产生费用）；两种协议各自的路由 */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  const url = usesOpenAiProtocol() ? openAiUrl('/v1/models') : apiUrl('/models')
  await request(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

type OpenAiChunk = {
  id?: string
  model?: string
  choices?: {
    delta?: { content?: string | null }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

const mapFinishReason = (reason: string | null | undefined): StopReason => {
  if (reason === 'length') {
    return 'max_tokens'
  }
  if (reason === 'content_filter') {
    return 'refusal'
  }
  if (reason === 'tool_calls') {
    return 'tool_use'
  }
  return 'end_turn'
}

/**
 * OpenAI 的 SSE → 内部 MessageStreamEvent。
 * 契约（parseEvent / reply.applyEvent 要求）：先 message_start，再 text 块的 start/delta/stop，
 * 最后 message_delta + message_stop；否则上层会当成「断流」。
 */
async function* streamOpenAi(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const url = openAiUrl('/v1/chat/completions')
  const response = await request(url, {
    method: 'POST',
    headers: { ...openAiHeaders(apiKey), Accept: 'text/event-stream' },
    body: JSON.stringify(openAiBody(body)),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !/text\/event-stream/i.test(contentType)) {
    throw await readErrorResponse(response, 'protocol', '', url)
  }
  let started = false
  let textOpen = false
  let stopReason: StopReason = 'end_turn'
  let usage: MessageUsage | undefined
  for await (const { data } of readServerSentEvents(response.body, signal)) {
    if (data === '[DONE]') {
      break
    }
    let chunk: OpenAiChunk
    try {
      chunk = JSON.parse(data) as OpenAiChunk
    } catch {
      continue
    }
    if (!started) {
      started = true
      yield {
        type: 'message_start',
        message: { id: String(chunk.id ?? `openai-${Date.now()}`), model: String(chunk.model ?? getCustomModel()) },
      }
    }
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: chunk.usage.completion_tokens ?? 0,
      }
    }
    const choice = chunk.choices?.[0]
    const text = typeof choice?.delta?.content === 'string' ? choice.delta.content : ''
    if (text !== '') {
      if (!textOpen) {
        textOpen = true
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
    }
    if (choice?.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason)
    }
  }
  // 空流也要补 start/stop，否则上层抛 interrupted（openai 兼容服务偶尔只回 [DONE]）
  if (!started) {
    yield { type: 'message_start', message: { id: `openai-${Date.now()}`, model: getCustomModel() } }
  }
  if (textOpen) {
    yield { type: 'content_block_stop', index: 0 }
  }
  yield { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, ...(usage ? { usage } : {}) }
  yield { type: 'message_stop' }
}

/** 余额里的一个币种条目（官方返回的是字符串金额） */
export type BalanceInfo = {
  currency: string
  /** 总余额 */
  total: string
  /** 赠送部分 */
  granted: string
  /** 充值部分 */
  toppedUp: string
}

export type BalanceResult = {
  /** 账户是否可用：余额不足时官方返回 false */
  available: boolean
  infos: BalanceInfo[]
}

/**
 * GET /user/balance：查真实余额（官方按次免费，不消耗 token）。
 * 第三方兼容服务可能没实现这个接口，调用方要把失败当成「查不到」而不是致命错误。
 */
export const fetchBalance = async (
  apiKey: string,
  signal?: AbortSignal
): Promise<BalanceResult> => {
  const response = await request(apiUrl('/user/balance'), {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  const body: unknown = await response.json()
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  const list = Array.isArray(record.balance_infos) ? record.balance_infos : []
  const text = (value: unknown) => (typeof value === 'string' ? value : String(value ?? ''))
  return {
    available: record.is_available !== false,
    infos: list.flatMap((item): BalanceInfo[] => {
      if (typeof item !== 'object' || item === null) {
        return []
      }
      const entry = item as Record<string, unknown>
      return [
        {
          currency: text(entry.currency) || 'CNY',
          total: text(entry.total_balance),
          granted: text(entry.granted_balance),
          toppedUp: text(entry.topped_up_balance),
        },
      ]
    }),
  }
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${anthropicBase()}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${anthropicBase()}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  // 自定义地址 + OpenAI 协议：走适配器，内部事件契约不变，上层一行不用改
  if (usesOpenAiProtocol()) {
    yield* streamOpenAi(apiKey, body, signal)
    return
  }
  const response = await request(`${anthropicBase()}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '', `${anthropicBase()}/messages`)
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
