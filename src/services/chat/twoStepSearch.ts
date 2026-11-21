import { streamMessage } from '../api/client.js'
import type { ChatModel, MessageParam, ServerToolBlock } from '../api/types.js'
import { buildRequest } from './request.js'
import type { AssistantMessage, Message, UserMessage } from './types.js'

const MAX_HISTORY_TURNS = 3
const MAX_HISTORY_TEXT_CHARS = 1_200
const MAX_QUESTION_CHARS = 3_000
const MAX_SUMMARY_CHARS = 6_000

const STEP1_SYSTEM_PROMPT = `你是一个联网检索助手。用户当前处于长上下文或携带大附件的对话中，请你根据最近的对话背景和当前提问：
1. 提炼最准确的搜索关键词，调用联网搜索或阅读链接工具获取最新、可靠的事实信息；
2. 用简明、客观的中文整理出「联网检索参考摘要」（列出关键事实、时间、数据与来源标题/链接）；
3. 只提供事实检索摘要，不要扮演人设，也不要编造未检索到的信息。`

const clip = (text: string, max: number): string => {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

const assistantPlainText = (message: AssistantMessage): string =>
  message.blocks
    .filter((block) => block.type === 'text' && !block.isTemplate)
    .map((block) => (block.type === 'text' ? block.text.trim() : ''))
    .filter(Boolean)
    .join('\n')

const buildStep1Messages = (
  history: Message[],
  question: UserMessage,
  latestReminder: string
): MessageParam[] => {
  const recent = history.slice(-MAX_HISTORY_TURNS * 2)
  const messages: MessageParam[] = []
  for (const item of recent) {
    if (item.role === 'user') {
      const fileHint =
        item.files.length > 0
          ? `[附件：${item.files.map((f) => f.displayName || f.name).join('、')}]\n`
          : ''
      const content = clip(`${fileHint}${item.content}`, MAX_HISTORY_TEXT_CHARS)
      if (content) {
        messages.push({ role: 'user', content })
      }
    } else {
      const content = clip(assistantPlainText(item), MAX_HISTORY_TEXT_CHARS)
      if (content) {
        messages.push({ role: 'assistant', content: [{ type: 'text', text: content }] })
      }
    }
  }
  const currentFileHint =
    question.files.length > 0
      ? `[本轮附件：${question.files.map((f) => f.displayName || f.name).join('、')}]\n`
      : ''
  const questionBody = clip(`${currentFileHint}${question.content}`, MAX_QUESTION_CHARS) || '请帮我检索相关最新资料。'
  // latest_reminder 必须紧挨在 user 之前（服务端硬要求，放后面会 400）
  if (latestReminder) {
    messages.push({ role: 'latest_reminder', content: latestReminder })
  }
  messages.push({ role: 'user', content: questionBody })
  return messages
}

export type TwoStepSearchResult = {
  /** 注入第二步主模型 system 的检索摘要 */
  summary: string
  /** 第一步是否实际触发了搜索或阅读链接工具 */
  usedTools: boolean
}

/**
 * 联网搜索「两步法」第一步：
 * 用精简上下文（不含历史大附件，确保远低于服务端 32768 token 的扩展模式上限）
 * 调用联网搜索 / 阅读链接工具，实时把工具块透传给界面，并汇总事实摘要交给第二步主请求。
 * 第二步主请求走标准模式（1M 上下文上限），完整保留全部长对话与附件。
 */
export const runTwoStepSearch = async (options: {
  apiKey: string
  model: ChatModel
  history: Message[]
  question: UserMessage
  latestReminder: string
  search: boolean
  signal: AbortSignal
  onToolBlock: (block: ServerToolBlock) => void
}): Promise<TwoStepSearchResult | null> => {
  const { apiKey, model, history, question, latestReminder, search, signal, onToolBlock } = options
  const messages = buildStep1Messages(history, question, latestReminder)
  const built = buildRequest({
    model,
    system: STEP1_SYSTEM_PROMPT,
    messages,
    questionText: clip(question.content, MAX_QUESTION_CHARS),
    search,
    safety: 'low',
    thinking: false,
    wantTitle: false,
    inputTokens: 0,
    forceStandard: false,
  })
  if (built.body.tools.length === 0) {
    return null
  }

  let usedTools = false
  let textSummary = ''
  const snippets: string[] = []

  const events = streamMessage(apiKey, built.body, signal)
  for await (const event of events) {
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (
        block.type === 'server_tool_use' ||
        block.type === 'web_search_tool_result' ||
        block.type === 'web_fetch_tool_result'
      ) {
        usedTools = true
        onToolBlock(block)
        if (block.type === 'web_search_tool_result') {
          for (const item of block.content) {
            if (item.type === 'web_search_result') {
              const age = item.page_age ? ` (${item.page_age.slice(0, 10)})` : ''
              snippets.push(`- ${item.title}${age}: ${item.snippet} [${item.url}]`)
            }
          }
        }
      } else if (block.type === 'text' && block.text) {
        textSummary += block.text
      }
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      textSummary += event.delta.text
    }
  }

  const trimmedSummary = textSummary.trim()
  const combinedParts: string[] = []
  if (trimmedSummary) {
    combinedParts.push(trimmedSummary)
  }
  if (snippets.length > 0 && trimmedSummary.length < 300) {
    combinedParts.push(`原始检索条目：\n${snippets.slice(0, 10).join('\n')}`)
  }
  const summary = clip(combinedParts.join('\n\n'), MAX_SUMMARY_CHARS)
  if (!summary && !usedTools) {
    return null
  }
  return { summary, usedTools }
}
