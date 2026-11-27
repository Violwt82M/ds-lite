import { isTranslationKey, translate } from '../../i18n/index.js'
import { classifyStatus } from '../api/errors.js'
import type { AssistantMessage } from './types.js'

export type Notice = {
  text: string
  /** 模板答复使用正文样式；其余统一为红色错误提示。 */
  presentation?: 'response'
  /** 需要用户处理的问题附带的操作 */
  action?: 'apiKey' | 'topUp'
  /** 技术详情（HTTP 状态码 + 服务端原文）：折叠展示，主文案只给中文原因和建议 */
  detail?: string
}

const getTemplateText = (reply: AssistantMessage) =>
  reply.blocks
    .map((block) => (block.type === 'text' && block.isTemplate ? block.text : ''))
    .join('')

/** 技术详情：状态码 + 原始报错，用户反馈问题时能直接复制 */
const failureDetail = (status: number | undefined, message: string): string | undefined => {
  const parts: string[] = []
  if (status !== undefined) {
    parts.push(`HTTP ${status}`)
  }
  if (message) {
    parts.push(message)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/**
 * 回复出错或未正常结束时展示的提示。
 * 原则：主文案一律「中文原因（含状态码）+ 一句能照做的建议」，
 * 服务端英文原文收进 detail 折叠区（以前 400/413/未知错误会把英文原样甩给用户）。
 */
export const describeReply = (reply: AssistantMessage): Notice | null => {
  if (reply.status === 'error' && reply.error) {
    const { kind, status, localMessage } = reply.error
    const detail = failureDetail(status, reply.error.message)
    // 导入的历史可能来自不同版本；不识别的文案沿用保存时的原文。
    if (localMessage && isTranslationKey(localMessage.key)) {
      return { text: translate(localMessage.key, localMessage.params), detail }
    }
    // 历史补传错误刷新后仍需说明原因，恢复沿用附件卡片或重新生成。
    if (kind === 'upload') {
      return { text: translate('uploadFileStatusFailed'), detail }
    }
    if (kind === 'network') {
      return { text: translate('commonNetworkErrorToast'), detail }
    }
    // 流没等到 message_stop 就断了：以前 message 为空串时这里返回 null，界面上一个字都没有
    if (kind === 'interrupted') {
      return { text: translate('replyInterrupted'), detail }
    }
    // 拿到的不是 SSE / 不是 JSON：多半地址打到了网页或中转服务
    if (kind === 'protocol') {
      return { text: translate('replyProtocolError'), detail }
    }
    // 扩展模式（联网 / 阅读链接 / 严格审查）的输入上限只有 32768 token
    if (status === 400 && /user input too long/i.test(reply.error.message)) {
      const tokens = /(\d+)\s*tokens/i.exec(reply.error.message)?.[1] ?? '?'
      return { text: translate('replyInputTooLong', { tokens }), detail }
    }
    // 服务端算出的 token 超过 1,048,576：文档里明确说过会直接 400
    if (status === 400 && /maximum context length/i.test(reply.error.message)) {
      return { text: translate('replyContextTooLong'), detail }
    }
    // 官方已对 v4 pro 关闭服务端联网 / 标题 / 时间提醒：专门的文案，别再说「内容不合规」
    if (status === 400 && /unavailable for model deepseek-v4-pro/i.test(reply.error.message)) {
      return { text: translate('replyProCapsUnavailable'), detail }
    }
    // 400 细分：区分图片总大小超限、附件失效、请求格式/历史元数据异常、内容检查拦截
    if (status === 400) {
      if (/total\s+size\s+of\s+image/i.test(reply.error.message)) {
        return { text: translate('replyImageTotalTooLarge'), detail }
      }
      if (
        /file_ids? do not exist|file data not found|invalid file_id|unsupported.*(file|image|document)|attachment/i.test(
          reply.error.message
        )
      ) {
        return { text: translate('replyBadRequestAttachment'), detail }
      }
      if (
        /invalid\s+['"`]?messages|invalid\s+date|invalid\s+parameter|missing\s+required|unexpected\s+field|malformed|json/i.test(
          reply.error.message
        )
      ) {
        return { text: translate('replyBadRequestFormat'), detail }
      }
      if (
        /content\s*(policy|filter|risk|moderation|safety)|inappropriate|sensitive|violat/i.test(
          reply.error.message
        )
      ) {
        return { text: translate('replyBadRequestContent'), detail }
      }
    }
    switch (classifyStatus(status)) {
      case 'unauthorized':
        return { text: translate('replyInvalidApiKey'), action: 'apiKey', detail }
      case 'insufficientBalance':
        return { text: translate('replyInsufficientBalance'), action: 'topUp', detail }
      case 'tooLarge':
        return { text: translate('replyPayloadTooLarge'), detail }
      case 'rateLimited':
        return { text: translate('replyRateLimited'), detail }
      case 'serverBusy':
        return { text: translate('completionServerBusyToast'), detail }
      case 'badRequest':
        return { text: translate('replyBadRequest'), detail }
      case 'forbidden':
        return { text: translate('replyForbidden'), detail }
      case 'notFound':
        return { text: translate('replyNotFound'), detail }
      case 'methodNotAllowed':
        return { text: translate('replyMethodNotAllowed'), detail }
      case 'network':
        return { text: translate('commonNetworkErrorToast'), detail }
      default:
        return { text: translate('replyUnknownError'), detail }
    }
  }
  const template = getTemplateText(reply)
  // 归档不带结构化错误，错误文案保存在模板中，仍按错误提示展示。
  if (reply.status === 'error' && template) {
    return { text: template }
  }
  if (reply.stopReason === 'refusal') {
    // 导入的拒绝回复优先展示归档中的模板，普通正文仍不可展示。
    return { text: template || translate('replyRefused'), presentation: 'response' }
  }
  if (template) {
    return { text: template, presentation: 'response' }
  }
  return null
}
