import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { openDisclaimer } from './disclaimerState.js'
import { Tutorials } from './Tutorials.js'
import { Changelog } from './Changelog.js'
import { openSponsor } from './sponsorState.js'
import { UpdateRow } from './UpdateRow.js'
import { APP_VERSION, UPSTREAM_VERSION } from '../../version.js'
import settingsStyles from '../settings/Settings.module.css'

/**
 * 问题反馈入口。用户还没给最终链接，先留空：空值时关于页不显示这一行，
 * 不会出现点了没反应的按钮或「素材待补」。拿到链接后只改这一行。
 */
export const FEEDBACK_URL = ''

/** 上游开源项目与版本信息：二次开发必须保留出处 */
export const OFFICIAL_REPO = 'https://github.com/deepseek-ai/chat-demo'
export const OFFICIAL_LICENSE = 'https://github.com/deepseek-ai/chat-demo/blob/main/LICENSE'
export { APP_VERSION, UPSTREAM_VERSION } from '../../version.js'

/** 设置里的「关于」分组：非官方声明、开源许可、上游仓库 */
export const AboutPanel = () => {
  const t = useTranslate()

  return (
    <>
      <Tutorials />
      <Changelog current={APP_VERSION} />
      <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
        <div className={settingsStyles.text}>
          <div className={settingsStyles.label}>{t('aboutVersion')}</div>
          <div className={settingsStyles.description}>
            DS Lite {APP_VERSION} · upstream chat-demo {UPSTREAM_VERSION}
          </div>
        </div>
      </div>
      <UpdateRow />
      {FEEDBACK_URL ? (
        <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
          <div className={settingsStyles.text}>
            <div className={settingsStyles.label}>{t('aboutFeedback')}</div>
            <div className={settingsStyles.description}>{t('aboutFeedbackDescription')}</div>
          </div>
          <Button
            variant="outlined"
            size="m"
            className={settingsStyles.cellButton}
            onClick={() => window.open(FEEDBACK_URL, '_blank', 'noopener')}
          >
            {t('aboutFeedbackOpen')}
          </Button>
        </div>
      ) : null}
      <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
        <div className={settingsStyles.text}>
          <div className={settingsStyles.label}>{t('aboutSponsor')}</div>
          <div className={settingsStyles.description}>{t('aboutSponsorDescription')}</div>
        </div>
        <Button
          variant="outlined"
          size="m"
          className={settingsStyles.cellButton}
          onClick={openSponsor}
        >
          {t('aboutView')}
        </Button>
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
