import { useState } from 'react'
import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { APP_VERSION } from '../../version.js'
import { platform } from '../../services/platform.js'
import {
  canDownloadInApp,
  canInstallPackages,
  checkForUpdate,
  downloadApkUpdate,
  openInstallPermission,
  openReleasePage,
  useUpdate,
} from '../../services/updateCheck.js'
import { applyWebUpdate, useWebUpdate } from '../../services/webUpdate.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import settingsStyles from '../settings/Settings.module.css'

/**
 * 关于页的「检查更新」（0.9.34 检测 / 0.9.38 应用内下载）。
 * APK：查 GitHub Releases 最新 tag；有 .apk 资产时走应用内下载（DownloadManager → 系统安装器），
 * 拿不到资产或没有原生桥时退回浏览器下载页。
 * 网页版：靠 Service Worker 的 waiting 状态，有新版时这里是「立即刷新」。
 */
export const UpdateRow = () => {
  const t = useTranslate()
  const native = platform.canInstallApk()
  const update = useUpdate()
  const webAvailable = useWebUpdate((state) => state.available)
  /** 点过「去授权」之后，把提示文案换成「授权完再点下载」 */
  const [permissionAsked, setPermissionAsked] = useState(false)

  const inApp = native && canDownloadInApp()
  const needPermission = native && update.status === 'available' && inApp && !canInstallPackages()

  const description = (() => {
    if (!native) {
      return webAvailable ? t('updateAvailableApply') : t('updateWebHint')
    }
    switch (update.status) {
      case 'checking':
        return t('updateChecking')
      case 'available': {
        const base = t('updateAvailable', { version: update.latest ?? '' })
        if (needPermission) {
          return `${base} · ${permissionAsked ? t('updatePermissionGrantedHint') : t('updateNeedInstallPermission')}`
        }
        return `${base} · ${t('updateSlowHint')}`
      }
      case 'latest':
        return t('updateLatest', { version: APP_VERSION })
      case 'failed':
        return t('updateFailed')
      default:
        return t('updateNativeHint', { version: APP_VERSION })
    }
  })()

  const startDownload = () => {
    if (!inApp) {
      openReleasePage()
      return
    }
    if (!canInstallPackages()) {
      setPermissionAsked(true)
      openInstallPermission()
      return
    }
    if (downloadApkUpdate()) {
      showToast({ key: 'updateDownloading' })
    } else {
      showToast({ key: 'updateDownloadFailed' })
      openReleasePage()
    }
  }

  const action = (() => {
    if (!native) {
      return webAvailable ? (
        <Button variant="primary" size="m" className={settingsStyles.cellButton} onClick={applyWebUpdate}>
          {t('webUpdateApply')}
        </Button>
      ) : null
    }
    if (update.status === 'available') {
      return (
        <Button variant="primary" size="m" className={settingsStyles.cellButton} onClick={startDownload}>
          {needPermission ? t('updateGrantInstall') : inApp ? t('updateDownloadNow') : t('updateDownload')}
        </Button>
      )
    }
    return (
      <Button
        variant="outlined"
        size="m"
        className={settingsStyles.cellButton}
        disabled={update.status === 'checking'}
        onClick={() => void checkForUpdate(true)}
      >
        {t('updateCheckNow')}
      </Button>
    )
  })()

  return (
    <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
      <div className={settingsStyles.text}>
        <div className={settingsStyles.label}>{t('updateTitle')}</div>
        <div className={settingsStyles.description}>{description}</div>
      </div>
      {action}
    </div>
  )
}
