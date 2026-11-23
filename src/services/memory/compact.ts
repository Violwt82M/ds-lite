import { streamMessage } from '../api/client.js'
import type {
  AssistantMessage,
  AttachmentMemory,
  FileAttachment,
  MemoryNote,
  SessionMemory,
  UserMessage,
} from '../chat/types.js'
import type { Locale } from '../settings.js'
import { safeSlice, safeTail, safeTruncate, truncatePercent } from '../../utils/safeText.js'
import { formatSize, getExtension } from '../attachments.js'
import { STANDARD_MODE } from '../chat/request.js'

/** 单条笔记的长度上限，避免模型把整段对话抄进记忆 */
export const MAX_NOTE_CHARS = 400
/** 单个会话保留的笔记条数上限（硬上限，超出截断） */
export const MAX_MEMORY_NOTES = 60
/** 覆盖式大笔记的默认上限 */
export const MAX_BIG_NOTE_CHARS = 6_000

/**
 * 笔记篇幅按「这次要整理多少内容」分档：
 * 短对话几句话就够，几百轮的 RP 存档必须留住人物状态与情节线，否则会 OOC。
 */
export const bigNoteLimit = (foldedChars: number): number => {
  // 档位按用户指定的 0.9.26 口径：1000 / 2400 / 4500 / 6500。
  // 但调用方传进来的是**累计已折叠量**（本次折叠 + 之前已折叠），
  // 所以低上下文频繁整理的用户也不会永远卡在最小档，笔记会随历史长大。
  if (foldedChars < 30_000) {
    return 1_000
  }
  if (foldedChars < 150_000) {
    return 2_400
  }
  if (foldedChars < 400_000) {
    return 4_500
  }
  return 6_500
}
/** 一次覆盖式整理最多保留的笔记条数（提示词与解析共用） */
export const MAX_OUTPUT_NOTES = 30
/** 送进整理调用的对话原文上限（字符数）；超出只保留最近的 */
/** 中文实测 0.59~0.70 token/字符，取 0.65 折算：预算用 token 表达，别按字符猜 */
export const charsForTokens = (tokens: number) => Math.floor(tokens / 0.65)
const MAX_TRANSCRIPT_CHARS = charsForTokens(39_000)
/** 单条消息在整理原文里的截断长度（约 4,000 字，避免长文档轮次被切得太碎） */
const MAX_MESSAGE_CHARS = charsForTokens(2_600)

const SYSTEM_PROMPTS: Record<Locale, string> = {
  'zh-CN': `你是对话记忆整理助手。你会看到同一个 AI 助手此前的记忆笔记，以及一段即将被折叠、原文不再留在上下文里的较早对话。请把「旧笔记 + 这段对话」整理成**一份**最新的压缩记录：它是被折叠原文的替代索引，供助手在原文看不到时**备查**，而不是让助手照着它把故事讲下去。

要求：
1. 只写后续对话真正需要的事实：人物与关系、设定与世界观、已发生的关键情节、用户的偏好与禁忌、明确的约定或未完成的事、重要的名称与结论。
   如果对话里出现过文档或图片附件（转录里以「附件：」开头），必须写进【资料】：文件名、它大致是什么内容、模型读了多少。不要复述文档正文，也不要假装读过没读到的部分。
2. 覆盖式整理：你输出的就是整理后的完整笔记，它会整体替换旧笔记。请把【已有记忆】与本次对话合并去重；旧说法被推翻时直接改写成正确说法；已经过时或不再重要的删掉。
3. 先判断这段对话是哪种，再决定写什么：
   · 角色扮演 / 人物对话 / 小说或剧本创作：重点是角色的当前状态、彼此关系、这段被省略的部分发生过什么（粗略概括即可：一句话一段经历，不写过程、不写台词）、还没解决的事。
   · 普通使用（问问题、查资料、办事、写代码）：重点是事实与结论、用户的要求与偏好、怎么称呼用户、已经定下来的方案、还没做完的事。
   如果用户消息里带了【角色扮演背景】，直接按角色扮演处理，不用再判断。
4. 输出格式：一份笔记，用下面五个小标题分段，没有内容的段直接省略：
【关键事实】
【角色与关系】
【前情经过】
【资料】
【待办】
   每条一行、以「· 」开头，一句话说清一件事。
   【前情经过】只写这段被省略的部分发生过什么，粗略概括即可，例如：
   · 对：她肚子难受，他照顾了一夜，第二天两人在家歇着。
   · 错（写成了场景回放）：她夜里怪他“过分”，他揽她入怀、亲她发顶，解释是怕她难受。
5. 篇幅以【篇幅要求】为准；宁可少写、也要写得准，但人物的当前状态、关系变化与还没解决的事不能省。篇幅不够时先删【前情经过】里的细节，**【待办】必须留着，不能省**。
6. 用户自己写下的偏好、约定、禁忌是重要事实，务必保留；用户明确要求怎么称呼自己时，原样记下。
7. 不要复述说话过程，不要写「用户问…助手答…」，不要评价，不要加任何前言后语。
8. 只输出笔记正文，不要代码块、不要解释。`,
  'en-US': `You maintain the memory notes of an AI assistant. You see the notes so far plus an earlier part of the conversation that is about to be folded out of the context. Produce the updated, complete digest: an index standing in for that omitted text, so the assistant can look things up later - not a script the assistant should keep telling the story from.

Rules:
1. Keep only facts needed later: people and relationships, setting, key plot points, user preferences and dislikes, agreements or unfinished tasks, important names and conclusions.
   If documents or images appeared in the conversation (transcript lines starting with "Attachments:"), record them under [Documents]: file name, roughly what it contains, how much the model read. Never restate the document body, and never pretend to have read parts that were cut.
2. Rewrite in place: your output is the complete note and replaces the old one. Merge and deduplicate [Existing memory] with this conversation; when an old fact is superseded, write the correct fact directly; drop anything obsolete.
3. First decide what kind of conversation this is:
   - Roleplay / character dialogue / fiction or script writing: focus on the characters' current state, their relationships, a rough recap of what happened in the omitted part (one sentence per stretch, no process, no dialogue) and what is still open.
   - Ordinary use (questions, research, tasks, coding): focus on facts and conclusions, the user's requests and preferences, how the user wants to be addressed, settled decisions and unfinished work.
   If the user message contains [Roleplay context], treat it as roleplay without further judgement.
4. Format: one note, split into these five sections and skip empty ones:
[Key facts]
[Characters and relationships]
[Past recap]
[Documents]
[To do]
   Each line starts with "· " and states one thing.
   [Past recap] only says what happened in the omitted part, told roughly, for example:
   · Good: She felt sick, he looked after her all night, and the next day they stayed home.
   · Bad (this is a scene replay): She blamed him for being "too much", he pulled her into his arms and kissed the top of her head.
5. Follow [Length requirement]; fewer but accurate is better, but never drop the characters' current state, relationship changes or open threads. If space runs short, cut detail from [Past recap] first; **[To do] must never be dropped**.
6. Facts the user wrote themselves (preferences, agreements, dislikes) must be kept; if the user says how they want to be addressed, record it verbatim.
7. Do not narrate the exchange, no commentary, no preamble or closing.
8. Output the note body only, no code fences, no explanation.`,
}

const LIST_HEADERS: Record<Locale, string> = { 'zh-CN': '【已有记忆】', 'en-US': '[Existing memory]' }
const TRANSCRIPT_HEADER: Record<Locale, string> = {
  'zh-CN': '【本次要整理的对话】',
  'en-US': '[Conversation to condense]',
}
const NONE_NOTE: Record<Locale, string> = { 'zh-CN': '（无）', 'en-US': '(none)' }
const RECENT_HEADER: Record<Locale, string> = {
  'zh-CN': '【最近对话（只读参考）】',
  'en-US': '[Recent messages (read-only reference)]',
}
const RECENT_RULE: Record<Locale, string> = {
  'zh-CN':
    '以下是这次**不参与整理**、会原样留在上下文里的最近几轮。它们用来判断旧笔记里哪些说法已经过时：冲突时以它们为准，把旧说法改对。不要把它们的细节抄进笔记。',
  'en-US':
    'The rounds below are NOT being condensed; they stay in the context verbatim. Use them only to spot outdated statements in the old notes and correct them. Do not copy their details into the note.',
}
const PERSONA_HEADER: Record<Locale, string> = {
  'zh-CN': '【角色扮演背景】',
  'en-US': '[Roleplay context]',
}
const PERSONA_RULE: Record<Locale, (name: string, style: string) => string> = {
  'zh-CN': (name, style) =>
    `这段对话是角色扮演，你在扮演「${name}」${style ? `，说话风格：${style}` : ''}。整理时不要漏掉角色的当前状态与关系，以及这段剧情的粗略主线；这些都是原文的替代索引，不要写成叙事、不要铺场景，语气由近期原文维持。`,
  'en-US': (name, style) =>
    `This conversation is roleplay; you play "${name}"${style ? `, speaking style: ${style}` : ''}. Keep the character's current state and relationships plus the rough mainline of what happened; they are an index standing in for the original text, so do not narrate scenes and do not copy dialogue - the recent messages carry the voice.`,
}

const MODE_HEADER: Record<Locale, string> = { 'zh-CN': '【整理模式】', 'en-US': '[Mode]' }
const MODE_RULE: Record<Locale, Record<'rp' | 'plain', string>> = {
  'zh-CN': {
    rp: '用户指定按叙事整理：偏重人物状态与剧情主线，其余照常。',
    plain: '用户指定按工作整理：偏重事实、结论与未决事项，不要写成剧情。',
  },
  'en-US': {
    rp: 'The user asks for narrative emphasis: character state and the plot mainline first.',
    plain: 'The user asks for work emphasis: facts, conclusions and open items only; no storytelling.',
  },
}

const LENGTH_HEADER: Record<Locale, string> = {
  'zh-CN': '【篇幅要求】',
  'en-US': '[Length requirement]',
}
const LENGTH_RULE: Record<Locale, (limit: number) => string> = {
  'zh-CN': (limit) => `总字数控制在 ${limit} 字以内。`,
  'en-US': (limit) => `Keep the whole note within ${limit} characters.`,
}

const DEMAND_HEADER: Record<Locale, string> = {
  'zh-CN': '【用户的整理要求】',
  'en-US': '[What the user asked you to keep]',
}

const truncate = (text: string, limit: number) => safeTruncate(text, limit)

/**
 * 分段整理：把待折叠的轮次按字符预算切成若干段。
 * 一段一次请求，前面的结果作为下一段的【已有记忆】传下去，
 * 这样上百万字的会话也不会被一次性丢掉（旧实现只取最后 24k 字）。
 */
export const SEGMENT_CHARS = 45_000

const roundChars = (round: [UserMessage, AssistantMessage]): number => {
  const [user, reply] = round
  const answer = reply.blocks
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
  return (
    Math.min(user.content.trim().length, MAX_MESSAGE_CHARS) +
    Math.min(answer.length, MAX_MESSAGE_CHARS)
  )
}

/** 一轮对话在原文里的字符量（按截断规则估算） */
export const roundsChars = (rounds: [UserMessage, AssistantMessage][]): number =>
  rounds.reduce((sum, round) => sum + roundChars(round), 0)

export const splitRounds = (
  rounds: [UserMessage, AssistantMessage][],
  budget: number = SEGMENT_CHARS
): [UserMessage, AssistantMessage][][] => {
  const chunks: [UserMessage, AssistantMessage][][] = []
  let current: [UserMessage, AssistantMessage][] = []
  let size = 0
  for (const round of rounds) {
    const next = roundChars(round)
    // 至少塞一轮，避免一堆超长消息切出空段
    if (current.length > 0 && size + next > budget) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(round)
    size += next
  }
  if (current.length > 0) {
    chunks.push(current)
  }
  return chunks
}

const FILE_LABEL: Record<Locale, string> = { 'zh-CN': '附件', 'en-US': 'Attachments' }
const IMAGE_LABEL: Record<Locale, string> = { 'zh-CN': '图片', 'en-US': 'image' }
const READ_LABEL: Record<Locale, string> = { 'zh-CN': '模型只读了前 ', 'en-US': 'model read only the first ' }

/**
 * 把待折叠的轮次拼成整理原文：按时间顺序，单条与总量都有上限，防止整理调用本身爆上下文。
 * 附件只写「名称 / 类型 / 体积 / 读了多少」——正文本来就不在文本里，
 * 但不写这一行，整理完的笔记里连「读过一份文档」都不会留下。
 */
export const buildTranscript = (
  rounds: [UserMessage, AssistantMessage][],
  locale: Locale,
  maxChars: number = MAX_TRANSCRIPT_CHARS
): string => {
  const lines: string[] = []
  const roundLabel = locale === 'zh-CN' ? '第 {n} 轮' : 'Round {n}'
  const userLabel = locale === 'zh-CN' ? '用户' : 'User'
  const assistantLabel = locale === 'zh-CN' ? '助手' : 'Assistant'
  for (const [index, [user, reply]] of rounds.entries()) {
    const answer = reply.blocks
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim()
    const parts = [
      roundLabel.replace('{n}', String(index + 1)),
      `${userLabel}：${truncate(user.content.trim(), MAX_MESSAGE_CHARS)}`,
    ]
    if (user.files.length > 0) {
      const listed = user.files.map((file) => {
        const kind = file.isImage ? IMAGE_LABEL[locale] : getExtension(file.name) || FILE_LABEL[locale]
        const read = file.truncated
          ? `，${READ_LABEL[locale]}${truncatePercent(file.truncated.kept, file.truncated.total)}%`
          : ''
        return `${file.name}（${kind}，${formatSize(file.size)}${read}）`
      })
      parts.push(`${FILE_LABEL[locale]}：${listed.join(locale === 'zh-CN' ? '；' : '; ')}`)
    }
    if (answer) {
      parts.push(`${assistantLabel}：${truncate(answer, MAX_MESSAGE_CHARS)}`)
    }
    lines.push(parts.join('\n'))
  }
  const text = lines.join('\n\n')
  return safeTail(text, maxChars)
}

/**
 * 独立资料记忆：附件正文不留在上下文里，但「这份资料讲了什么」必须留得下来。
 * 摘要按结构化小标题组织，单份 300~800 字，绝不复制全文；整份列表再控总量。
 */
const ATTACHMENT_SUMMARY_MAX_CHARS = 800
/** 送进提炼调用的附件正文上限：超长按前/中/后抽样 */
const ATTACHMENT_DOC_CHARS = 24_000
/** 提炼时带上的提问 / 回复各自的上限 */
const ATTACHMENT_CONTEXT_CHARS = 2_000
/** attachments 列表总字数预算：约 1.5K~2K token，避免资料区反客为主 */
const ATTACHMENT_TOTAL_CHARS = 3_000

/**
 * 超长正文按「前 42% + 中间 20% + 后 38%」抽样：
 * 开头通常是设定/目录，中间是主体，结尾是结论/数据表，三处都不丢。
 */
export const sampleAttachmentText = (
  text: string,
  locale: Locale,
  limit: number = ATTACHMENT_DOC_CHARS
): string => {
  const clean = text.replace(/\r\n/g, '\n').trim()
  if (clean.length <= limit) {
    return clean
  }
  const marker =
    locale === 'zh-CN' ? '\n\n……（中间部分省略）……\n\n' : '\n\n[... middle omitted ...]\n\n'
  const room = Math.max(600, limit - marker.length * 2)
  const headLen = Math.floor(room * 0.42)
  const midLen = Math.floor(room * 0.2)
  const tailLen = room - headLen - midLen
  const midStart = Math.max(headLen, Math.floor((clean.length - midLen) / 2))
  const tailStart = Math.max(midStart + midLen, clean.length - tailLen)
  return [
    safeSlice(clean, 0, headLen),
    safeSlice(clean, midStart, midStart + midLen),
    safeSlice(clean, tailStart, clean.length),
  ].join(marker)
}

const ATTACHMENT_PROMPTS: Record<Locale, string> = {
  'zh-CN': `你是资料提炼助手。用户上传过一份附件，并围绕它与 AI 助手聊过。请为后续对话留下一份可备查的结构化资料摘要，而不是复述原文。

要求：
1. 输出 300~800 字，按下面小标题分段，没有内容的段直接省略：
【资料概况】文件是什么、主题与用途
【核心设定】世界观、人物、术语、规则等（如有）
【关键数据】重要的数字、参数、名单、结论
【对话结论】用户这次关心的点与 AI 给出的重要结论
【后续可用】以后回答时需要遵守或反复引用的信息
2. 只写对后续对话有用的事实，按主题归纳；不要逐段复述、不要整段翻译、不要写「开头说…结尾说…」。
3. 正文被抽样截断的部分不要编造，只依据给出的内容总结，不要假装读过没给出的部分。
4. 关键名称、数字、专有名词保留原写法。
5. 只输出摘要正文，不要代码块、不要前言后语。`,
  'en-US': `You distill reference material. The user uploaded a file earlier and talked about it with an AI assistant. Produce a structured digest that stays available for later turns - do not restate the file.

Rules:
1. Output 300-800 characters, grouped under these headings and skipping empty ones:
[Overview] what the file is, its topic and purpose
[Core setting] world, characters, terms, rules (if any)
[Key data] important numbers, parameters, names, conclusions
[Conversation outcome] what the user cared about and the assistant's important conclusions
[Reusable later] facts to follow or cite in future replies
2. Keep only facts useful later, grouped by theme; no section-by-section retelling, no full translation, no "the beginning says ... the end says ...".
3. Never invent the parts that were sampled out; summarise only what is given and do not pretend to have read the rest.
4. Preserve names, numbers and proper nouns as written.
5. Output the digest only, no code fences, no preamble or closing.`,
}

const ATTACHMENT_LABELS: Record<
  Locale,
  {
    fileName: string
    question: string
    answer: string
    content: string
    noContent: string
    sampled: string
    image: string
    asked: string
    reply: string
  }
> = {
  'zh-CN': {
    fileName: '【文件名】',
    question: '【用户提问】',
    answer: '【AI 回复（节选）】',
    content: '【附件正文（节选）】',
    noContent: '（本地未能读取到正文，例如扫描件或需要服务端解析的格式。请不要假装读过正文。）',
    sampled: '（正文超长，已按前/中/后抽样，未给出的部分不要编造。）',
    image: '图片附件',
    asked: '本轮提问',
    reply: '当时回复要点',
  },
  'en-US': {
    fileName: '[File name]',
    question: '[User question]',
    answer: '[Assistant reply (excerpt)]',
    content: '[File text (excerpt)]',
    noContent:
      '(The local text could not be read, e.g. a scan or a format that must be parsed server-side. Do not pretend to have read it.)',
    sampled: '(The file was too long and has been sampled from the start/middle/end; do not invent the missing parts.)',
    image: 'Image attachment',
    asked: 'User asked',
    reply: 'Reply highlights',
  },
}

const buildAttachmentPrompt = ({
  locale,
  file,
  question,
  answer,
  content,
  sampled,
}: {
  locale: Locale
  file: FileAttachment
  question: string
  answer: string
  content: string
  sampled: boolean
}): string => {
  const label = ATTACHMENT_LABELS[locale]
  const parts = [`${label.fileName}${file.name}`]
  if (question) {
    parts.push(`${label.question}\n${question}`)
  }
  if (answer) {
    parts.push(`${label.answer}\n${answer}`)
  }
  if (content) {
    parts.push(`${label.content}\n${content}`)
    if (sampled) {
      parts.push(label.sampled)
    }
  } else {
    parts.push(label.noContent)
  }
  return parts.join('\n\n')
}

/** 图片附件没有可读正文：用这一轮的提问与回复做一条简短要点，不再多花一次请求 */
const imageMemorySummary = ({
  locale,
  file,
  question,
  answer,
}: {
  locale: Locale
  file: FileAttachment
  question: string
  answer: string
}): string => {
  const label = ATTACHMENT_LABELS[locale]
  const title =
    locale === 'zh-CN' ? `图片附件《${file.name}》` : `Image attachment "${file.name}"`
  return truncate(
    [
      title,
      question ? `${label.asked}：${truncate(question, 300)}` : '',
      answer ? `${label.reply}：${truncate(answer, 500)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    ATTACHMENT_SUMMARY_MAX_CHARS
  )
}

const cleanAttachmentSummary = (raw: string, limit: number): string =>
  truncate(
    raw
      .replace(/^\s*```[a-zA-Z]*\s*/, '')
      .replace(/\s*```\s*$/, '')
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    limit
  )

/** 总量控制：优先保留较新的资料；最后一条放不下时温和截断，不整条丢 */
const fitAttachmentBudget = (
  list: AttachmentMemory[],
  budget: number = ATTACHMENT_TOTAL_CHARS
): AttachmentMemory[] => {
  const newestFirst = [...list].sort((a, b) => b.createdAt - a.createdAt)
  const kept: AttachmentMemory[] = []
  let used = 0
  for (const item of newestFirst) {
    const left = budget - used
    if (left < 120) {
      break
    }
    if (item.summary.length <= left) {
      kept.push(item)
      used += item.summary.length
      continue
    }
    kept.push({ ...item, summary: truncate(item.summary, Math.max(120, left - 1)) })
    break
  }
  return kept.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * 独立提炼附件资料记忆。它不写库，只返回合并后的完整列表：
 * 已有附件（按 fileId 或文件名去重）+ 本次新提炼的，总量约 3,000 字。
 * 调用方直接把返回值写入 memory.attachments 即可。
 */
export const extractAttachmentMemories = async ({
  apiKey,
  locale,
  rounds,
  existingAttachments = [],
  readFileContent,
  signal,
}: {
  apiKey: string
  locale: Locale
  /** 待整理的轮次；只处理 user.files 非空的轮次 */
  rounds: [UserMessage, AssistantMessage][]
  /** 会话里已有的资料记忆，用于去重与合并 */
  existingAttachments?: AttachmentMemory[]
  /** 读取本地附件正文；图片或读不到时返回 null / 空串 */
  readFileContent: (file: FileAttachment) => Promise<string | null | undefined>
  signal: AbortSignal
}): Promise<AttachmentMemory[]> => {
  const baseTime = Date.now()
  const seenFileIds = new Set(
    existingAttachments
      .map((item) => item.fileId)
      .filter((value): value is string => typeof value === 'string' && value !== '')
  )
  const seenNames = new Set(existingAttachments.map((item) => item.name))
  const created: AttachmentMemory[] = []
  for (const [user, reply] of rounds) {
    if (user.files.length === 0) {
      continue
    }
    const answer = reply.blocks
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim()
    for (const file of user.files) {
      if (signal.aborted) {
        throw new Error('Aborted')
      }
      if (
        seenFileIds.has(file.id) ||
        (file.serverId !== null && seenFileIds.has(file.serverId)) ||
        seenNames.has(file.name)
      ) {
        continue
      }
      try {
        let summary = ''
        if (file.isImage) {
          // 没有可读的图片正文：只从这一轮对话里留一条要点，避免再发一次请求
          summary = answer ? imageMemorySummary({ locale, file, question: user.content, answer }) : ''
        } else {
          const raw = (await readFileContent(file)) ?? ''
          if (signal.aborted) {
            throw new Error('Aborted')
          }
          const sampled = raw.replace(/\r\n/g, '\n').trim().length > ATTACHMENT_DOC_CHARS
          const text = sampleAttachmentText(raw, locale)
          const question = truncate(user.content.trim(), ATTACHMENT_CONTEXT_CHARS)
          const replyText = truncate(answer, ATTACHMENT_CONTEXT_CHARS)
          if (!text && !question && !replyText) {
            continue
          }
          const events = streamMessage(
            apiKey,
            {
              model: 'deepseek-flash',
              system: ATTACHMENT_PROMPTS[locale],
              messages: [
                {
                  role: 'user',
                  content: buildAttachmentPrompt({
                    locale,
                    file,
                    question,
                    answer: replyText,
                    content: text,
                    sampled,
                  }),
                },
              ],
              ...STANDARD_MODE,
            },
            signal
          )
          let output = ''
          for await (const event of events) {
            if (
              event.type === 'content_block_delta' &&
              event.delta.type === 'text_delta' &&
              event.index === 0
            ) {
              output += event.delta.text
            }
          }
          summary = cleanAttachmentSummary(output, ATTACHMENT_SUMMARY_MAX_CHARS)
        }
        if (!summary.trim()) {
          continue
        }
        const id = `att-${file.id}`
        created.push({
          id,
          name: file.name,
          summary,
          fileId: file.id,
          createdAt: baseTime + created.length,
        })
        seenFileIds.add(file.id)
        if (file.serverId !== null) {
          seenFileIds.add(file.serverId)
        }
        seenNames.add(file.name)
      } catch (error) {
        if (signal.aborted) {
          throw error
        }
        // 单份附件读不出来/提炼失败不该让整次整理失败，跳过它
        continue
      }
    }
  }
  return fitAttachmentBudget([...existingAttachments, ...created])
}

/** 由已有笔记与新对话整理出新的笔记列表；只读流式文本，落库由调用方负责。 */
const OVERVIEW_PROMPTS: Record<Locale, string> = {
  'zh-CN': `你把一段较早的对话压成一两句概览，供之后回忆用。就像人回忆很久以前的事：只记得大概发生了什么、关系有什么变化、哪些事已经了结。
规则：
1. 输出 1~2 句，不超过 120 字，只写主线。
2. 不写台词、不写细节、不写具体措辞、不写「用户问…」。
3. 只输出正文，不要前缀、不要列表符号。`,
  'en-US': `Compress an older stretch of conversation into one or two sentences of overview, the way a person recalls something long past: roughly what happened, how relationships changed, what got settled.
Rules:
1. 1-2 sentences, at most 120 characters, main line only.
2. No dialogue quotes, no fine detail, no "the user asked".
3. Output the text only, no prefix, no bullet marker.`,
}

/** 老内容只留一句概览：输出短、跑得快，细节留给最近的部分 */
export const summarizeOverview = async ({
  apiKey,
  transcript,
  locale,
  signal,
}: {
  apiKey: string
  transcript: string
  locale: Locale
  signal: AbortSignal
}): Promise<string> => {
  const events = streamMessage(
    apiKey,
    {
      model: 'deepseek-flash',
      system: OVERVIEW_PROMPTS[locale],
      messages: [{ role: 'user', content: transcript }],
      ...STANDARD_MODE,
    },
    signal
  )
  let text = ''
  for await (const event of events) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta' &&
      event.index === 0
    ) {
      text += event.delta.text
    }
  }
  return safeSlice(text.replace(/\s+/g, ' ').trim(), 0, 200)
}

/** 把上一次的概览和新压出来的几段合并：越老越简，只留主线 */
export const mergeOverview = async ({
  apiKey,
  prev,
  lines,
  locale,
  signal,
}: {
  apiKey: string
  prev: string
  lines: string[]
  locale: Locale
  signal: AbortSignal
}): Promise<string> => {
  const system =
    locale === 'zh-CN'
      ? '你把一份长期记忆概览重新概括一遍。旧的概览代表更早的事，越早的越简；新内容比旧的重要。输出一段不超过 500 字的概览，只保留主线、人物关系的变化、已了结与未了结的事。不要台词，不要细节，不要列表符号。'
      : 'You re-condense a long-term memory overview. Older parts should be shorter; newer parts matter more. Output one paragraph under 500 characters, keeping the main line, relationship changes, and what is settled or still open. No quotes, no fine detail, no bullets.'
  const events = streamMessage(
    apiKey,
    {
      model: 'deepseek-flash',
      system,
      messages: [
        {
          role: 'user',
          content: [
            prev ? `【原有概览】\n${prev}` : '',
            `【新增内容】\n${lines.join('\n')}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
      ...STANDARD_MODE,
    },
    signal
  )
  let text = ''
  for await (const event of events) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta' &&
      event.index === 0
    ) {
      text += event.delta.text
    }
  }
  return safeSlice(text.trim(), 0, 600)
}

export const summarizeRounds = async ({
  apiKey,
  transcript,
  existingNotes,
  locale,
  signal,
  instruction,
  noteLimit,
  persona,
  mode,
  recent,
}: {
  apiKey: string
  transcript: string
  /** 本次不折叠、会原样留在上下文里的最近对话：只读参考，用来对齐现状 */
  recent?: string
  existingNotes: string[]
  locale: Locale
  signal: AbortSignal
  /** 用户对本次整理的自定义要求，空则按默认规则 */
  instruction?: string
  /** 本次笔记的字数上限，由 bigNoteLimit 按内容量算出 */
  noteLimit?: number
  /** 这个对话绑定了角色卡时，把角色信息一起给整理模型，避免它猜错对话类型 */
  persona?: { name: string; style: string }
  /** 用户手动指定的整理模式，auto 时由模型判断 */
  mode?: "auto" | "rp" | "plain"
}): Promise<string> => {
  const header = existingNotes.length
    ? `${LIST_HEADERS[locale]}\n${existingNotes.map((note) => `- ${note}`).join('\n')}`
    : `${LIST_HEADERS[locale]}\n${NONE_NOTE[locale]}`
  const events = streamMessage(
    apiKey,
    {
      model: 'deepseek-flash',
      system: SYSTEM_PROMPTS[locale],
      messages: [
        {
          role: 'user',
          content: `${mode && mode !== "auto" ? `\n\n${MODE_HEADER[locale]}\n${MODE_RULE[locale][mode]}` : ""}${persona ? `\n\n${PERSONA_HEADER[locale]}\n${PERSONA_RULE[locale](persona.name, persona.style)}` : ''}${header}${instruction ? `\n\n${DEMAND_HEADER[locale]}\n${instruction}` : ''}${noteLimit ? `\n\n${LENGTH_HEADER[locale]}\n${LENGTH_RULE[locale](noteLimit)}` : ''}\n\n${TRANSCRIPT_HEADER[locale]}\n${transcript}${recent ? `\n\n${RECENT_HEADER[locale]}\n${RECENT_RULE[locale]}\n\n${recent}` : ''}`,
        },
      ],
      // 整理不需要思考，关掉省钱也更快；也不声明任何工具——
      // 一旦声明就进扩展模式，输入上限被砍到 32768 token
      ...STANDARD_MODE,
    },
    signal
  )
  let text = ''
  for await (const event of events) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta' &&
      event.index === 0
    ) {
      text += event.delta.text
    }
  }
  return text
}

const BULLET = /^\s*(?:[-*•·]|\d+[.、)])\s+/

/** 把模型输出拆成笔记：优先取列表行，识别不出列表时整段当作一条。 */
/** 解析覆盖式大笔记：整段输出就是一条笔记，只做清理与截断 */
export const parseBigNote = (raw: string, limit: number = MAX_BIG_NOTE_CHARS): string => {
  const text = raw
    .replace(/^\s*```[a-zA-Z]*\s*/, '')
    .replace(/\s*```\s*$/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return truncate(text, limit)
}

export const parseMemoryNotes = (raw: string, limit: number = MAX_OUTPUT_NOTES): string[] => {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const bullets = lines
    .filter((line) => BULLET.test(line))
    .map((line) => line.replace(BULLET, '').trim())
    .filter((line) => line !== '')
  const source = bullets.length > 0 ? bullets : lines.filter((line) => !line.endsWith('：'))
  const notes: string[] = []
  for (const line of source) {
    const text = truncate(line.replace(/^#+\s*/, ''), MAX_NOTE_CHARS)
    if (text && !notes.includes(text)) {
      notes.push(text)
    }
  }
  return notes.slice(0, limit)
}

/**
 * 覆盖式重写笔记：模型这次输出的就是一整份最新笔记，旧笔记被整体替换，
 * 因此不会越整理越多、也不会出现「旧说法 + （更正）」并存的矛盾。
 * 例外：用户手写/手改的笔记（source 为 manual）代表用户自己的想法，
 * 模型漏掉时会补回去，避免被模型悄悄删掉。
 */
export const rewriteNotes = (
  memory: SessionMemory | undefined,
  texts: string[],
  now: number,
  limit: number = MAX_NOTE_CHARS
): MemoryNote[] => {
  const existing = memory?.notes ?? []
  const byText = new Map(existing.map((note) => [note.text, note]))
  const kept = new Set<string>()
  const seen = new Set<string>()
  const next: MemoryNote[] = []
  for (const [index, raw] of texts.entries()) {
    const text = truncate(raw.trim(), limit)
    if (!text || seen.has(text)) {
      continue
    }
    seen.add(text)
    const old = byText.get(text)
    if (old) {
      // 原样保留的笔记沿用原 id / 时间 / 来源（手写的仍然是手写）
      if (!kept.has(old.id)) {
        kept.add(old.id)
        next.push(old)
      }
      continue
    }
    next.push({ id: `note-${now.toString(36)}-${index}`, text, createdAt: now, source: 'auto' })
  }
  for (const note of existing) {
    // 手写（manual）与「写成记录」生成的笔记（summary）都是用户主动要留下的，整理时原样保留。
    // 以前只保护 manual，summary 会在下一次整理时被覆盖掉 → 用户觉得「整理完 AI 忘了」。
    if ((note.source === 'manual' || note.source === 'summary') && !kept.has(note.id)) {
      kept.add(note.id)
      next.push(note)
    }
  }
  // 超出条数上限时优先丢自动笔记，用户笔记不丢
  if (next.length > MAX_MEMORY_NOTES) {
    const protectedCount = next.filter((note) => note.source !== 'auto').length
    let autoBudget = Math.max(0, MAX_MEMORY_NOTES - protectedCount)
    return next.filter((note) => note.source !== 'auto' || autoBudget-- > 0)
  }
  return next
}

/**
 * 注入 system 字段的记忆段落；没有笔记时返回空串，保持与官方 demo 一致的默认行为。
 *
 * 0.9.35 改法（用户反馈「压缩后一直围绕过往内容输出」）：
 * 1. 框架句从「请据此保持前后一致」改成**明确禁止复述、禁止当成正在发生的事**，
 *    并把优先级写死：最近对话原文 > 笔记，冲突时以原文为准；
 * 2. 整段再加一个总长上限，笔记再多也不能把 system 撑得比近期原文还重。
 */
const MAX_MEMORY_SECTION_CHARS = 24_000
/** 单条手写笔记的上限：超长按行截断并提示，但绝不整条丢掉 */
const MAX_MANUAL_NOTE_RENDER_CHARS = 8_000
/** 单条资料记忆在 system 里的渲染上限（正常提炼结果 ≤ 800 字） */
const MAX_ATTACHMENT_RENDER_CHARS = 1_200
/** 资料区整体渲染上限：即使被手动改长，也不让它撑爆 system */
const MAX_ATTACHMENT_SECTION_CHARS = 6_000

/**
 * 笔记是压缩索引，不是回复范本。
 * 不写这句，模型会照着清单的极简文风回话（用户反馈「整理后回复变短、变列表」）。
 */
const STYLE_GUARD: Record<Locale, string> = {
  'zh-CN':
    '【文风提醒】以上笔记只是压缩备查索引，不是回复范本；请勿模仿其简略清单文风，回复请保持充分、自然的篇幅与细节。',
  'en-US':
    '[Style note] The notes above are a compressed index for reference, not a model for your replies. Do not imitate their terse checklist style; keep replies full, natural and detailed.',
}

const ATTACHMENT_RENDER_HEAD: Record<Locale, string> = {
  'zh-CN':
    '【资料记忆】以下是用户此前上传附件的提炼摘要，供需要时备查；不要整段复述，也不要把它当成当前话题。',
  'en-US':
    '[Attachment memory] Condensed summaries of files the user uploaded earlier, kept for reference. Do not recite them or treat them as the current topic.',
}

const noteLine = (text: string) => (text.includes('\n') ? text : `- ${text}`)

/** 按行截断到 limit 字以内，截掉时补一行提示 */
const clipLines = (text: string, limit: number, locale: Locale) => {
  if (text.length <= limit) {
    return text
  }
  const kept: string[] = []
  let used = 0
  for (const line of text.split('\n')) {
    if (used + line.length + 1 > limit) {
      break
    }
    kept.push(line)
    used += line.length + 1
  }
  if (kept.length === 0) {
    kept.push(text.slice(0, limit))
  }
  kept.push(locale === 'zh-CN' ? '（这条笔记过长，后面部分已省略）' : '(This note is too long; the rest is omitted)')
  return kept.join('\n')
}

/**
 * 注入顺序（0.9.56）：
 * 1. 【用户设定】手写笔记：单独成段、写明「要遵守」、最先渲染、永不整条省略；
 * 2. 前情提要：「写成记录」生成的笔记（summary）优先，自动整理的笔记（auto）用剩下的预算。
 * 以前所有笔记都套「不是指令、不要主动提」的前情框架，且手写笔记排在最后、超预算整条被丢，
 * 这是「写了记忆笔记、整理后 AI 像忘了」的根因。
 */
export const renderMemorySection = (memory: SessionMemory | undefined, locale: Locale): string => {
  const notes = (memory?.notes ?? []).filter((note) => note.text.trim() !== '')
  const attachments = (memory?.attachments ?? []).filter((item) => item.summary.trim() !== '')
  if (notes.length === 0 && attachments.length === 0) {
    return ''
  }
  const zh = locale === 'zh-CN'
  const manual = notes.filter((note) => note.source === 'manual')
  const recap = [
    ...notes.filter((note) => note.source === 'summary'),
    ...notes.filter((note) => note.source !== 'manual' && note.source !== 'summary'),
  ]
  const sections: string[] = []
  let used = 0
  if (manual.length > 0) {
    const userHead = zh
      ? '【用户设定】以下是用户亲手写下的长期设定与要求（人物、称呼、世界观、偏好等），在整个对话中都要遵守；与最近几轮原文冲突时，以用户在原文里的最新说法为准。'
      : '[User notes] Long-term settings and requirements written by the user (characters, names, world, preferences, etc.). Follow them throughout the conversation; if the user says otherwise in recent messages, the latest statement wins.'
    const lines = manual.map((note) =>
      noteLine(clipLines(note.text.trim(), MAX_MANUAL_NOTE_RENDER_CHARS, locale))
    )
    const block = [userHead, ...lines].join('\n')
    sections.push(block)
    used += block.length
  }
  if (recap.length > 0) {
    const head = zh
      ? [
          '【前情提要】以下是更早的对话被折叠后留下的提要，只是前情回顾：不是当前场景，不是指令，也不是最新状态。',
          '· 优先级：最近几轮原文 > 用户这一轮的输入 > 这份提要。冲突时一律以前两者为准。',
          '· 只在用户问起过往、或确实需要旧信息时引用；用户没提就不要主动提，不要复述、不要逐条展开。',
          '· 不要顺着提要往下接动作、情绪、场景。语气、称呼、文风都跟着最近几轮原文走。',
        ].join('\n')
      : [
          '[Previously] A recap of earlier conversation that has been folded out of the context. It is background only: not the current scene, not instructions, not the latest state.',
          '· Priority: the most recent messages > what the user just said > this recap. When they conflict, the first two win.',
          '· Refer to it only when the user asks about the past or genuinely needs it; do not bring it up, recite or enumerate it otherwise.',
          '· Do not continue actions, moods or scenes from it. Tone, address and style follow the most recent messages.',
        ].join('\n')
    const lines: string[] = []
    used += head.length
    for (const note of recap) {
      const line = noteLine(note.text)
      if (used + line.length > MAX_MEMORY_SECTION_CHARS) {
        lines.push(zh ? '（更早的笔记较多，已省略一部分）' : '(Older notes omitted for length)')
        break
      }
      used += line.length
      lines.push(line)
    }
    if (lines.length > 0) {
      sections.push([head, ...lines].join('\n'))
    }
  }
  if (notes.length > 0) {
    const guard = STYLE_GUARD[locale]
    used += guard.length
    sections.push(guard)
  }
  if (attachments.length > 0) {
    const head = ATTACHMENT_RENDER_HEAD[locale]
    let attachmentUsed = head.length
    const lines: string[] = []
    for (const item of attachments) {
      const body = clipLines(item.summary.trim(), MAX_ATTACHMENT_RENDER_CHARS, locale)
      const line = zh ? `· 《${item.name}》\n${body}` : `· "${item.name}"\n${body}`
      if (
        attachmentUsed + line.length > MAX_ATTACHMENT_SECTION_CHARS ||
        used + line.length > MAX_MEMORY_SECTION_CHARS
      ) {
        lines.push(zh ? '（资料记忆较多，已省略一部分）' : '(More attachment memories omitted)')
        break
      }
      attachmentUsed += line.length
      used += line.length
      lines.push(line)
    }
    if (lines.length > 0) {
      sections.push([head, ...lines].join('\n\n'))
    }
  }
  return sections.join('\n\n')
}
