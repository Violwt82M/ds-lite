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

/** 从 latestReminder 提取具体时分；历史旧快照无时分时返回 null */
export const extractClockTime = (reminder: string): string | null => {
  const match = /^\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2})(?=,|$)/.exec(reminder)
  return match?.[1] ?? null
}

/** 模型约定的五项信息；日期、具体时间与星期使用浏览器本地时区，避免 UTC 日期跨日。 */
export const createLatestReminder = (
  { locale, location }: { locale: Locale; location: UserLocation | null },
  now = new Date()
): string => {
  return [
    `${formatDate(now)} ${formatClockTime(now)}`,
    new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now),
    locationName(location, locale),
    'Web',
    translate('latestReminderLanguage'),
  ].join(',')
}
