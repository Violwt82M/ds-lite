import clsx from 'clsx'
import { useMemo, useRef } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import {
  formatCharCount,
  getContextLevel,
  getContextUsage,
  type ContextUsage,
} from '../../services/memory/context.js'
import { openMemoryPanel } from '../../services/memory/state.js'
import styles from './ContextMeter.module.css'

/**
 * 顶栏的上下文占用指示：一条进度 + 百分比，点开记忆面板看明细。
 * 颜色就是水位：蓝 → 橙（该整理了）→ 红（会自动整理）→ 黄黑（再长发不出去）。
 */
export const ContextMeter = ({ session, className }: { session: Session; className?: string }) => {
  const t = useTranslate()
  const streaming = useChatStore((state) => Boolean(state.streaming[session.id]))
  const cachedRef = useRef<{ sessionId: string; usage: ContextUsage } | null>(null)
  const usage = useMemo(() => {
    // 流式输出期间冻结水位计算，避免每吐几个字就重扫几千条历史消息的 token
    if (streaming && cachedRef.current?.sessionId === session.id) {
      return cachedRef.current.usage
    }
    const next = getContextUsage(session)
    cachedRef.current = { sessionId: session.id, usage: next }
    return next
  }, [session, streaming])
  const percent = Math.min(100, Math.round(usage.ratio * 100))
  const level = getContextLevel(usage.ratio)
  const label = t('memoryContextUsage', {
    used: formatCharCount(usage.usedTokens),
    limit: formatCharCount(usage.limitTokens),
    percent,
  })
  return (
    <button
      type="button"
      className={clsx(styles.meter, styles[level], className)}
      aria-label={label}
      title={label}
      onClick={openMemoryPanel}
    >
      <span className={styles.bar} aria-hidden="true">
        <span className={styles.fill} style={{ width: `${Math.max(3, percent)}%` }} />
      </span>
      <span className={styles.text}>{percent}%</span>
    </button>
  )
}
