import clsx from 'clsx'
import { useState } from 'react'
import {
  isValidApiOrigin,
  OFFICIAL_API_ORIGIN,
  setApiOrigin,
  useApiOrigin,
} from '../../services/api/base.js'
import {
  getCustomModel,
  getApiProtocol,
  setApiProtocol,
  setCustomModel,
  type ApiProtocol,
} from '../../services/api/protocol.js'
import { useSettings } from '../../services/settings.js'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

/** 测试连接的结果：四类结论 + 未知状态码 */
type TestResult = 'ok' | 'badKey' | 'cors' | 'wrongPath' | { status: number }

/** 根据协议把用户填的地址补成「校验 Key 用的 models 接口」 */
const modelsUrl = (raw: string, protocol: ApiProtocol): string => {
  const root = raw.trim().replace(/\/+$/, '')
  if (protocol === 'openai') {
    return `${root.replace(/\/chat\/completions$/i, '').replace(/\/v1$/i, '')}/v1/models`
  }
  return `${root.replace(/\/messages$/i, '').replace(/\/anthropic\/v1$/i, '').replace(/\/anthropic$/i, '')}/models`
}

const ApiOriginDialog = ({ onClose }: { onClose: () => void }) => {
  const t = useTranslate()
  const origin = useApiOrigin((state) => state.origin)
  const apiKey = useSettings((state) => state.apiKey)
  const [value, setValue] = useState(origin === OFFICIAL_API_ORIGIN ? '' : origin)
  const [protocol, setProtocol] = useState<ApiProtocol>(getApiProtocol())
  const [model, setModel] = useState(getCustomModel())
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  const invalid = value.trim() !== '' && !isValidApiOrigin(value)

  const save = () => {
    const next = value.trim()
    if (next === '') {
      setApiOrigin(null)
      setApiProtocol('anthropic')
      showToast({ key: 'apiOriginResetDone' })
    } else {
      if (!isValidApiOrigin(next)) {
        return
      }
      setApiOrigin(next)
      setApiProtocol(protocol)
      setCustomModel(model)
      showToast({ key: 'apiOriginSaved' })
    }
    onClose()
  }

  const test = async () => {
    if (invalid || testing) {
      return
    }
    setTesting(true)
    setResult(null)
    try {
      const response = await fetch(modelsUrl(value || OFFICIAL_API_ORIGIN, protocol), {
        headers: { Authorization: `Bearer ${apiKey ?? ''}` },
      })
      if (response.ok) {
        setResult('ok')
      } else if (response.status === 401 || response.status === 403) {
        setResult('badKey')
      } else if (response.status === 404 || response.status === 405) {
        setResult('wrongPath')
      } else {
        setResult({ status: response.status })
      }
    } catch {
      // fetch 抛错只可能是网络/跨域（浏览器不给更多信息），两种原因一起说
      setResult('cors')
    } finally {
      setTesting(false)
    }
  }

  const resultText = (value: TestResult): string => {
    if (typeof value === 'object') {
      return t('apiTestUnknown', { status: value.status })
    }
    switch (value) {
      case 'ok':
        return t('apiTestOk')
      case 'badKey':
        return t('apiTestBadKey')
      case 'cors':
        return t('apiTestCors')
      default:
        return t('apiTestWrongPath')
    }
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
              setApiProtocol('anthropic')
              showToast({ key: 'apiOriginResetDone' })
              onClose()
            }}
          >
            {t('apiOriginReset')}
          </Button>
          <Button size="m" variant="outlined" disabled={testing} onClick={() => void test()}>
            {testing ? t('apiTestTesting') : t('apiTestButton')}
          </Button>
          <Button size="m" variant="primary" disabled={invalid} onClick={save}>
            {t('confirm')}
          </Button>
        </div>
      }
    >
      <div className={styles.apiOriginBody}>
        <div className={styles.apiOriginLabelRow}>{t('apiProtocolLabel')}</div>
        <div className={styles.apiProtocolRow}>
          <Button
            size="m"
            variant={protocol === 'anthropic' ? 'primary' : 'outlined'}
            onClick={() => {
              setProtocol('anthropic')
              setResult(null)
            }}
          >
            {t('apiProtocolAnthropic')}
          </Button>
          <Button
            size="m"
            variant={protocol === 'openai' ? 'primary' : 'outlined'}
            onClick={() => {
              setProtocol('openai')
              setResult(null)
            }}
          >
            {t('apiProtocolOpenai')}
          </Button>
        </div>
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
        {protocol === 'openai' ? (
          <>
            <div className={styles.apiOriginLabelRow}>{t('apiCustomModelLabel')}</div>
            <input
              className={styles.apiOriginInput}
              type="text"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="gpt-4o-mini"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <div className={styles.apiOriginHint}>{t('apiCustomModelHint')}</div>
            <div className={styles.apiOriginWarn}>
              {t('apiProtocolOpenaiNote', { url: value.trim() || 'https://…' })}
            </div>
          </>
        ) : (
          <div className={styles.apiOriginHint}>{t('apiOriginHint')}</div>
        )}
        {invalid ? <div className={styles.error}>{t('apiOriginInvalid')}</div> : null}
        {result ? (
          <div
            className={clsx(
              result === 'ok' ? styles.apiOriginHint : styles.error
            )}
          >
            {resultText(result)}
          </div>
        ) : null}
        <div className={styles.apiOriginWarn}>{t('apiOriginWarning')}</div>
      </div>
    </Modal>
  )
}

/** API 地址：默认官方，点「自定义 API」填第三方兼容服务（支持 Anthropic / OpenAI 两种协议） */
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
