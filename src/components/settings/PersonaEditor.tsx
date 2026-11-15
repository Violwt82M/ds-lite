import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { cardToJsonText, emptyCard, type PersonaCard } from '../../services/persona/card.js'
import { savePersonaCard } from '../../services/persona/store.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './PersonaEditor.module.css'

type FieldKey = keyof Pick<
  PersonaCard,
  | 'systemPrompt'
  | 'description'
  | 'personality'
  | 'style'
  | 'rules'
  | 'behavior'
  | 'scenario'
  | 'firstMessage'
  | 'messageExamples'
  | 'postHistoryInstructions'
>

/** 触屏设备（安卓 / iPhone / iPad，含网页版 PWA）：软键盘没有 Shift、也没有真正的 Tab 键 */
const isTouchInput = () =>
  window.matchMedia('(pointer: coarse)').matches ||
  navigator.maxTouchPoints > 0 ||
  window.matchMedia('not all and (min-width: 768px)').matches

/** 角色卡编辑器：本地新建或编辑，保存后写入本机 localStorage */
export const PersonaEditor = ({
  id,
  initial,
  onClose,
}: {
  /** null 表示新建 */
  id: string | null
  initial?: PersonaCard
  onClose: () => void
}) => {
  const t = useTranslate()
  const [draft, setDraft] = useState<PersonaCard>(() => ({
    ...(initial ?? emptyCard()),
  }))
  const set = (patch: Partial<PersonaCard>) => setDraft((value) => ({ ...value, ...patch }))

  const save = () => {
    const name = draft.name.trim()
    if (name === '') {
      showToast({ key: 'personaNameRequired', type: 'error' })
      return
    }
    savePersonaCard(id, { ...draft, name })
    showToast({ key: 'personaSaved', params: { name } })
    onClose()
  }

  const exportJson = () => {
    const blob = new Blob([cardToJsonText(draft)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${draft.name || 'persona'}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const fields: { key: FieldKey; label: string; hint: string }[] = [
    { key: 'systemPrompt', label: t('personaSystemPrompt'), hint: t('personaSystemPromptHint') },
    { key: 'description', label: t('personaDescription'), hint: t('personaDescriptionHint') },
    { key: 'personality', label: t('personaPersonality'), hint: t('personaPersonalityHint') },
    { key: 'style', label: t('personaStyle'), hint: t('personaStyleHint') },
    { key: 'rules', label: t('personaRules'), hint: t('personaRulesHint') },
    { key: 'behavior', label: t('personaBehavior'), hint: t('personaBehaviorHint') },
    { key: 'scenario', label: t('personaScenario'), hint: t('personaScenarioHint') },
    { key: 'firstMessage', label: t('personaFirstMessage'), hint: t('personaFirstMessageHint') },
    { key: 'messageExamples', label: t('personaExamples'), hint: t('personaExamplesHint') },
    {
      key: 'postHistoryInstructions',
      label: t('personaPostHistory'),
      hint: t('personaPostHistoryHint'),
    },
  ]

  return (
    <Modal
      title={t(id ? 'personaEditorTitleEdit' : 'personaEditorTitleNew')}
      className={styles.dialog}
      mainClassName={styles.body}
      onClose={onClose}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="outlined" size="m" onClick={onClose}>
            {t('cancel')}
          </Button>
          {id ? (
            <Button variant="outlined" size="m" onClick={exportJson}>
              {t('personaExport')}
            </Button>
          ) : null}
          <Button variant="primary" size="m" onClick={save}>
            {t('personaSave')}
          </Button>
        </div>
      }
    >
      <div className={styles.field}>
        <div className={styles.label}>
          {t('personaName')}
          <span className={styles.required}>*</span>
        </div>
        <input
          className={styles.input}
          value={draft.name}
          placeholder={t('personaNamePlaceholder')}
          onChange={(event) => set({ name: event.target.value })}
        />
      </div>

      {fields.map((field) => (
        <div key={field.key} className={styles.field}>
          <div className={styles.label}>{field.label}</div>
          <textarea
            className={styles.textarea}
            value={draft[field.key]}
            placeholder={field.hint}
            enterKeyHint="enter"
            onChange={(event) => set({ [field.key]: event.target.value } as Partial<PersonaCard>)}
            onKeyDown={(event) => {
              // 回车只用于换行：别让外层的弹窗 / 快捷键把它吃掉
              if (event.key === 'Enter') {
                event.stopPropagation()
                return
              }
              // 部分安卓输入法把软键盘上的「下一项」实现成 Tab，会把焦点跳到下一个字段；
              // 触屏设备上按换行处理，桌面键盘的 Tab 仍然正常切换焦点。
              if (event.key !== 'Tab' || !isTouchInput() || event.shiftKey) {
                return
              }
              event.preventDefault()
              const element = event.currentTarget
              const { selectionStart: start, selectionEnd: end } = element
              set({ [field.key]: `${element.value.slice(0, start)}\n${element.value.slice(end)}` } as Partial<PersonaCard>)
              requestAnimationFrame(() => {
                element.focus({ preventScroll: true })
                element.setSelectionRange(start + 1, start + 1)
              })
            }}
          />
        </div>
      ))}
    </Modal>
  )
}
