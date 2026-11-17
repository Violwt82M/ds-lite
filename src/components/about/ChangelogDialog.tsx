import { useEffect } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { APP_CHANNEL, APP_VERSION } from '../../version.js'
import { useSettings } from '../../services/settings.js'
import { useDisclaimer } from './disclaimerState.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Changelog } from './Changelog.js'
import { openChangelogDialog, markChangelogSeen, useChangelogSeen } from './changelogSeen.js'
import styles from './ChangelogDialog.module.css'

/**
 * 升级后第一次启动时弹「这一版更新了什么」。
 * 触发条件（三者同时满足）：
 * 1. 免责声明已确认（否则说明是新装，先看声明）；
 * 2. 已经填过 API Key（否则设置弹窗会同时开着，两个弹窗叠在一起）；
 * 3. 当前版本号还没被标记为已读。
 * 弹窗只显示当前这一版，完整历史仍在「设置 → 关于 → 更新日志」。
 */
export const ChangelogDialog = () => {
  const t = useTranslate()
  const open = useChangelogSeen((state) => state.open)
  const seen = useChangelogSeen((state) => state.seen)
  const accepted = useDisclaimer((state) => state.accepted)
  const hasKey = useSettings((state) => Boolean(state.apiKey))

  useEffect(() => {
    if (!accepted || !hasKey || seen === APP_VERSION) {
      return
    }
    // 晚一点再弹：等首屏和会话列表渲染完，别和加载动画抢注意力
    const timer = window.setTimeout(openChangelogDialog, 1200)
    return () => window.clearTimeout(timer)
  }, [accepted, hasKey, seen])

  if (!open) {
    return null
  }
  return (
    <Modal
      title={t('changelogDialogTitle', {
        version: APP_CHANNEL === 'beta' ? `${APP_VERSION}（${t('aboutBetaBadge')}）` : APP_VERSION,
      })}
      closable
      onClose={markChangelogSeen}
      footer={
        <Button variant="primary" size="m" onClick={markChangelogSeen}>
          {t('changelogDialogOk')}
        </Button>
      }
    >
      <div className={styles.body}>
        <Changelog current={APP_VERSION} only={APP_VERSION} withHead={false} />
      </div>
    </Modal>
  )
}
