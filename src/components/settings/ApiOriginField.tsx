import clsx from 'clsx'
import { useState } from 'react'
import {
  isValidApiOrigin,
  OFFICIAL_API_ORIGIN,
  setApiOrigin,
  useApiOrigin,
} from '../../services/api/base.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

const ApiOriginDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const origin = useApiOrigin((state) => state.origin)
  const [value, setValue] = useState(origin === OFFICIAL_API_ORIGIN ? '' : origin)
  const invalid = value.trim() !== '' && !isValidApiOrigin(value)

  const save = () => {
    const next = value.trim()
    if (next === '') {
      setApiOrigin(null)
      showToast({ key: 'apiOriginResetDone' })
    } else {
      if (!isValidApiOrigin(next)) {
        return
      }
      setApiOrigin(next)
      showToast({ key: 'apiOriginSaved' })
    }
    onClose()
  }

  return (
    <Modal
      title={t('apiOriginDialogTitle')}
      closable
      className={styles.apiOriginDialog}
      onClose={onClose}
      footer={
        <div className={styles.apiOriginFooter}>
          <Button
            size="m"
            variant="outlined"
            onClick={() => {
              setApiOrigin(null)
              showToast({ key: 'apiOriginResetDone' })
              onClose()
            }}
          >
            {t('apiOriginReset')}
          </Button>
          <Button size="m" variant="primary" disabled={invalid} onClick={save}>
            {t('confirm')}
          </Button>
        </div>
      }
    >
      <div className={styles.apiOriginBody}>
        <input
          className={styles.apiOriginInput}
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="https://api.example.com"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing && !invalid) {
              save()
            }
          }}
        />
        <div className={styles.apiOriginHint}>{t('apiOriginHint')}</div>
        {invalid ? <div className={styles.error}>{t('apiOriginInvalid')}</div> : null}
        <div className={styles.apiOriginWarn}>{t('apiOriginWarning')}</div>
      </div>
    </Modal>
  )
}

/** API 地址：默认官方，点「自定义 API」填第三方兼容服务 */
export const ApiOriginField = () => {
  const t = useTranslate()
  const origin = useApiOrigin((state) => state.origin)
  const [open, setOpen] = useState(false)
  const custom = origin !== OFFICIAL_API_ORIGIN

  return (
    <>
      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('apiOriginLabel')}</div>
          <div className={styles.description}>
            {custom ? t('apiOriginCurrent', { url: origin }) : t('apiOriginOfficialNote')}
          </div>
        </div>
        <div className={styles.action}>
          <Button
            variant={custom ? 'outlined' : 'primary'}
            size="m"
            className={styles.cellButton}
            onClick={() => setOpen(true)}
          >
            {t('apiOriginButton')}
          </Button>
        </div>
      </div>
      {open ? <ApiOriginDialog onClose={() => setOpen(false)} /> : null}
    </>
  )
}
