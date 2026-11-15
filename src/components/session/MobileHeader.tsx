import { IconMenuOutline20, IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { newChat } from '../../services/chat/store.js'
import { IconButton } from '../base/IconButton.js'
import { ContextMeter } from '../memory/ContextMeter.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { PersonaButton } from './PersonaPicker.js'
import styles from './MobileHeader.module.css'

/** 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题、人设、上下文占用与开启新对话 */
export const MobileHeader = ({ title, session }: { title?: string; session?: Session }) => {
  const t = useTranslate()
  return (
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
          {session ? <PersonaButton sessionId={session.id} /> : null}
          {session ? <ContextMeter session={session} className={styles.meter} /> : null}
          <IconButton
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
