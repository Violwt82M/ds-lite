import { IconPanelLeftOutline16 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { IconButton } from '../base/IconButton.js'
import styles from './Sider.module.css'

/** 宽屏收起侧边栏后左上角的展开按钮（新对话按钮统一放在右上角，避免和侧栏图标挤在一起） */
export const CollapsedSider = () => {
  const t = useTranslate()
  return (
    <div className={styles.collapsed}>
      <div className={styles.collapsedGroup}>
        <IconButton
          size="m"
          tone="primary"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('expandSiderbarButton')}
          onClick={() => setSiderCollapsed(false)}
        />
      </div>
    </div>
  )
}
