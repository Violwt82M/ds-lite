import { renderSystemPrompt } from './card.js'
import { substituteMacros } from './macros.js'
import type { PersonaCard } from './card.js'

/** 玩家没填称呼时的兜底，避免卡片里的 {{user}} 变成空串 */
const FALLBACK_USER_NAME = '我'

/**
 * 组装本轮请求的 system 字段。
 * 没有生效的角色卡时只拼基础提示词与长期记忆，保证默认行为与官方 demo 一致。
 * 有卡时顺序为：角色设定 → 开场白说明 → 基础提示词 → 长期记忆。
 * memory 为空串时完全不出现，不会给模型任何额外暗示。
 *
 * 卡片由调用方按「会话绑定 → 全局默认」解析好后传进来，这里不再读全局状态。
 */
export const buildSystemPrompt = (
  base: string,
  memory = '',
  persona: { card: PersonaCard; userName: string } | null = null
): string => {
  if (persona === null) {
    return memory === '' ? base : `${base}\n\n${memory}`
  }
  const { card } = persona
  const userName = persona.userName.trim() === '' ? FALLBACK_USER_NAME : persona.userName.trim()
  const parts = [renderSystemPrompt(card, { userName })]
  const greeting = card.firstMessage.trim()
  if (greeting !== '') {
    // 开场白以本机展示为主，这里再交代一次，避免模型不知道对话已经从这句开始
    const line = substituteMacros(greeting, { char: card.name, user: userName })
    parts.push(`【开场白】对话已经从你的一句话开始：「${line}」`)
  }
  parts.push(base)
  if (memory !== '') {
    parts.push(memory)
  }
  return parts.join('\n\n')
}
