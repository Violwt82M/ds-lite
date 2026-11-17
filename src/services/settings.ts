import { create } from 'zustand'
import type { ChatModel } from './api/types.js'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'
import {
  DOCUMENT_BUDGET_DEFAULT,
  DOCUMENT_BUDGET_MAX,
  DOCUMENT_BUDGET_MIN,
  DOCUMENT_BUDGET_STEP,
} from './documentBudget.js'

export type Locale = 'zh-CN' | 'en-US'

/**
 * 内容审查等级：
 * - low：官方 API 默认行为（等同不传 safety_check）
 * - high：额外开启基础风险控制，输入输出都复检，完整输出后再审一次，不合格整轮置为 refusal
 */
export type SafetyLevel = 'low' | 'high'

/** 思考强度：对应 API 的 output_config.effort，low 更快更省，max 想得更久 */
export type ThinkingEffort = 'low' | 'high' | 'max'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = {
  apiKey: string | null
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  /** 思考强度，只在开启深度思考时生效 */
  thinkingEffort: ThinkingEffort
  search: boolean
  safety: SafetyLevel
  siderCollapsed: boolean
  /** 上下文变长后自动整理成记忆笔记（会产生一次极小的额外调用费用） */
  autoMemory: boolean
  /** 顶栏显示账户余额（默认开，可在设置里关掉） */
  showBalance: boolean
  /** 对话用的模型；v4 pro 更强但不支持图片理解 */
  model: ChatModel
  /** 界面字号百分比：90 / 100 / 110 / 120 / 130 */
  fontScale: number
  /** 记忆整理模式：自动判断 / 强制角色扮演 / 强制普通对话 */
  memoryMode: MemoryMode
  /** 生成「记录」用的模型（默认 flash，花钱少） */
  recordModel: ChatModel
  /** 单份文档的 token 预算（设置里无级滑杆可调），决定「模型最多读多少字」 */
  documentBudget: number
}

/** 记忆整理模式：auto 让模型自己判断对话类型 */
export type MemoryMode = 'auto' | 'rp' | 'plain'

/** 允许的字号档位（百分比） */
export const FONT_SCALES: readonly number[] = [90, 100, 110, 120, 130]

const KEYS = {
  apiKey: 'chat-demo:api-key',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  thinkingEffort: 'chat-demo:thinking-effort',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
  safety: 'chat-demo:safety',
  autoMemory: 'chat-demo:auto-memory',
  showBalance: 'chat-demo:show-balance',
  model: 'chat-demo:model',
  fontScale: 'chat-demo:font-scale',
  recordModel: 'chat-demo:record-model',
  memoryMode: 'chat-demo:memory-mode',
  documentBudget: 'chat-demo:document-budget',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  // 默认 low：更快更省；显式选过高/最高的人保持自己的选择
  thinkingEffort:
    read(KEYS.thinkingEffort) === 'high' || read(KEYS.thinkingEffort) === 'max'
      ? (read(KEYS.thinkingEffort) as ThinkingEffort)
      : 'low',
  search: read(KEYS.search) === 'true',
  // 默认走官方 API 的默认档；只有显式选过"严格"才用 high
  safety: read(KEYS.safety) === 'high' ? 'high' : 'low',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
  // 默认开启：长对话自动整理，避免上下文越滚越大
  autoMemory: read(KEYS.autoMemory) !== 'false',
  // 默认开启：顶栏显示余额，嫌碍眼可以关
  showBalance: read(KEYS.showBalance) !== 'false',
  fontScale: (() => {
    const saved = Number(read(KEYS.fontScale))
    return FONT_SCALES.includes(saved) ? saved : 100
  })(),
  memoryMode: ((): MemoryMode => {
    const saved = read(KEYS.memoryMode)
    return saved === 'rp' || saved === 'plain' ? saved : 'auto'
  })(),
  recordModel: read(KEYS.recordModel) === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
  documentBudget: (() => {
    const saved = Number(read(KEYS.documentBudget))
    if (!Number.isFinite(saved) || saved <= 0) {
      return DOCUMENT_BUDGET_DEFAULT
    }
    return clampDocumentBudget(saved)
  })(),
  // 默认 flash：更快更便宜，而且支持图片
  model: read(KEYS.model) === 'deepseek-v4-pro' ? 'deepseek-v4-pro' : 'deepseek-flash',
}))

/** 预算夹到允许区间并对齐步长：脏数据（手改 localStorage）不会把截断逻辑搞坏 */
const clampDocumentBudget = (value: number) => {
  const stepped = Math.round(value / DOCUMENT_BUDGET_STEP) * DOCUMENT_BUDGET_STEP
  return Math.min(DOCUMENT_BUDGET_MAX, Math.max(DOCUMENT_BUDGET_MIN, stepped))
}

export const setDocumentBudget = (value: number) => {
  const next = clampDocumentBudget(value)
  write(KEYS.documentBudget, String(next))
  useSettings.setState({ documentBudget: next })
}

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  write(KEYS.apiKey, apiKey)
  useSettings.setState({ apiKey })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setThinkingEffort = (thinkingEffort: ThinkingEffort) => {
  write(KEYS.thinkingEffort, thinkingEffort)
  useSettings.setState({ thinkingEffort })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSafety = (safety: SafetyLevel) => {
  write(KEYS.safety, safety)
  useSettings.setState({ safety })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}

export const setAutoMemory = (autoMemory: boolean) => {
  write(KEYS.autoMemory, String(autoMemory))
  useSettings.setState({ autoMemory })
}

export const setShowBalance = (showBalance: boolean) => {
  write(KEYS.showBalance, String(showBalance))
  useSettings.setState({ showBalance })
}

export const setModel = (model: ChatModel) => {
  write(KEYS.model, model)
  useSettings.setState({ model })
}

export const setRecordModel = (recordModel: ChatModel) => {
  write(KEYS.recordModel, recordModel)
  useSettings.setState({ recordModel })
}

export const setMemoryMode = (memoryMode: MemoryMode) => {
  write(KEYS.memoryMode, memoryMode)
  useSettings.setState({ memoryMode })
}

export const setFontScale = (fontScale: number) => {
  const next = FONT_SCALES.includes(fontScale) ? fontScale : 100
  write(KEYS.fontScale, String(next))
  useSettings.setState({ fontScale: next })
}
