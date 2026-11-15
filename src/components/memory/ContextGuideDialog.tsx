import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { closeContextGuide, useContextGuide } from '../../services/memory/guide.js'
import styles from './ContextGuideDialog.module.css'

/**
 * 第一次填完 API Key 后弹出一次的上下文引导。
 * 只讲三件事，配一条明确的行动建议（随时能整理、越早越省），不做技术解释。
 */
export const ContextGuideDialog = () => {
  const t = useTranslate()
  const open = useContextGuide((state) => state.open)
  if (!open) {
    return null
  }
  return (
    <Modal
      title={t('contextGuideTitle')}
      className={styles.dialog}
      onClose={closeContextGuide}
      footer={
        <div className={styles.actions}>
          <Button variant="primary" size="m" onClick={closeContextGuide}>
            {t('contextGuideAccept')}
          </Button>
        </div>
      }
    >
      <ul className={styles.list}>
        <li>{t('contextGuidePoint1')}</li>
        <li>{t('contextGuidePoint2')}</li>
        <li>{t('contextGuidePoint3')}</li>
      </ul>
      <div className={styles.price}>{t('contextGuidePrice')}</div>
      <div className={styles.tip}>{t('contextGuideTip')}</div>
      <div className={styles.meta}>{t('contextGuideMeta')}</div>
    </Modal>
  )
}
