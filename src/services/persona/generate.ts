import { streamMessage } from '../api/client.js'
import { isCustomApiOrigin } from '../api/base.js'
import { buildRequest } from '../chat/request.js'
import { useSettings } from '../settings.js'
import { parsePersonaJson, type PersonaCard } from './card.js'

/**
 * AI 写角色卡（0.9.36）。
 *
 * 两段式，原因是「智能搜索」会把本轮请求推进扩展模式（输入上限掉到 32,768 token），
 * 而且要模型在搜索的同时稳定输出 JSON 是不可靠的：
 *   第一段：开 search，让模型联网核实角色公开资料，写成一份资料摘要；
 *   第二段：关 search（回到标准模式），把摘要喂回去，只要 JSON 角色卡。
 *
 * 产出永远是**草稿**：调用方把它塞进 PersonaEditor，用户改完点保存才入库。
 * 模型用用户当前设置（自定义 API 地址时强制 flash，和记录/记忆生成保持一致）。
 */

export type PersonaBrief = {
  name: string
  /** 出处作品；留空表示原创角色 */
  source?: string
  gender?: string
  age?: string
  identity?: string
  personality?: string
  style?: string
  scenario?: string
  relation?: string
  extra?: string
}

export type GenerateOutcome =
  | { ok: true; card: PersonaCard; searched: boolean; raw: string }
  | { ok: false; reason: 'nokey' | 'empty' | 'parse' | 'aborted' | 'failed'; raw?: string; detail?: string }

const MODEL_TIMEOUT_MS = 120_000

const briefBlock = (brief: PersonaBrief): string => {
  const lines = [
    `角色名：${brief.name.trim()}`,
    brief.source?.trim() ? `出处作品：${brief.source.trim()}` : '出处作品：（原创角色，无公开资料）',
    brief.gender?.trim() ? `性别：${brief.gender.trim()}` : '',
    brief.age?.trim() ? `年龄：${brief.age.trim()}` : '',
    brief.identity?.trim() ? `身份 / 职业：${brief.identity.trim()}` : '',
    brief.personality?.trim() ? `性格关键词：${brief.personality.trim()}` : '',
    brief.style?.trim() ? `说话风格：${brief.style.trim()}` : '',
    brief.scenario?.trim() ? `世界观 / 场景：${brief.scenario.trim()}` : '',
    brief.relation?.trim() ? `与用户的关系：${brief.relation.trim()}` : '',
    brief.extra?.trim() ? `额外要求：${brief.extra.trim()}` : '',
  ]
  return lines.filter((line) => line !== '').join('\n')
}

/** 第一段：联网核实 + 写资料摘要 */
const RESEARCH_SYSTEM = `你是角色设定资料整理员。用户要为一个角色扮演客户端生成角色卡，你先负责把资料查准。

要求：
1. 如果这个角色出自公开作品，用联网搜索核实：身份、性格、说话风格、与其他角色的关系、常用场景。搜不到的就明确写「资料不足」，不要编造。
2. 如果是原创角色（没有出处作品），就根据用户给的信息合理补全，并标明这是补全的内容。
3. 输出一份不超过 800 字的资料摘要，分四段：【基本设定】【性格与说话风格】【人物关系】【可用场景】。
4. 只输出摘要正文，不要开场白，不要说明你在搜索。`

/** 第二段：只要 JSON；字段名必须和客户端解析器一致 */
const cardSystem = (name: string) => `你是角色卡编写器。根据给你的角色资料，输出**一份**角色卡 JSON。

严格按这个结构（酒馆 v2 格式）：
{
  "spec": "chara_card_v2",
  "spec_version": "2.0",
  "data": {
    "name": "角色名",
    "description": "身份与背景，200-400 字",
    "personality": "性格，100-200 字",
    "style": "说话风格：口癖、句式、称呼方式，100-200 字",
    "rules": "行为准则：不会做什么、底线，100 字以内",
    "behavior": "私密互动与行为模式，100 字以内",
    "scenario": "场景与世界观，100 字以内",
    "first_mes": "开场白，一到两段，用角色口吻",
    "mes_example": "一到两组对话示例，用「{{user}}：」「{{char}}：」开头",
    "system_prompt": "角色扮演总纲，三到五条，说明如何保持角色"
  }
}

硬性要求：
- 只输出 JSON，不要代码块标记，不要任何解释或前后缀。
- 所有字段都要有内容，不要留空，不要用 null。
- 不要复述资料摘要，把它变成角色卡的语言。
- 名字必须严格是：${name}`

/** 从模型输出里抠出 JSON：允许包在代码块里，也允许前后有闲话 */
const extractJson = (text: string): string | null => {
  const withoutFence = text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim()
  const start = withoutFence.indexOf('{')
  const end = withoutFence.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return null
  }
  return withoutFence.slice(start, end + 1)
}

type StreamResult = { text: string; searched: boolean }

const runStream = async (
  system: string,
  user: string,
  search: boolean,
  signal: AbortSignal
): Promise<StreamResult> => {
  const { apiKey, model } = useSettings.getState()
  if (!apiKey) {
    throw Object.assign(new Error('nokey'), { reason: 'nokey' })
  }
  const body = buildRequest({
    model: isCustomApiOrigin() ? 'deepseek-flash' : model,
    system,
    messages: [{ role: 'user', content: user }],
    search,
    safety: 'low',
    forceStandard: false,
  }).body
  let text = ''
  let searched = false
  for await (const event of streamMessage(apiKey, body, signal)) {
    if (event.type === 'content_block_start') {
      // 服务端工具块（搜索结果 / 读链接）出现就说明这一轮真的联网了
      const serialized = JSON.stringify(event)
      if (serialized.includes('web_search') || serialized.includes('read_url')) {
        searched = true
      }
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    }
  }
  return { text, searched }
}

/**
 * 生成角色卡草稿。
 * 第一步联网写资料（可能被服务端判定「不用搜」而跳过，这不影响第二步）；
 * 第二步关搜索、只在标准模式里产 JSON，避免 32,768 token 的扩展模式限制。
 */
export const generatePersonaCard = async (
  brief: PersonaBrief,
  options: { signal?: AbortSignal; onPhase?: (phase: 'research' | 'card') => void } = {}
): Promise<GenerateOutcome> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS)
  // 不用 AbortSignal.any：构建目标是 chrome>=70，老 WebView 没有这个 API
  const outer = options.signal
  if (outer) {
    if (outer.aborted) {
      controller.abort()
    } else {
      outer.addEventListener('abort', () => controller.abort(), { once: true })
    }
  }
  const signal = controller.signal
  try {
    options.onPhase?.('research')
    let research = ''
    let searched = false
    try {
      const result = await runStream(RESEARCH_SYSTEM, briefBlock(brief), true, signal)
      research = result.text.trim()
      searched = result.searched
    } catch (error) {
      // 第一段失败（比如搜索档位不可用）不致命：直接进第二段，用用户给的信息写
      if (signal.aborted) {
        throw error
      }
    }
    options.onPhase?.('card')
    const user = [
      research ? `【角色资料】\n${research}` : '',
      `【用户要求】\n${briefBlock(brief)}`,
    ]
      .filter(Boolean)
      .join('\n\n')
    const card = await runStream(cardSystem(brief.name.trim()), user, false, signal)
    const json = extractJson(card.text)
    if (!json) {
      return { ok: false, reason: card.text.trim() === '' ? 'empty' : 'parse', raw: card.text }
    }
    const parsed = parsePersonaJson(json)
    if (!parsed.ok) {
      return { ok: false, reason: 'parse', raw: card.text, detail: parsed.error }
    }
    return { ok: true, card: parsed.card, searched, raw: card.text }
  } catch (error) {
    if (signal.aborted) {
      return { ok: false, reason: 'aborted' }
    }
    const reason = (error as { reason?: string }).reason
    if (reason === 'nokey') {
      return { ok: false, reason: 'nokey' }
    }
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}
