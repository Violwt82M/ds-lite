import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { openDisclaimer } from './disclaimerState.js'
import settingsStyles from '../settings/Settings.module.css'

/** 上游开源项目与版本信息：二次开发必须保留出处 */
export const OFFICIAL_REPO = 'https://github.com/deepseek-ai/chat-demo'
export const OFFICIAL_LICENSE = 'https://github.com/deepseek-ai/chat-demo/blob/main/LICENSE'
export const APP_VERSION = '0.9.15'
export const UPSTREAM_VERSION = '0.1.1'

/** 设置里的「关于」分组：非官方声明、开源许可、上游仓库 */
export const AboutPanel = () => {
  const t = useTranslate()

  return (
    <>
      <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
        <div className={settingsStyles.text}>
          <div className={settingsStyles.label}>{t('aboutVersion')}</div>
          <div className={settingsStyles.description}>
            DS Lite {APP_VERSION} · upstream chat-demo {UPSTREAM_VERSION}
          </div>
        </div>
      </div>
      <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
        <div className={settingsStyles.text}>
          <div className={settingsStyles.label}>{t('aboutUnofficial')}</div>
          <div className={settingsStyles.description}>{t('aboutUnofficialDescription')}</div>
        </div>
      </div>
      <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
        <div className={settingsStyles.text}>
          <div className={settingsStyles.label}>{t('aboutSafetyTitle')}</div>
          <div className={settingsStyles.description}>{t('aboutSafetyDescription')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={settingsStyles.cellButton}
          onClick={openDisclaimer}
        >
          {t('aboutView')}
        </Button>
      </div>
      <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
        <div className={settingsStyles.text}>
          <div className={settingsStyles.label}>{t('aboutRepo')}</div>
          <div className={settingsStyles.description}>{t('aboutRepoDescription')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={settingsStyles.cellButton}
          onClick={() => window.open(OFFICIAL_REPO, '_blank', 'noopener')}
        >
          GitHub
        </Button>
      </div>
      <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
        <div className={settingsStyles.text}>
          <div className={settingsStyles.label}>{t('aboutLicense')}</div>
          <div className={settingsStyles.description}>{t('aboutLicenseDescription')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={settingsStyles.cellButton}
          onClick={() => window.open(OFFICIAL_LICENSE, '_blank', 'noopener')}
        >
          MIT
        </Button>
      </div>
    </>
  )
}
