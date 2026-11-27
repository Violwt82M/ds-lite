import { useEffect, useMemo, useRef } from 'react'
import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { getContextLevel, getContextUsage, type ContextLevel } from '../../services/memory/context.js'
import { setHeaderStatusCollapsed, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconChevronDownOutline14, IconNewChatOutline20 } from '../base/icons.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import {
  clearAllMessageEditing,
  useHasEditingMessage,
} from '../messages/editingState.js'
import { MessageList } from '../messages/MessageList.js'
import { ContextBanner } from '../memory/ContextBanner.js'
import { BalanceChip } from '../balance/BalanceChip.js'
import { ContextMeter } from '../memory/ContextMeter.js'
import { MemoryDrawer } from '../memory/MemoryDrawer.js'
import { RecordsPanel } from '../records/RecordsPanel.js'
import { openRecordsPanel, useRecordsPanel } from '../records/recordsPanelState.js'
import { MobileHeader } from './MobileHeader.js'
import { PersonaButton } from './PersonaPicker.js'
import styles from './SessionView.module.css'

/** 会话页：标题栏（移动端为顶栏）+ 消息列表，输入框吸底 */
export const SessionView = ({
  session,
  streaming,
  siderCollapsed,
}: {
  session: Session
  streaming: boolean
  siderCollapsed: boolean
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const recordsOpen = useRecordsPanel((state) => state.open)
  const editingMessage = useHasEditingMessage()
  const statusCollapsed = useSettings((state) => state.headerStatusCollapsed)
  const cachedLevelRef = useRef<{ sessionId: string; level: ContextLevel } | null>(null)
  const level = useMemo<ContextLevel>(() => {
    if (streaming && cachedLevelRef.current?.sessionId === session.id) {
      return cachedLevelRef.current.level
    }
    const next = getContextLevel(getContextUsage(session).ratio)
    cachedLevelRef.current = { sessionId: session.id, level: next }
    return next
  }, [session, streaming])
  const hasHighContext = level === 'high' || level === 'critical'
  const title = session.title || t('untitledChat')

  useEffect(() => {
    clearAllMessageEditing()
  }, [session.id])

  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} session={session} />
      ) : (
        <div className={clsx(styles.header, 'ds-top-bar')}>
          <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
            {title}
          </div>
          <div className={styles.headerActions}>
            {!statusCollapsed ? (
              <>
                <BalanceChip />
                <Button size="s" variant="outlined" onClick={openRecordsPanel}>
                  {t('recordsTitle')}
                </Button>
                <PersonaButton sessionId={session.id} />
                <ContextMeter session={session} />
              </>
            ) : null}
            <button
              type="button"
              className={clsx(styles.statusToggle, !statusCollapsed && styles.statusToggleExpanded)}
              aria-label={t(statusCollapsed ? 'headerExpandStatus' : 'headerCollapseStatus')}
              aria-expanded={!statusCollapsed}
              title={t(statusCollapsed ? 'headerExpandStatus' : 'headerCollapseStatus')}
              onClick={() => setHeaderStatusCollapsed(!statusCollapsed)}
            >
              <span className={styles.statusToggleIcon}>
                <IconChevronDownOutline14 />
              </span>
              {statusCollapsed && hasHighContext ? (
                <span
                  className={clsx(
                    styles.alertDot,
                    level === 'critical' && styles.alertDotCritical
                  )}
                  aria-hidden
                />
              ) : null}
            </button>
            <IconButton
              size="xl"
              tone="primary"
              icon={<IconNewChatOutline20 />}
              tooltip={t('newChat')}
              aria-label={t('newChat')}
              onClick={newChat}
            />
          </div>
        </div>
      )}
      <ContextBanner session={session} />
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          editingMessage ? null : (
            <div className={styles.inputContainer}>
              <ChatInput sessionId={session.id} />
              <div className={styles.caveat}>{t('contentCaveat')}</div>
            </div>
          )
        }
      />
      <MemoryDrawer session={session} />
      {recordsOpen ? <RecordsPanel session={session} /> : null}
    </div>
  )
}
