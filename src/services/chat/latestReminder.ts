import { getRegionName, provinces, type UserLocation } from '../location.js'
import type { Locale } from '../settings.js'
import { formatDate } from '../../utils/format.js'
import { translate } from '../../i18n/index.js'

const locationName = (location: UserLocation | null, locale: Locale): string => {
  if (!location) {
    return ''
  }
  if (location.region === 'CN' && locale === 'zh-CN') {
    const province = provinces.find((item) => item.code === location.province)
    const city = province?.cities.find((item) => item.code === location.city)
    return city?.name ?? province?.name ?? getRegionName('CN', locale)
  }
  return getRegionName(location.region, locale)
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 浏览器本地 24 小时制时分（HH:mm） */
export const formatClockTime = (now = new Date()): string =>
  `${pad2(now.getHours())}:${pad2(now.getMinutes())}`

/** 从 latestReminder 中剥离具体时分，仅保留日期与星期（供 v4-pro 放进 system 保住前缀缓存） */
export const stripClockTime = (reminder: string): string =>
  reminder.replace(/^(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}(?=,|$)/, '$1')

/** 校验 YYYY-MM-DD 是否为真实存在的公历日期 */
const isValidIsoDate = (dateText: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText)
  if (!match) {
    return false
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false
  }
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  )
}

/**
 * 规范化并校验 latest_reminder 快照（服务端严格要求五段逗号分隔：
 * `<YYYY-MM-DD>,<weekday>,<location>,<platform>,<language>`）。
 *
 * 历史旧版本（0.9.65 附近）曾在日期段写入 `YYYY-MM-DD HH:mm`，服务端会直接 400 拒绝整条会话。
 * 这里先剥离多余时分，再校验五段结构与日期合法性；无法修复的畸形快照返回 undefined 静默丢弃。
 */
export const normalizeLatestReminder = (reminder: string | undefined): string | undefined => {
  if (!reminder) {
    return undefined
  }
  const stripped = stripClockTime(reminder.trim())
  const parts = stripped.split(',')
  if (parts.length !== 5) {
    return undefined
  }
  const [date, weekday, , platform, language] = parts
  if (!date || !isValidIsoDate(date)) {
    return undefined
  }
  if (!weekday?.trim() || !platform?.trim() || !language?.trim()) {
    return undefined
  }
  return stripped
}

/** 从 latestReminder 提取具体时分；历史旧快照无时分时返回 null */
export const extractClockTime = (reminder: string): string | null => {
  const match = /^\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2})(?=,|$)/.exec(reminder)
  return match?.[1] ?? null
}

/** 模型约定的五项信息；日期与星期使用浏览器本地时区，避免 UTC 日期跨日（服务端只接受 YYYY-MM-DD，带具体时分会被 400 invalid date 拒绝）。 */
export const createLatestReminder = (
  { locale, location }: { locale: Locale; location: UserLocation | null },
  now = new Date()
): string => {
  return [
    formatDate(now),
    new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now),
    locationName(location, locale),
    'Web',
    translate('latestReminderLanguage'),
  ].join(',')
}
