import { useTranslate } from '../../i18n/index.js'
import styles from './ApiKeyGuide.module.css'

const PLATFORM_URL = 'https://platform.deepseek.com'
const KEYS_URL = 'https://platform.deepseek.com/api_keys'
const TOP_UP_URL = 'https://platform.deepseek.com/top_up'
const USAGE_URL = 'https://platform.deepseek.com/usage'
const PRICING_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'

/**
 * 新手引导：大部分轻量用户卡在"去哪拿 key"这一步。
 * 常驻在「数据管理」里，不折叠、不按状态隐藏——用户随时回来都能看到。
 */
export const ApiKeyGuide = () => {
  const t = useTranslate()

  return (
    <div className={styles.guide}>
      <div className={styles.title}>{t('apiKeyGuideTitle')}</div>
      <a className={styles.link} href={PLATFORM_URL} target="_blank" rel="noreferrer">
        {t('apiKeyGuidePlatform')} ↗
      </a>
      <ol className={styles.steps}>
        <li>
          {t('apiKeyGuideStep1')}{' '}
          <a className={styles.link} href={PLATFORM_URL} target="_blank" rel="noreferrer">
            platform.deepseek.com
          </a>
        </li>
        <li>
          {t('apiKeyGuideStep2')}{' '}
          <a className={styles.link} href={TOP_UP_URL} target="_blank" rel="noreferrer">
            {t('topUp')}
          </a>
        </li>
        <li>
          {t('apiKeyGuideStep3')}{' '}
          <a className={styles.link} href={KEYS_URL} target="_blank" rel="noreferrer">
            {t('apiKeyGuideKeysPage')}
          </a>
        </li>
        <li>{t('apiKeyGuideStep4')}</li>
      </ol>
      <p className={styles.balance}>
        {t('apiKeyGuideBalance')}{' '}
        <a className={styles.link} href={USAGE_URL} target="_blank" rel="noreferrer">
          {t('apiKeyGuideBalanceLink')}
        </a>
      </p>
      <p className={styles.price}>
        {t('apiKeyGuidePrice')}{' '}
        <a className={styles.link} href={PRICING_URL} target="_blank" rel="noreferrer">
          {t('apiKeyGuidePriceLink')}
        </a>
      </p>
      <p className={styles.tip}>{t('apiKeyGuideTip')}</p>
    </div>
  )
}
