import clsx from 'clsx'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MessageList } from '../messages/MessageList.js'
import { ContextBanner } from '../memory/ContextBanner.js'
import { BalanceChip } from '../balance/BalanceChip.js'
import { ContextMeter } from '../memory/ContextMeter.js'
import { MemoryDrawer } from '../memory/MemoryDrawer.js'
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
  const title = session.title || t('untitledChat')
  return (
    <div className={styles.view}>
      {isMobile ? (
        <MobileHeader title={title} session={session} />
      ) : (
        <div className={styles.header}>
          <div className={clsx(styles.title, siderCollapsed && styles.withCollapsedSider)}>
            {title}
          </div>
          <div className={styles.headerActions}>
            <BalanceChip />
            <PersonaButton sessionId={session.id} />
            <ContextMeter session={session} />
          </div>
        </div>
      )}
      <ContextBanner session={session} />
      <MessageList
        session={session}
        streaming={streaming}
        footer={
          <div className={styles.inputContainer}>
            <ChatInput sessionId={session.id} />
            <div className={styles.caveat}>{t('contentCaveat')}</div>
          </div>
        }
      />
      <MemoryDrawer session={session} />
    </div>
  )
}
