import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './EasterEggDialog.module.css'

/**
 * 关于页的小彩蛋：连点版本号 5 次打开。
 * 图放在 public/easter-egg.jpg（构建时原样复制到站点根，也进 APK），
 * 和赞助码一样不 import，方便直接换图；图缺失时整张不显示，不留裂图。
 */
export const EasterEggDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const t = useTranslate()
  const [missing, setMissing] = useState(false)

  if (!open) {
    return null
  }
  return (
    <Modal
      title={t('aboutEasterEgg')}
      closable
      onClose={onClose}
      footer={
        <Button variant="primary" size="m" onClick={onClose}>
          {t('aboutEasterEggClose')}
        </Button>
      }
    >
      <div className={styles.body}>
        {missing ? null : (
          <img
            className={styles.image}
            src="easter-egg.jpg"
            alt={t('aboutEasterEgg')}
            onError={() => setMissing(true)}
          />
        )}
        <p className={styles.caption}>{t('aboutEasterEggCaption')}</p>
      </div>
    </Modal>
  )
}
