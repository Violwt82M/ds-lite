import { useRef, useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import {
  generatePersonaCard,
  type PersonaBrief,
  type GenerateOutcome,
} from '../../services/persona/generate.js'
import type { PersonaCard } from '../../services/persona/card.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './PersonaGenerateDialog.module.css'

/**
 * AI 写角色卡弹窗（0.9.36）。
 * 用户只填信息，模型分两段干活（先联网核实资料、再产 JSON 卡）；结果**只当草稿**，
 * 关掉这个弹窗后直接进 PersonaEditor，用户改完点保存才入库。
 */
const FIELDS: {
  key: keyof PersonaBrief
  label: TranslationKey
  hint?: TranslationKey
  multiline?: boolean
}[] = [
  { key: 'name', label: 'personaGenerateName' },
  { key: 'source', label: 'personaGenerateSource', hint: 'personaGenerateSourceHint' },
  { key: 'gender', label: 'personaGenerateGender' },
  { key: 'age', label: 'personaGenerateAge' },
  { key: 'identity', label: 'personaGenerateIdentity' },
  { key: 'personality', label: 'personaGeneratePersonality' },
  { key: 'style', label: 'personaGenerateStyle' },
  { key: 'scenario', label: 'personaGenerateScenario' },
  { key: 'relation', label: 'personaGenerateRelation' },
  { key: 'extra', label: 'personaGenerateExtra', multiline: true },
]

export const PersonaGenerateDialog = ({
  onClose,
  onDone,
}: {
  onClose: () => void
  /** 生成成功：把草稿交给编辑器（不入库） */
  onDone: (card: PersonaCard, searched: boolean) => void
}) => {
  const t = useTranslate()
  const [brief, setBrief] = useState<PersonaBrief>({ name: '' })
  const [phase, setPhase] = useState<'idle' | 'research' | 'card'>('idle')
  const [failure, setFailure] = useState<GenerateOutcome | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const running = phase !== 'idle'

  const set = (key: keyof PersonaBrief, value: string) =>
    setBrief((previous) => ({ ...previous, [key]: value }))

  const start = async () => {
    if (brief.name.trim() === '' || running) {
      return
    }
    setFailure(null)
    setPhase('research')
    const controller = new AbortController()
    controllerRef.current = controller
    const outcome = await generatePersonaCard(brief, {
      signal: controller.signal,
      onPhase: setPhase,
    })
    controllerRef.current = null
    setPhase('idle')
    if (outcome.ok) {
      onDone(outcome.card, outcome.searched)
      return
    }
    if (outcome.reason === 'aborted') {
      return
    }
    setFailure(outcome)
  }

  const stop = () => {
    controllerRef.current?.abort()
  }

  const failureText = (outcome: GenerateOutcome | null): string => {
    if (!outcome || outcome.ok) {
      return ''
    }
    switch (outcome.reason) {
      case 'nokey':
        return t('personaGenerateNoKey')
      case 'empty':
        return t('personaGenerateEmpty')
      case 'parse':
        return t('personaGenerateParseFailed')
      default:
        return t('personaGenerateFailed', { detail: outcome.detail ?? '' })
    }
  }

  return (
    <Modal
      title={t('personaGenerateTitle')}
      closable
      onClose={() => {
        // 生成过程中别让 Esc / 点遮罩把弹窗关掉，先点「停止」
        if (!running) {
          onClose()
        }
      }}
      footer={
        <>
          <Button variant="outlined" size="m" onClick={running ? stop : onClose}>
            {running ? t('personaGenerateAbort') : t('personaGenerateCancel')}
          </Button>
          <Button
            variant="primary"
            size="m"
            disabled={running || brief.name.trim() === ''}
            onClick={() => void start()}
          >
            {t('personaGenerateStart')}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <p className={styles.hint}>{t('personaGenerateHint')}</p>
        {FIELDS.map((field) => (
          <label key={field.key} className={styles.field}>
            <span className={styles.label}>{t(field.label)}</span>
            {field.multiline ? (
              <textarea
                className={styles.textarea}
                rows={3}
                value={brief[field.key] ?? ''}
                onChange={(event) => set(field.key, event.currentTarget.value)}
              />
            ) : (
              <input
                className={styles.input}
                value={brief[field.key] ?? ''}
                onChange={(event) => set(field.key, event.currentTarget.value)}
              />
            )}
            {field.hint ? <span className={styles.fieldHint}>{t(field.hint)}</span> : null}
          </label>
        ))}
        {running ? (
          <p className={styles.status}>
            {phase === 'research' ? t('personaGeneratingResearch') : t('personaGeneratingCard')}
          </p>
        ) : null}
        {failure ? (
          <div className={styles.failure}>
            <p className={styles.failureText}>{failureText(failure)}</p>
            {failure.raw ? (
              <details className={styles.raw}>
                <summary>{t('personaGenerateRaw')}</summary>
                <pre className={styles.rawText}>{failure.raw.slice(0, 4000)}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
