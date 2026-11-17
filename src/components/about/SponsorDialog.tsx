import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { useSponsor, closeSponsor } from './sponsorState.js'
import styles from './SponsorDialog.module.css'

/**
 * 赞助二维码。
 * 图放在 public/sponsor-qr.png（构建时原样复制到站点根、也进 APK），
 * 故意不用 import：仓库没有图片 asset 规则，而且这样用户能直接替换文件。
 * 图还没放进来时（onError）显示「素材待补」，不显示裂图。
 */
export const SponsorDialog = () => {
  const t = useTranslate()
  const open = useSponsor((state) => state.open)
  const [missing, setMissing] = useState(false)

  if (!open) {
    return null
  }
  return (
    <Modal
      title={t('sponsorTitle')}
      closable
      onClose={closeSponsor}
      footer={
        <Button variant="primary" size="m" onClick={closeSponsor}>
          {t('sponsorClose')}
        </Button>
      }
    >
      <div className={styles.body}>
        <p className={styles.description}>{t('sponsorDescription')}</p>
        {missing ? (
          <p className={styles.missing}>{t('sponsorAssetMissing')}</p>
        ) : (
          <img
            className={styles.qr}
            src="sponsor-qr.png"
            alt={t('sponsorTitle')}
            onError={() => setMissing(true)}
          />
        )}
        <p className={styles.note}>{t('sponsorNote')}</p>
      </div>
    </Modal>
  )
}
