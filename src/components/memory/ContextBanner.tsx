import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { compactSessionMemory, useChatStore } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { useDrafts } from '../../services/chat/drafts.js'
import {
  estimateFileTokens,
  estimateTextTokens,
  formatCharCount,
  getContextLevel,
  getContextUsage,
  getFoldableTokens,
  MANUAL_KEEP_TOKENS,
  MIN_FOLDABLE_TOKENS,
} from '../../services/memory/context.js'
import { openMemoryPanel, useMemoryPanel } from '../../services/memory/state.js'
import { useSettings } from '../../services/settings.js'
import styles from './ContextBanner.module.css'

/**
 * 会话页顶部的上下文条：每一档在「每个对话」里都会出现一次，点 × 只关掉当前这个对话的当前档位，
 * 换一个对话照常提醒；同一对话里占用跨到新档位（蓝 → 橙 → 红）也会重新出现。
 * 想主动整理随时能去「查看」→ 上下文面板，不必被常驻横幅催。
 */
const DISMISS_KEY = 'ds-lite.contextBanner.dismissed'
const MAX_ENTRIES = 80

/** 读出「这个对话上次关掉的是哪一档」 */
const readDismissed = (sessionId: string): string => {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY)
    if (!raw) {
      return ''
    }
    const map = JSON.parse(raw) as Record<string, string>
    const level = map?.[sessionId]
    return typeof level === 'string' ? level : ''
  } catch {
    return ''
  }
}

const writeDismissed = (sessionId: string, level: string) => {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {}
    const map: Record<string, string> = parsed && typeof parsed === 'object' ? parsed : {}
    map[sessionId] = level
    const ids = Object.keys(map)
    if (ids.length > MAX_ENTRIES) {
      // 记太多了：只留当前这个对话，别把 localStorage 撑爆
      window.localStorage.setItem(DISMISS_KEY, JSON.stringify({ [sessionId]: level }))
      return
    }
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify(map))
  } catch {
    // 隐私模式下写不进去就只在本次会话里生效
  }
}

export const ContextBanner = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const usage = useMemo(() => getContextUsage(session), [session])
  // 已经在输入框里、还没发出去的提问和附件也算数：不然显示 0%，
  // 一发出去就发现十几万 token（用户对此完全没预期）
  const draft = useDrafts((state) => state.drafts.get(session.id))
  const pendingTokens = draft
    ? estimateTextTokens(draft.text) +
      draft.attachments.reduce(
        (sum, item) =>
          sum + estimateFileTokens({ isImage: item.isImage, size: item.file.size, tokens: item.tokens }),
        0
      )
    : 0
  const usedTokens = usage.usedTokens + pendingTokens
  const ratio = usedTokens / usage.limitTokens
  const level = getContextLevel(ratio)
  const compacting = useMemoryPanel((state) => Boolean(state.compacting[session.id]))
  const notice = useMemoryPanel((state) => state.notices[session.id])
  const streaming = useChatStore((state) => Boolean(state.streaming[session.id]))
  const autoMemory = useSettings((state) => state.autoMemory)
  // 这个对话里已经关掉过哪一档（存本地，切回来还记得；换个对话会重新提醒）
  const [dismissedLevel, setDismissedLevel] = useState<string>(() => readDismissed(session.id))
  useEffect(() => {
    setDismissedLevel(readDismissed(session.id))
    setNoticeClosed(false)
  }, [session.id])
  // 自动整理完成后显示 8 秒，告诉用户刚刚发生了什么
  const [noticeVisible, setNoticeVisible] = useState(false)
  const [noticeClosed, setNoticeClosed] = useState(false)
  useEffect(() => {
    if (!notice) {
      return
    }
    setNoticeVisible(true)
    setNoticeClosed(false)
    const timer = window.setTimeout(() => setNoticeVisible(false), 8000)
    return () => window.clearTimeout(timer)
  }, [notice?.at, notice])

  const used = formatCharCount(usedTokens)
  const percent = Math.min(100, Math.round(ratio * 100))
  // 只按「有多少是可折叠的」决定要不要劝整理：刚聊两句、或者只是挂了个大附件，
  // 这时候点整理要么没得整理，要么会把它刚要用的文档折掉，劝了也是白劝。
  const foldableTokens = useMemo(
    () => getFoldableTokens(session, MANUAL_KEEP_TOKENS),
    [session]
  )
  const canCompact = foldableTokens >= MIN_FOLDABLE_TOKENS
  const levelText =
    level === 'critical'
      ? t('contextBannerCritical', { used, percent })
      : !canCompact
        ? t('contextBannerIdle', { used, percent })
        : level === 'low'
          ? t('contextBannerLow', { used, percent })
          : level === 'mid'
            ? t('contextBannerMid', { used, percent })
            : t(autoMemory ? 'contextBannerHighAuto' : 'contextBannerHigh', { used, percent })
  const showNotice = Boolean(notice) && noticeVisible && !compacting
  const text = compacting
    ? t('contextBannerCompacting')
    : showNotice
      ? t('contextNoticeAuto', { count: notice?.rounds ?? 0 })
      : levelText

  // 正在整理必须显示；整理完的提示显示 8 秒（也能关）；其余情况只看「这个对话的这一档关没关过」
  const visible = compacting ? true : showNotice ? !noticeClosed : dismissedLevel !== level
  if (!visible) {
    return null
  }

  const dismiss = () => {
    setNoticeClosed(true)
    writeDismissed(session.id, level)
    setDismissedLevel(level)
  }

  return (
    <div className={clsx(styles.banner, styles[level], showNotice && styles.notice)} role="status">
      <span className={styles.text}>{text}</span>
      <span className={styles.actions}>
        <button type="button" className={styles.link} onClick={openMemoryPanel}>
          {t('contextBannerView')}
        </button>
        {compacting || !canCompact ? null : (
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
        <button
          type="button"
          className={styles.close}
          aria-label={t('contextBannerDismiss')}
          title={t('contextBannerDismiss')}
          onClick={dismiss}
        >
          ×
        </button>
      </span>
    </div>
  )
}
