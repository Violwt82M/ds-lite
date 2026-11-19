import { sanitizeSurrogates } from '../../utils/safeText.js'
import { stripSpecialTokens } from '../../utils/specialTokens.js'
import type { Message, ReplyBlock, Session } from './types.js'

/**
 * 会话文本清洗：写库前（db.saveSessionRecord）与加载后（store.ensureSessionLoaded）各跑一次。
 *
 * 为什么需要：
 * - 0.9.50 之前的版本会把 DSML 工具标记、特殊 token 原样写进消息；加载后用这里清掉旧脏数据，
 *   顺带随下一次落盘把库里也洗干净；
 * - 异常字符（孤立代理项）会让服务端的 JSON 解析 400，本机存储虽然能存，但没理由留着它。
 *
 * 只清「可显示、可回传」的文本。思考块与 signature 原样保留：续写时它们要和签名一起回传服务端，
 * 改原文有被判定前缀不一致的风险（显示兜底在 view.ts 里单独做）。
 * 没有任何改动时返回原对象，调用方可用 === 判断要不要重新落盘。
 */

const cleanText = (text: string): string => stripSpecialTokens(sanitizeSurrogates(text))

const cleanBlock = (block: ReplyBlock): ReplyBlock => {
  if (block.type === 'text') {
    const text = cleanText(block.text)
    return text === block.text && block.pendingText === undefined
      ? block
      : { ...block, text, pendingText: undefined }
  }
  if (block.type === 'thinking') {
    // 思考原文不动（续写前缀与签名要原样回传），只清会让服务端 JSON 解析 400 的孤立代理
    const thinking = sanitizeSurrogates(block.thinking)
    return thinking === block.thinking ? block : { ...block, thinking }
  }
  return block
}

const cleanMessage = (message: Message): Message => {
  if (message.role === 'user') {
    const content = sanitizeSurrogates(message.content)
    return content === message.content ? message : { ...message, content }
  }
  let changed = false
  const blocks = message.blocks.map((block) => {
    const cleaned = cleanBlock(block)
    if (cleaned !== block) {
      changed = true
    }
    return cleaned
  })
  const latestReminder =
    message.latestReminder === undefined ? undefined : cleanText(message.latestReminder)
  if (latestReminder !== message.latestReminder) {
    changed = true
  }
  return changed ? { ...message, blocks, latestReminder } : message
}

export const cleanSessionText = (session: Session): Session => {
  let changed = false
  const title = cleanText(session.title)
  if (title !== session.title) {
    changed = true
  }
  const messages = session.messages.map((message) => {
    const cleaned = cleanMessage(message)
    if (cleaned !== message) {
      changed = true
    }
    return cleaned
  })

  let memory = session.memory
  if (memory) {
    const notes = memory.notes.map((note) => {
      const text = cleanText(note.text)
      return text === note.text ? note : { ...note, text }
    })
    const instruction =
      memory.instruction === undefined ? undefined : cleanText(memory.instruction)
    if (notes.some((note, index) => note !== memory?.notes[index]) || instruction !== memory.instruction) {
      memory = { ...memory, notes, instruction }
      changed = true
    }
  }

  let records = session.records
  if (records) {
    const cleaned = records.map((record) => {
      const recordTitle = cleanText(record.title)
      const text = cleanText(record.text)
      return recordTitle === record.title && text === record.text
        ? record
        : { ...record, title: recordTitle, text }
    })
    if (cleaned.some((record, index) => record !== records?.[index])) {
      records = cleaned
      changed = true
    }
  }

  if (!changed) {
    return session
  }
  return {
    ...session,
    title,
    messages,
    ...(memory !== undefined ? { memory } : {}),
    ...(records !== undefined ? { records } : {}),
  }
}
