import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  setDraftPersona,
  setSessionPersona,
  useChatPersona,
} from '../../services/persona/scope.js'
import { usePersona } from '../../services/persona/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { openSettings } from '../settings/settingsDialogState.js'
import styles from './PersonaPicker.module.css'

/** 本对话的人设：不使用 / 选一张卡；只影响这个对话 */
const PersonaPicker = ({
  sessionId,
  onClose,
}: {
  /** null 表示还没发第一句话，选的是下一条新对话 */
  sessionId: string | null
  onClose: () => void
}) => {
  const t = useTranslate()
  const cards = usePersona((state) => state.cards)
  const persona = useChatPersona(sessionId)
  const [draft, setDraft] = useState<string>(() => persona.cardId ?? 'none')

  const confirm = () => {
    if (sessionId === null) {
      setDraftPersona(draft)
    } else {
      setSessionPersona(sessionId, draft)
    }
    onClose()
  }

  return (
    <Modal
      title={t('chatPersonaTitle')}
      className={styles.dialog}
      closable
      onClose={onClose}
      footer={
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.manage}
            onClick={() => {
              onClose()
              openSettings('persona')
            }}
          >
            {t('chatPersonaManage')}
          </button>
          <Button size="m" onClick={confirm}>
            {t('confirm')}
          </Button>
        </div>
      }
    >
      <div className={styles.list}>
        <button
          type="button"
          className={clsx(styles.option, draft === 'none' && styles.optionActive)}
          onClick={() => setDraft('none')}
        >
          <span className={styles.optionText}>
            <span className={styles.optionLabel}>{t('chatPersonaNone')}</span>
            <span className={styles.optionNote}>{t('chatPersonaNoneNote')}</span>
          </span>
          {draft === 'none' ? <span className={styles.check}>✓</span> : null}
        </button>

        {cards.length === 0 ? (
          <div className={styles.empty}>{t('personaEmpty')}</div>
        ) : (
          cards.map((entry) => {
            const selected = draft === entry.id
            return (
              <button
                key={entry.id}
                type="button"
                className={clsx(
                  styles.option,
                  entry.builtin && styles.optionBuiltin,
                  selected && styles.optionActive
                )}
                onClick={() => setDraft(entry.id)}
              >
                {entry.avatar ? (
                  <img className={styles.avatar} src={entry.avatar} alt="" />
                ) : entry.builtin ? (
                  <span className={styles.avatarBuiltin} aria-hidden>
                    💡
                  </span>
                ) : (
                  <span className={styles.avatarText}>{entry.card.name.slice(0, 1)}</span>
                )}
                <span className={styles.optionText}>
                  <span className={styles.optionLabel}>
                    {entry.card.name}
                    {entry.builtin ? (
                      <span className={styles.builtinBadge}>{t('personaBuiltinBadge')}</span>
                    ) : null}
                  </span>
                  {entry.builtin ? (
                    <span className={styles.optionNote}>{t('personaBuiltinHint')}</span>
                  ) : null}
                </span>
                {selected ? <span className={styles.check}>✓</span> : null}
              </button>
            )
          })
        )}
      </div>
      <div className={styles.note}>{t('chatPersonaNote')}</div>
    </Modal>
  )
}

/** 标题栏上的人设入口：显示当前绑定，点开选择；sessionId 为 null 时作用于下一条新对话 */
export const PersonaButton = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const persona = useChatPersona(sessionId)
  const [open, setOpen] = useState(false)
  const label = persona.entry ? persona.entry.card.name : t('chatPersonaNoneShort')

  return (
    <>
      <button
        type="button"
        className={clsx(styles.chip, persona.entry === null && styles.chipOff)}
        title={t('chatPersonaButton')}
        onClick={() => setOpen(true)}
      >
        {persona.entry?.avatar ? (
          <img className={styles.chipAvatar} src={persona.entry.avatar} alt="" />
        ) : (
          <span className={styles.chipIcon}>C</span>
        )}
        <span className={styles.chipLabel}>{label}</span>
      </button>
      {open ? <PersonaPicker sessionId={sessionId} onClose={() => setOpen(false)} /> : null}
    </>
  )
}
