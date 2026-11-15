/**
 * Token 用量解析、费用估算与人类可读格式化。
 *
 * 价格来源（人民币，每百万 tokens，2026-11-15 抓取）：
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md
 *
 * 官方区分高峰 / 空闲两档价，空闲时段为高峰的一半（北京时间周一至周五 9:00-12:00、
 * 14:00-18:00 为高峰，其余时间与周末为半价）。PRICING 里记录高峰价，
 * estimateCost 按回答产生的时间判断档位：没有时间信息时才退化为高峰价（上界估算）。
 *
 * 接口层面的 usage 字段含义（见 src/services/api/types.ts 的 MessageUsage）：
 * input_tokens 是未命中缓存的输入；cache_creation_input_tokens 是写入缓存的部分；
 * cache_read_input_tokens 是命中缓存的部分。缓存写入没有单独报价，按未命中输入价计。
 */

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** 计价档位：高峰（工作日白天）与空闲（空闲时段半价） */
export type PriceTier = 'peak' | 'offpeak'

export type CostEstimate = {
  inputCny: number
  outputCny: number
  totalCny: number
  model: string
  /** 按回答产生时间判断的档位 */
  tier: PriceTier
}

/** 北京时间相对 UTC 的偏移；官方定价按北京时间划分峰谷，不受设备时区影响 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000
/** 高峰时段（北京时间，分钟数）：工作日 09:00-12:00、14:00-18:00 */
const PEAK_RANGES: readonly (readonly [number, number])[] = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]
/** 空闲时段价格系数：官方为高峰价的一半 */
const OFFPEAK_RATIO = 0.5

/** 某时刻属于哪个计价档位；时间无法解析时按高峰（较贵的一档）处理 */
export const priceTierAt = (at: Date | number): PriceTier => {
  const date = at instanceof Date ? at : new Date(at)
  const time = date.getTime()
  if (!Number.isFinite(time)) {
    return 'peak'
  }
  // 平移到北京时间后只用 UTC 字段，避免设备时区把高峰时段算错
  const beijing = new Date(time + BEIJING_OFFSET_MS)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) {
    return 'offpeak'
  }
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return PEAK_RANGES.some(([start, end]) => minutes >= start && minutes < end)
    ? 'peak'
    : 'offpeak'
}

/**
 * 每百万 tokens 的人民币价格（已抓到真实值）。
 * 若将来页面抓取失败、拿不到价格，请写 0 并标 TODO + 保留 sourceUrl，不要编造。
 */
export const PRICING: Record<
  string,
  {
    inputPerMTok: number
    outputPerMTok: number
    cacheReadPerMTok?: number
    sourceUrl: string
    fetchedAt: string
  }
> = {
  'deepseek-flash': {
    // 高峰：输入（未命中）2 元 / 百万 tokens，输出 8 元 / 百万 tokens，命中缓存 0.04 元
    inputPerMTok: 2,
    outputPerMTok: 8,
    cacheReadPerMTok: 0.04,
    sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md',
    fetchedAt: '2026-11-15',
  },
  'deepseek-v4-pro': {
    // 高峰：输入（未命中）9 元 / 百万 tokens，输出 27 元 / 百万 tokens，命中缓存 0.30 元
    inputPerMTok: 9,
    outputPerMTok: 27,
    cacheReadPerMTok: 0.3,
    sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing.md',
    fetchedAt: '2026-11-15',
  },
}

/** 数值容错：只接受有限非负数，其余按 0 */
const toNumber = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0
  return v
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** 依次尝试多个候选字段名，取第一个有效数字 */
const pick = (obj: Record<string, unknown>, ...keys: string[]): number => {
  for (const key of keys) {
    const value = toNumber(obj[key])
    if (value > 0) return value
  }
  return 0
}

const CACHE_READ_KEYS = ['cache_read_input_tokens', 'cacheReadInputTokens', 'cacheReadTokens']
const CACHE_WRITE_KEYS = [
  'cache_creation_input_tokens',
  'cacheCreationInputTokens',
  'cacheWriteTokens',
]
const INPUT_KEYS = ['input_tokens', 'inputTokens', 'prompt_tokens']
const OUTPUT_KEYS = ['output_tokens', 'outputTokens', 'completion_tokens']
const ALL_KEYS = [...INPUT_KEYS, ...OUTPUT_KEYS, ...CACHE_READ_KEYS, ...CACHE_WRITE_KEYS]

/**
 * 容错读取用量：字段缺失按 0；传入 null / 非对象 / 四个字段一个都读不到时返回 null。
 * 也接受 `{ usage: {...} }` 这样多包一层的结构（如 message_start 事件）。
 */
export const readUsage = (usage: unknown): TokenUsage | null => {
  if (!isRecord(usage)) return null

  // 多包一层的情况：只在本身完全没有用量字段时才向下钻取，避免误读其它嵌套字段
  if (!ALL_KEYS.some((key) => key in usage) && isRecord(usage.usage)) {
    return readUsage(usage.usage)
  }

  // 至少出现一个已知字段才算"读到了"；全是 0 也视为有效用量（例如刚 message_start）
  const hasAny = ALL_KEYS.some((key) => key in usage)
  if (!hasAny) return null

  return {
    inputTokens: pick(usage, ...INPUT_KEYS),
    outputTokens: pick(usage, ...OUTPUT_KEYS),
    cacheReadTokens: pick(usage, ...CACHE_READ_KEYS),
    cacheWriteTokens: pick(usage, ...CACHE_WRITE_KEYS),
  }
}

/**
 * 估算费用：未知模型返回 null（不猜价格）。
 * 缓存命中部分按 cacheReadPerMTok 计；缺少该价格时按普通输入价计并已在 PRICING 注释里说明。
 * 缓存写入按输入（未命中）价计。
 * at 为该次请求（回答）的时间：据此判断高峰 / 空闲，空闲时段整体按半价；
 * 不传时按高峰价估算，属于上界。
 */
export const estimateCost = (
  model: string,
  usage: TokenUsage,
  at?: Date | number
): CostEstimate | null => {
  if (typeof model !== 'string' || usage === null || typeof usage !== 'object') return null
  const key = model.trim().toLowerCase()
  const price = PRICING[key]
  if (!price) return null

  const tier: PriceTier = at === undefined ? 'peak' : priceTierAt(at)
  const rate = tier === 'offpeak' ? OFFPEAK_RATIO : 1
  const inputPerMTok = price.inputPerMTok * rate
  const cacheReadPerMTok = (price.cacheReadPerMTok ?? price.inputPerMTok) * rate

  const billableInput = usage.inputTokens + usage.cacheWriteTokens
  const inputCny =
    (billableInput / 1_000_000) * inputPerMTok +
    (usage.cacheReadTokens / 1_000_000) * cacheReadPerMTok
  const outputCny = (usage.outputTokens / 1_000_000) * price.outputPerMTok * rate

  return {
    inputCny,
    outputCny,
    totalCny: inputCny + outputCny,
    model: key,
    tier,
  }
}

/** 千分位；一百万及以上用 M 后缀（一位小数，去掉多余的 .0） */
export const formatTokens = (n: number): string => {
  const value = toNumber(n)
  if (value >= 1_000_000) {
    const millions = Math.round(value / 100_000) / 10
    const fixed = millions.toFixed(1).replace(/\.0$/, '')
    return `${fixed}M`
  }
  return Math.round(value).toLocaleString('en-US')
}

/** 人民币金额：小于 0.0001 且大于 0 时显示 ¥<0.0001；小于 1 保留 4 位，否则保留 2 位 */
export const formatCny = (n: number): string => {
  const value = toNumber(n)
  if (value === 0) return '¥0.0000'
  if (value < 0.0001) return '¥<0.0001'
  if (value < 1) return `¥${value.toFixed(4)}`
  return `¥${value.toFixed(2)}`
}

/** 一行人类可读用量；没有费用估算时只显示 token 数，有估算时标出峰谷档位 */
export const formatUsageLine = (usage: TokenUsage, cost: CostEstimate | null): string => {
  const tokens = `输入 ${formatTokens(usage.inputTokens)} · 输出 ${formatTokens(usage.outputTokens)}`
  if (!cost) return tokens
  const tier = cost.tier === 'offpeak' ? '空闲价' : '高峰价'
  return `${tokens} · 约 ${formatCny(cost.totalCny)}（${tier}）`
}
