import clsx from 'clsx'
import { IconMenuOutline20, IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { IconEditOutline16 } from '../base/icons.js'
import { BalanceChip } from '../balance/BalanceChip.js'
import { ContextMeter } from '../memory/ContextMeter.js'
import { openRecordsPanel } from '../records/recordsPanelState.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { PersonaButton } from './PersonaPicker.js'
import styles from './MobileHeader.module.css'

/** 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题、人设、上下文占用与开启新对话 */
export const MobileHeader = ({ title, session }: { title?: string; session?: Session }) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.header, 'ds-top-bar')}>
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
          {session ? <PersonaButton sessionId={session.id} /> : null}
          <BalanceChip className={styles.meter} />
          {session ? <ContextMeter session={session} className={styles.meter} /> : null}
          {session ? (
            <IconButton
              className={styles.action}
              size="xs"
              tooltip={t('recordsTitle')}
              icon={<IconEditOutline16 />}
              onClick={openRecordsPanel}
            />
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
  )
}
