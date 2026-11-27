import { useMemo, useRef } from 'react'
import clsx from 'clsx'
import {
  IconChevronDownOutline14,
  IconEditOutline16,
  IconMenuOutline20,
  IconNewChatOutline20,
} from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { newChat, useChatStore } from '../../services/chat/store.js'
import { getContextLevel, getContextUsage, type ContextLevel } from '../../services/memory/context.js'
import { setHeaderStatusCollapsed, useSettings } from '../../services/settings.js'
import { IconButton } from '../base/IconButton.js'
import { BalanceChip } from '../balance/BalanceChip.js'
import { ContextMeter } from '../memory/ContextMeter.js'
import { openRecordsPanel } from '../records/recordsPanelState.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { PersonaButton } from './PersonaPicker.js'
import styles from './MobileHeader.module.css'

/**
 * 移动端顶栏：
 * - 主行保留左侧菜单、宽敞会话标题、状态栏折叠开关与开启新对话；
 * - 会话页默认展开次级状态条（人设、余额、上下文占用、记录），
 *   用户可点击折叠按钮一键收起，获得更简洁的阅读区（且完全尊重设置里的余额开关）。
 */
export const MobileHeader = ({ title, session }: { title?: string; session?: Session }) => {
  const t = useTranslate()
  const collapsed = useSettings((state) => state.headerStatusCollapsed)
  const streaming = useChatStore((state) => (session ? Boolean(state.streaming[session.id]) : false))
  const cachedLevelRef = useRef<{ sessionId: string; level: ContextLevel } | null>(null)
  const level = useMemo<ContextLevel>(() => {
    if (!session) {
      return 'low'
    }
    if (streaming && cachedLevelRef.current?.sessionId === session.id) {
      return cachedLevelRef.current.level
    }
    const next = getContextLevel(getContextUsage(session).ratio)
    cachedLevelRef.current = { sessionId: session.id, level: next }
    return next
  }, [session, streaming])
  const hasHighContext = level === 'high' || level === 'critical'

  return (
    <div className={clsx(styles.wrap, 'ds-top-bar')}>
      <div className={styles.header}>
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconMenuOutline20 />}
          aria-label={t('expandSiderbarButton')}
          onClick={openMobileSider}
        />
        {title === undefined ? (
          <>
            {/* 还没发第一句话：只放人设入口，让新对话可以先选人设 */}
            <div className={styles.title} />
            <PersonaButton sessionId={null} />
          </>
        ) : (
          <>
            <div className={styles.title}>{title}</div>
            {session ? (
              <button
                type="button"
                className={clsx(styles.toggle, !collapsed && styles.toggleExpanded)}
                aria-label={t(collapsed ? 'headerExpandStatus' : 'headerCollapseStatus')}
                aria-expanded={!collapsed}
                onClick={() => setHeaderStatusCollapsed(!collapsed)}
              >
                <span className={styles.toggleIcon}>
                  <IconChevronDownOutline14 />
                </span>
                {collapsed && hasHighContext ? (
                  <span
                    className={clsx(
                      styles.alertDot,
                      level === 'critical' && styles.alertDotCritical
                    )}
                    aria-hidden
                  />
                ) : null}
              </button>
            ) : null}
            <IconButton
              className={styles.action}
              size="xl"
              tone="primary"
              icon={<IconNewChatOutline20 />}
              aria-label={t('newChat')}
              onClick={newChat}
            />
          </>
        )}
      </div>
      {title !== undefined && session && !collapsed ? (
        <div className={styles.statusBar}>
          <div className={styles.statusLeft}>
            <PersonaButton sessionId={session.id} />
          </div>
          <div className={styles.statusRight}>
            <BalanceChip className={styles.meter} />
            <ContextMeter session={session} className={styles.meter} />
            <IconButton
              className={styles.action}
              size="xs"
              tooltip={t('recordsTitle')}
              icon={<IconEditOutline16 />}
              onClick={openRecordsPanel}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
