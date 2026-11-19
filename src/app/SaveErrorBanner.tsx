import { useState } from 'react'
import { useTranslate } from '../i18n/index.js'
import { retrySaveSessions, useChatStore } from '../services/chat/store.js'
import { Button } from '../components/base/Button.js'
import { IconToastError16 } from '../components/base/icons.js'
import styles from './App.module.css'

/**
 * 落盘失败提示条：说明「哪部分没保存、为什么」，并给一个点了有反应的「重试」。
 * 以前失败只标一个 true：文案永远一样，点重试也看不到任何变化（0.9.51 用户反馈「点了没反应」）。
 * 现在正文和附件分开写，空间不足时正文照常落库，条幅会明确说「对话已保存，只差附件」。
 */
export const SaveErrorBanner = () => {
  const t = useTranslate()
  const failures = useChatStore((state) => state.sessionSaveErrors)
  const importingHistory = useChatStore((state) => state.importingHistory)
  const [retrying, setRetrying] = useState(false)
  const list = Object.values(failures)
  if (list.length === 0) {
    return null
  }
  const latest = list.reduce((newest, failure) => (failure.at > newest.at ? failure : newest))
  const quota = list.some((failure) => failure.kind === 'quota')
  const attempts = list.reduce((max, failure) => Math.max(max, failure.attempts), 0)
  const title =
    list.length > 1
      ? t('sessionSaveFailedMulti', { count: list.length })
      : latest.recordSaved
        ? t('sessionSaveFilesFailed', { count: latest.filesPending })
        : quota
          ? t('sessionSaveFailedQuota')
          : t('sessionSaveFailedStorage')
  const action = quota ? t('sessionSaveFailedQuotaHint') : t('sessionSaveFailedStorageHint')
  // 非空间不足的失败把原始错误带出来，用户反馈时能直接抄给开发者；配额类原文（QuotaExceededError）没信息量
  const detail = quota ? '' : latest.message
  const retry = async () => {
    if (retrying) {
      return
    }
    setRetrying(true)
    try {
      await retrySaveSessions()
    } finally {
      setRetrying(false)
    }
  }
  return (
    <div className={styles.saveError} role="alert">
      <span className={styles.saveErrorIcon} aria-hidden="true">
        <IconToastError16 />
      </span>
      <div className={styles.saveErrorText}>
        <span className={styles.saveErrorTitle}>{title}</span>
        <span className={styles.saveErrorHint} title={t('sessionSaveFailedDetails', { message: latest.message })}>
          {action}
          {attempts > 1 ? ` · ${t('sessionSaveFailedAttempts', { count: attempts })}` : null}
          {detail ? <span className={styles.saveErrorDetail}>（{detail}）</span> : null}
        </span>
      </div>
      <Button variant="outlined" size="s" disabled={retrying || importingHistory} onClick={() => void retry()}>
        {retrying ? t('sessionSaving') : t('retry')}
      </Button>
    </div>
  )
}
