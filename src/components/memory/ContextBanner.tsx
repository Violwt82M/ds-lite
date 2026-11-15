import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { compactSessionMemory, useChatStore } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import {
  formatCharCount,
  getContextLevel,
  getContextUsage,
} from '../../services/memory/context.js'
import { openMemoryPanel, useMemoryPanel } from '../../services/memory/state.js'
import { useSettings } from '../../services/settings.js'
import styles from './ContextBanner.module.css'

/**
 * 会话页顶部的上下文条：四档配色常驻显示，蓝色也留着「立即整理」——
 * 上下文越短每轮越省，蓝色只是"不必着急"而不是"不用管"。
 */
export const ContextBanner = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const usage = useMemo(() => getContextUsage(session), [session])
  const level = getContextLevel(usage.ratio)
  const compacting = useMemoryPanel((state) => Boolean(state.compacting[session.id]))
  const notice = useMemoryPanel((state) => state.notices[session.id])
  const streaming = useChatStore((state) => Boolean(state.streaming[session.id]))
  const autoMemory = useSettings((state) => state.autoMemory)
  // 自动整理完成后显示 8 秒，告诉用户刚刚发生了什么
  const [noticeVisible, setNoticeVisible] = useState(false)
  useEffect(() => {
    if (!notice) {
      return
    }
    setNoticeVisible(true)
    const timer = window.setTimeout(() => setNoticeVisible(false), 8000)
    return () => window.clearTimeout(timer)
  }, [notice?.at, notice])

  const used = formatCharCount(usage.usedTokens)
  const percent = Math.min(100, Math.round(usage.ratio * 100))
  const levelText =
    level === 'low'
      ? t('contextBannerLow', { used, percent })
      : level === 'mid'
        ? t('contextBannerMid', { used, percent })
        : level === 'high'
          ? t(autoMemory ? 'contextBannerHighAuto' : 'contextBannerHigh', { used, percent })
          : t('contextBannerCritical', { used, percent })
  const showNotice = Boolean(notice) && noticeVisible && !compacting
  const text = compacting
    ? t('contextBannerCompacting')
    : showNotice
      ? t('contextNoticeAuto', { count: notice?.rounds ?? 0 })
      : levelText

  return (
    <div className={clsx(styles.banner, styles[level], showNotice && styles.notice)} role="status">
      <span className={styles.text}>{text}</span>
      <span className={styles.actions}>
        <button type="button" className={styles.link} onClick={openMemoryPanel}>
          {t('contextBannerView')}
        </button>
        {compacting ? null : (
          <button
            type="button"
            className={clsx(
              styles.action,
              (level === 'high' || level === 'critical') && styles.actionStrong
            )}
            disabled={streaming}
            onClick={() => void compactSessionMemory(session.id, 'manual')}
          >
            {t('contextBannerCompact')}
          </button>
        )}
      </span>
    </div>
  )
}
