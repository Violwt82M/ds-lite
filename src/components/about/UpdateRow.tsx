import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { APP_VERSION } from '../../version.js'
import { checkForUpdate, isNativePlatform, useUpdate } from '../../services/updateCheck.js'
import { applyWebUpdate, useWebUpdate } from '../../services/webUpdate.js'
import { Button } from '../base/Button.js'
import settingsStyles from '../settings/Settings.module.css'

/**
 * 关于页的「检查更新」（0.9.34）。
 * APK：查 GitHub Releases 最新 tag，比对 versionName；只提示不自动下载（WebView 装不了）。
 * 网页版：靠 Service Worker 的 waiting 状态，有新版时这里是「立即刷新」。
 */
export const UpdateRow = () => {
  const t = useTranslate()
  const native = isNativePlatform()
  const update = useUpdate()
  const webAvailable = useWebUpdate((state) => state.available)

  const description = (() => {
    if (!native) {
      return webAvailable ? t('updateAvailableApply') : t('updateWebHint')
    }
    switch (update.status) {
      case 'checking':
        return t('updateChecking')
      case 'available':
        return t('updateAvailable', { version: update.latest ?? '' })
      case 'latest':
        return t('updateLatest', { version: APP_VERSION })
      case 'failed':
        return t('updateFailed')
      default:
        return t('updateNativeHint', { version: APP_VERSION })
    }
  })()

  return (
    <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
      <div className={settingsStyles.text}>
        <div className={settingsStyles.label}>{t('updateTitle')}</div>
        <div className={settingsStyles.description}>{description}</div>
      </div>
      {native && update.status === 'available' && update.url ? (
        <Button
          variant="primary"
          size="m"
          className={settingsStyles.cellButton}
          onClick={() => window.open(update.url ?? '', '_blank', 'noopener')}
        >
          {t('updateDownload')}
        </Button>
      ) : native ? (
        <Button
          variant="outlined"
          size="m"
          className={settingsStyles.cellButton}
          disabled={update.status === 'checking'}
          onClick={() => void checkForUpdate(true)}
        >
          {t('updateCheckNow')}
        </Button>
      ) : webAvailable ? (
        <Button
          variant="primary"
          size="m"
          className={settingsStyles.cellButton}
          onClick={applyWebUpdate}
        >
          {t('webUpdateApply')}
        </Button>
      ) : null}
    </div>
  )
}
