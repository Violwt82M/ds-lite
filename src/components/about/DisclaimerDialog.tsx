import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { acceptDisclaimer, useDisclaimer } from './disclaimerState.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { OFFICIAL_REPO } from './AboutPanel.js'
import { APP_VERSION, UPSTREAM_VERSION } from '../../version.js'
import styles from './DisclaimerDialog.module.css'

/**
 * 首次启动必须确认的安全说明；之后从设置 → 关于重新打开。
 * 只提供「我已了解」一个出口，避免用户没看就点掉。
 */
export const DisclaimerDialog = () => {
  const t = useTranslate()
  const open = useDisclaimer((state) => state.open)
  const accepted = useDisclaimer((state) => state.accepted)

  if (!open && accepted) {
    return null
  }

  return (
    <Modal
      title={t('disclaimerTitle')}
      className={styles.dialog}
      mainClassName={styles.body}
      scrollable
      onClose={() => {
        if (accepted) {
          useDisclaimer.setState({ open: false })
        }
      }}
      footer={
        <div className={styles.actions}>
          <Button
            variant="primary"
            size="m"
            onClick={() => {
              acceptDisclaimer()
              // 确认声明后立刻接上填 Key 的引导
              ensureApiKey()
            }}
          >
            {t('disclaimerAccept')}
          </Button>
        </div>
      }
    >
      <p className={styles.lead}>{t('disclaimerIntro')}</p>
      <ul className={styles.list}>
        <li>{t('disclaimerPoint1')}</li>
        <li>{t('disclaimerPoint2')}</li>
        <li>{t('disclaimerPoint3')}</li>
        <li>{t('disclaimerPoint4')}</li>
        <li>{t('disclaimerPoint5')}</li>
      </ul>
      <p className={styles.meta}>
        DS Lite {APP_VERSION} · upstream chat-demo {UPSTREAM_VERSION} · MIT
      </p>
      <p className={styles.meta}>
        <a className={styles.link} href={OFFICIAL_REPO} target="_blank" rel="noreferrer">
          {OFFICIAL_REPO}
        </a>
      </p>
    </Modal>
  )
}
