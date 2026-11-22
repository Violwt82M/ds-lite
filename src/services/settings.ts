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
  /** 余额文字按当前计费时段着色（高峰橘色 / 空闲青蓝色），默认开 */
  balanceTierColor: boolean
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
  /** 消息气泡：用客户端画的气泡显示消息（模型只输出纯文本），关掉是紧凑的旧样式 */
  bubbleSkin: boolean
  /** AI 输出气泡：AI 回答单独画成圆角气泡（原版默认不画），默认关；「消息气泡」关闭时也一起关 */
  aiBubble: boolean
  /** 显示「已读」：气泡旁的已读标记，默认关（官方 App 没有已读回执） */
  showReadMark: boolean
  /** 思考自动折叠：回答生成完自动收起思考过程，默认开（对齐原版） */
  collapseThinking: boolean
  /** 每条 AI 回复底部显示真实 token 消耗与缓存命中，默认关 */
  showTokenUsage: boolean
  /** 记忆整理后保留的最近上下文 token 数（4K~48K，默认 24K） */
  memoryKeepTokens: number
  /** 人格温度（0~100）：映射到 API temperature 0~1.5，默认 50 = 官方默认 1.0 */
  personalityTemperature: number
  /** 是否在提问尾部向模型附带当前具体时刻（HH:mm），默认关；开启后仅作温和环境参考 */
  sendClockTime: boolean
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
  balanceTierColor: 'chat-demo:balance-tier-color',
  model: 'chat-demo:model',
  fontScale: 'chat-demo:font-scale',
  recordModel: 'chat-demo:record-model',
  memoryMode: 'chat-demo:memory-mode',
  documentBudget: 'chat-demo:document-budget',
  bubbleSkin: 'chat-demo:bubble-skin',
  aiBubble: 'chat-demo:ai-bubble',
  showReadMark: 'chat-demo:show-read-mark',
  collapseThinking: 'chat-demo:collapse-thinking',
  showTokenUsage: 'chat-demo:show-token-usage',
  memoryKeepTokens: 'chat-demo:memory-keep-tokens',
  personalityTemperature: 'chat-demo:personality-temperature',
  sendClockTime: 'chat-demo:send-clock-time',
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

/**
 * 预算夹到允许区间并对齐步长：脏数据（手改 localStorage）不会把截断逻辑搞坏。
 * 必须定义在 useSettings 之前 —— zustand 的 initializer 是同步执行的，
 * 写成后面的 const 会在「存过文档上限」的机器上直接 TDZ（Cannot access before initialization）
 * 导致启动白屏（0.9.38 真机反馈，Chromium 150 也一样）。
 */
const clampDocumentBudget = (value: number) => {
  const stepped = Math.round(value / DOCUMENT_BUDGET_STEP) * DOCUMENT_BUDGET_STEP
  return Math.min(DOCUMENT_BUDGET_MAX, Math.max(DOCUMENT_BUDGET_MIN, stepped))
}

/** 记忆整理保留的上下文 token 范围（必须定义在 useSettings 之前，避免 TDZ） */
export const MEMORY_KEEP_MIN = 4_000
/** 滑杆常用区间上限：4K ~ 200K（步长 4K）；超出部分通过自定义框填写，最高 800K */
export const MEMORY_KEEP_SLIDER_MAX = 200_000
export const MEMORY_KEEP_MAX = 800_000
export const MEMORY_KEEP_STEP = 4_000
export const MEMORY_KEEP_DEFAULT = 24_000

const clampMemoryKeepTokens = (value: number) => {
  if (!Number.isFinite(value)) {
    return MEMORY_KEEP_DEFAULT
  }
  const rounded = Math.round(value / 1_000) * 1_000
  return Math.min(MEMORY_KEEP_MAX, Math.max(MEMORY_KEEP_MIN, rounded))
}

/** 人格温度滑杆：0~100，50 为官方默认（temperature 1.0） */
export const PERSONALITY_TEMPERATURE_DEFAULT = 50

/**
 * 与 clampDocumentBudget 同理：必须定义在 useSettings 之前，
 * zustand 的 initializer 是同步执行的，放在后面会在存过温度值的机器上 TDZ。
 */
const clampPersonalityTemperature = (value: number) => {
  if (!Number.isFinite(value)) {
    return PERSONALITY_TEMPERATURE_DEFAULT
  }
  return Math.min(100, Math.max(0, Math.round(value)))
}

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
  balanceTierColor: read(KEYS.balanceTierColor) !== 'false',
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
  // 默认开启：消息由客户端画成气泡（模型只输出纯文本），和「美化包」的观感一致
  bubbleSkin: read(KEYS.bubbleSkin) !== 'false',
  // 默认关闭：AI 输出气泡对齐原版（原版 AI 回答是纯文本，只有用户消息带气泡）
  aiBubble: read(KEYS.aiBubble) === 'true',
  // 默认关闭：已读标记（v0.9.51 起写死显示，用户反馈莫名其妙）
  showReadMark: read(KEYS.showReadMark) === 'true',
  // 默认开启：生成完自动折叠思考（对齐原版）
  collapseThinking: read(KEYS.collapseThinking) !== 'false',
  // 默认关闭：每条回答底部显示官方返回的真实 token 消耗与缓存命中
  showTokenUsage: read(KEYS.showTokenUsage) === 'true',
  // 默认 24,000 token：整理记忆时保留最近这么多原文不折叠
  memoryKeepTokens: (() => {
    const raw = read(KEYS.memoryKeepTokens)
    return raw === null ? MEMORY_KEEP_DEFAULT : clampMemoryKeepTokens(Number(raw))
  })(),
  // 默认 50 = temperature 1.0（官方默认）；存 0~100 整数，请求时按 /50 映射到 0~2
  personalityTemperature: (() => {
    const raw = read(KEYS.personalityTemperature)
    // 没存过时 Number(null) 是 0，会把默认温度误判成 0.0；必须先用 null 判断
    return raw === null ? PERSONALITY_TEMPERATURE_DEFAULT : clampPersonalityTemperature(Number(raw))
  })(),
  // 默认关：需要模型感知具体几点几分时可在「设置 → 通用」开启（放在提问尾部，不伤前缀缓存）
  sendClockTime: read(KEYS.sendClockTime) === 'true',
}))

/** 消息气泡开关：模型输出纯文本，气泡由客户端绘制 */
export const setBubbleSkin = (bubbleSkin: boolean) => {
  write(KEYS.bubbleSkin, String(bubbleSkin))
  useSettings.setState({ bubbleSkin })
}

/** AI 输出气泡开关：AI 回答是否单独画气泡，默认关（对齐原版） */
export const setAiBubble = (aiBubble: boolean) => {
  write(KEYS.aiBubble, String(aiBubble))
  useSettings.setState({ aiBubble })
}

/** 已读标记开关，默认关 */
export const setShowReadMark = (showReadMark: boolean) => {
  write(KEYS.showReadMark, String(showReadMark))
  useSettings.setState({ showReadMark })
}

/** 思考自动折叠开关，默认开 */
export const setCollapseThinking = (collapseThinking: boolean) => {
  write(KEYS.collapseThinking, String(collapseThinking))
  useSettings.setState({ collapseThinking })
}

/** 每条对话 token 与缓存显示开关，默认关 */
export const setShowTokenUsage = (showTokenUsage: boolean) => {
  write(KEYS.showTokenUsage, String(showTokenUsage))
  useSettings.setState({ showTokenUsage })
}

/** 向模型提供具体时刻开关，默认关 */
export const setSendClockTime = (sendClockTime: boolean) => {
  write(KEYS.sendClockTime, String(sendClockTime))
  useSettings.setState({ sendClockTime })
}

/** 记忆整理保留的最近上下文 token 数（4K~48K） */
export const setMemoryKeepTokens = (value: number) => {
  const next = clampMemoryKeepTokens(value)
  write(KEYS.memoryKeepTokens, String(next))
  useSettings.setState({ memoryKeepTokens: next })
}

/** 人格温度滑杆：0~100，50 为官方默认（temperature 1.0） */
export const setPersonalityTemperature = (personalityTemperature: number) => {
  const next = clampPersonalityTemperature(personalityTemperature)
  write(KEYS.personalityTemperature, String(next))
  useSettings.setState({ personalityTemperature: next })
}

/**
 * 滑杆值 → temperature：左半段 0~50 → 0.0~1.0，右半段 50~100 → 1.0~1.5。
 * 实测（2026-11-20，flash 与 v4 pro 都一样，不是 pro 专属问题）：非思考模式 temperature 2.0
 * 会整段输出乱码，1.5 仍然正常；深度思考下服务端固定 1.0，发了也不生效。
 * 所以上限压到 1.5，旧版存的 51~100 自动落进新区间，不会再出现 2.0。
 */
export const temperatureValue = (personalityTemperature: number): number =>
  personalityTemperature <= PERSONALITY_TEMPERATURE_DEFAULT
    ? personalityTemperature / 50
    : 1 + (personalityTemperature - PERSONALITY_TEMPERATURE_DEFAULT) / 100

/** 请求用的 temperature（0~1.5）；等于官方默认 1.0 时不发字段，保持旧行为 */
export const requestTemperature = (personalityTemperature: number): number | undefined =>
  personalityTemperature === PERSONALITY_TEMPERATURE_DEFAULT
    ? undefined
    : Math.round(temperatureValue(personalityTemperature) * 100) / 100

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

export const setBalanceTierColor = (balanceTierColor: boolean) => {
  write(KEYS.balanceTierColor, String(balanceTierColor))
  useSettings.setState({ balanceTierColor })
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
