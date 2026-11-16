import clsx from 'clsx'
import { useEffect } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { refreshBalance, refreshBalanceIfStale, useBalance } from '../../services/balance.js'
import { useSettings } from '../../services/settings.js'
import styles from './BalanceChip.module.css'

/** 金额统一两位小数；服务端给的是字符串，解析不了就原样显示 */
const formatAmount = (value: string) => {
  const number = Number(value)
  return Number.isFinite(number) ? number.toFixed(2) : value
}

/**
 * 顶栏余额：点一下刷新。
 * 官方 /user/balance 返回真实余额，所以这里显示的不是估算值；
 * 设置里可以整个关掉（showBalance）。
 */
export const BalanceChip = ({ className }: { className?: string }) => {
  const t = useTranslate()
  const showBalance = useSettings((state) => state.showBalance)
  const hasApiKey = useSettings((state) => Boolean(state.apiKey))
  const { infos, loading, error, available } = useBalance()

  useEffect(() => {
    if (showBalance && hasApiKey) {
      void refreshBalanceIfStale()
    }
  }, [showBalance, hasApiKey])

  if (!showBalance || !hasApiKey) {
    return null
  }

  const info = infos[0]
  const amount = info ? formatAmount(info.total) : loading ? '…' : '—'
  const title =
    error !== null
      ? t('balanceFailed', { message: error })
      : info
        ? t('balanceTotal', { amount: info.total, currency: info.currency })
        : t('balanceLabel')

  return (
    <button
      type="button"
      className={clsx(styles.chip, !available && styles.warning, error !== null && styles.error, className)}
      aria-label={title}
      title={title}
      onClick={() => void refreshBalance()}
    >
      <span className={styles.symbol}>¥</span>
      <span className={styles.amount}>{amount}</span>
    </button>
  )
}
