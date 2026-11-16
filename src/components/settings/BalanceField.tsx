import clsx from 'clsx'
import { useEffect } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { refreshBalance, refreshBalanceIfStale, useBalance } from '../../services/balance.js'
import { setShowBalance, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import styles from './Settings.module.css'

/**
 * 账户余额：直接查官方接口拿真实数字，比按 token 估算靠谱。
 * 第三方兼容服务通常没实现 /user/balance，查不到就只说查不到，不影响聊天。
 */
export const BalanceField = () => {
  const t = useTranslate()
  const hasApiKey = useSettings((state) => Boolean(state.apiKey))
  const { infos, updatedAt, loading, error, available } = useBalance()

  useEffect(() => {
    if (hasApiKey) {
      void refreshBalanceIfStale()
    }
  }, [hasApiKey])

  const info = infos[0]
  const detail = (() => {
    if (!hasApiKey) {
      return t('balanceNeedKey')
    }
    if (error !== null) {
      return t('balanceFailed', { message: error })
    }
    if (!info) {
      return loading ? t('balanceLoading') : t('balanceNone')
    }
    const parts = [t('balanceTopUpPart', { amount: info.toppedUp })]
    if (Number(info.granted) > 0) {
      parts.unshift(t('balanceGrantPart', { amount: info.granted }))
    }
    const suffix = available ? '' : t('balanceNotAvailable')
    return `${t('balanceTotal', { amount: info.total, currency: info.currency })} · ${parts.join(' · ')}${suffix}`
  })()

  return (
    <div className={clsx(styles.cell, styles.row)}>
      <div className={styles.text}>
        <div className={styles.label}>{t('balanceLabel')}</div>
        <div className={styles.description}>{detail}</div>
      </div>
      <div className={styles.action}>
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={!hasApiKey || loading}
          onClick={() => void refreshBalance()}
        >
          {loading && updatedAt === 0 ? t('balanceLoading') : t('balanceRefresh')}
        </Button>
      </div>
    </div>
  )
}

/** 顶栏余额的开关：默认显示，嫌占地方可以关掉（设置里仍有余额） */
export const ShowBalanceField = () => {
  const t = useTranslate()
  const showBalance = useSettings((state) => state.showBalance)
  return (
    <div className={clsx(styles.cell, styles.row)}>
      <div className={styles.text}>
        <div className={styles.label}>{t('balanceShowToggle')}</div>
        <div className={styles.description}>{t('balanceShowHint')}</div>
      </div>
      <div className={styles.action}>
        <Button
          variant={showBalance ? 'primary' : 'outlined'}
          size="m"
          className={styles.cellButton}
          onClick={() => setShowBalance(!showBalance)}
        >
          {t(showBalance ? 'balanceShowOn' : 'balanceShowOff')}
        </Button>
      </div>
    </div>
  )
}