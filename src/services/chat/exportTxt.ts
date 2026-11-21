import { getVisibleMessages } from './branches.js'
import type { AssistantMessage, Session, UserMessage } from './types.js'

const STORAGE_KEY = 'chat-demo:export-txt-options'

export type ExportTxtOptions = {
  /** 是否包含思考过程（默认关） */
  includeThinking: boolean
  /** 是否包含时间与模型名（默认开） */
  includeMeta: boolean
  /** 是否优先显示人设名字（默认开；未绑定人设时显示 AI） */
  showPersonaName: boolean
  /** 自定义用户在 txt 内的名字（默认「我」） */
  userName: string
}

export const DEFAULT_EXPORT_TXT_OPTIONS: ExportTxtOptions = {
  includeThinking: false,
  includeMeta: true,
  showPersonaName: true,
  userName: '我',
}

export const readExportTxtOptions = (): ExportTxtOptions => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { ...DEFAULT_EXPORT_TXT_OPTIONS }
    }
    const parsed = JSON.parse(raw) as Partial<ExportTxtOptions>
    return {
      includeThinking:
        typeof parsed.includeThinking === 'boolean'
          ? parsed.includeThinking
          : DEFAULT_EXPORT_TXT_OPTIONS.includeThinking,
      includeMeta:
        typeof parsed.includeMeta === 'boolean'
          ? parsed.includeMeta
          : DEFAULT_EXPORT_TXT_OPTIONS.includeMeta,
      showPersonaName:
        typeof parsed.showPersonaName === 'boolean'
          ? parsed.showPersonaName
          : DEFAULT_EXPORT_TXT_OPTIONS.showPersonaName,
      userName:
        typeof parsed.userName === 'string'
          ? parsed.userName
          : DEFAULT_EXPORT_TXT_OPTIONS.userName,
    }
  } catch {
    return { ...DEFAULT_EXPORT_TXT_OPTIONS }
  }
}

export const saveExportTxtOptions = (options: ExportTxtOptions): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options))
  } catch {
    // 存储不可用时仅本次生效
  }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

const formatDateTime = (timestamp: number): string => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return ''
  }
  const d = new Date(timestamp)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

const formatFileDate = (date: Date): string =>
  `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`

const formatUserBody = (message: UserMessage): string => {
  const parts: string[] = []
  if (Array.isArray(message.files) && message.files.length > 0) {
    const names = message.files.map((f) => f.displayName || f.name).filter(Boolean)
    if (names.length > 0) {
      parts.push(`[附件：${names.join('、')}]`)
    }
  }
  const text = message.content.trim()
  if (text) {
    parts.push(text)
  }
  return parts.join('\n')
}

const formatAssistantBody = (message: AssistantMessage, includeThinking: boolean): string => {
  const thinkingParts: string[] = []
  const textParts: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'thinking') {
      const content = block.thinking.trim()
      if (includeThinking && content) {
        thinkingParts.push(content)
      }
    } else if (block.type === 'text') {
      if (block.isTemplate) {
        continue
      }
      const content = block.text.trim()
      if (content) {
        textParts.push(content)
      }
    }
  }
  const sections: string[] = []
  if (thinkingParts.length > 0) {
    sections.push(`【思考过程】\n${thinkingParts.join('\n\n')}`)
  }
  if (textParts.length > 0) {
    sections.push(
      thinkingParts.length > 0 ? `【正文】\n${textParts.join('\n\n')}` : textParts.join('\n\n')
    )
  }
  return sections.join('\n\n')
}

/** 将单个会话的当前可见分支导出为易读的 UTF-8 TXT 文件 */
export const buildSessionTxt = (
  session: Session,
  options: ExportTxtOptions,
  personaName?: string | null
): { name: string; blob: Blob } => {
  const title = session.title.trim() || '新对话'
  const userLabel = options.userName.trim() || '我'
  const aiLabel =
    options.showPersonaName && personaName && personaName.trim() ? personaName.trim() : 'AI'
  const now = new Date()
  const lines: string[] = [
    `对话标题：${title}`,
    `导出时间：${formatDateTime(now.getTime())}`,
    '========================================',
    '',
  ]

  const visible = getVisibleMessages(session)
  for (const message of visible) {
    if (message.role === 'user') {
      const body = formatUserBody(message)
      if (!body) {
        continue
      }
      const meta = options.includeMeta ? formatDateTime(message.createdAt) : ''
      lines.push(`【${userLabel}${meta ? ` · ${meta}` : ''}】`)
      lines.push(body)
      lines.push('')
    } else {
      const body = formatAssistantBody(message, options.includeThinking)
      if (!body) {
        continue
      }
      const metaItems: string[] = []
      if (options.includeMeta) {
        const time = formatDateTime(message.createdAt)
        if (time) {
          metaItems.push(time)
        }
        if (message.model) {
          metaItems.push(message.model)
        }
      }
      const meta = metaItems.join(' · ')
      lines.push(`【${aiLabel}${meta ? ` · ${meta}` : ''}】`)
      lines.push(body)
      lines.push('')
    }
  }

  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'chat'
  const fileName = `${safeTitle}-${formatFileDate(now)}.txt`
  // 加 UTF-8 BOM，确保 Windows 记事本和各类手机文本阅读器不乱码
  const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/plain;charset=utf-8' })
  return { name: fileName, blob }
}
