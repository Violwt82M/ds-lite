import { create } from 'zustand'
import { isCustomApiOrigin } from './base.js'

/**
 * 自定义 API 地址的协议（0.9.37）。
 *
 * 默认仍是 DeepSeek 的 Anthropic 兼容协议；只是让用户能把「硅基流动 / OpenRouter / 任何
 * OpenAI 兼容服务」接进来。**不是多 provider 工作台**：不引入 provider 列表、不改变
 * 「官方优先」的产品口径，只是把现有「自定义 API 地址」这一个入口做兼容。
 *
 * 已知降级（OpenAI 通道）：联网搜索、内容审查、服务端标题、Files API 附件、余额、语音都不支持，
 * 相关开关会被禁用并在界面写明原因——宁可说「不支持」，也不要给一个看着能用其实没生效的开关。
 */
export type ApiProtocol = 'anthropic' | 'openai'

const PROTOCOL_KEY = 'chat-demo:api-protocol'
const MODEL_KEY = 'chat-demo:custom-model'

/** OpenAI 兼容服务的模型名要用户自己填；默认给个 DeepSeek 的，接别家时要改 */
export const DEFAULT_CUSTOM_MODEL = 'deepseek-flash'

const readProtocol = (): ApiProtocol => {
  try {
    return localStorage.getItem(PROTOCOL_KEY) === 'openai' ? 'openai' : 'anthropic'
  } catch {
    return 'anthropic'
  }
}

const readModel = (): string => {
  try {
    const saved = localStorage.getItem(MODEL_KEY)?.trim()
    return saved || DEFAULT_CUSTOM_MODEL
  } catch {
    return DEFAULT_CUSTOM_MODEL
  }
}

export const useApiProtocol = create<{ protocol: ApiProtocol; model: string }>(() => ({
  protocol: readProtocol(),
  model: readModel(),
}))

export const getApiProtocol = () => useApiProtocol.getState().protocol

/** OpenAI 通道下请求要用的模型名（用户自己填） */
export const getCustomModel = () => useApiProtocol.getState().model

export const setApiProtocol = (protocol: ApiProtocol) => {
  useApiProtocol.setState({ protocol })
  try {
    localStorage.setItem(PROTOCOL_KEY, protocol)
  } catch {
    // 存不下只影响下次打开
  }
}

export const setCustomModel = (model: string) => {
  const next = model.trim() || DEFAULT_CUSTOM_MODEL
  useApiProtocol.setState({ model: next })
  try {
    localStorage.setItem(MODEL_KEY, next)
  } catch {
    // 同上
  }
}

/** 官方地址永远走 Anthropic 兼容协议，只有自定义地址才可能切成 OpenAI */
export const usesOpenAiProtocol = () => isCustomApiOrigin() && getApiProtocol() === 'openai'
