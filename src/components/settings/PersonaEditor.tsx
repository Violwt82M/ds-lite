import { HIDDEN_FILE_INPUT_STYLE } from '../../utils/hiddenFileInput.js'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { cardToJsonText, emptyCard, type PersonaCard } from '../../services/persona/card.js'
import { saveFile } from '../../services/export/saveFile.js'
import { savePersonaCard, setPersonaAvatar } from '../../services/persona/store.js'
import {
  clearScopedWallpaper,
  hasScopedWallpaper,
  setScopedWallpaperBlob,
} from '../../services/wallpaper.js'
import { toAvatarDataUrl } from '../../utils/image.js'
import { ImageCropDialog } from '../base/ImageCropDialog.js'
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

/** 角色名称也改用自动换行的自适应 textarea（禁回车），长名字不用左右拖动查看 */
const NameTextarea = ({
  value,
  placeholder,
  onChange,
}: {
  value: string
  placeholder: string
  onChange: (next: string) => void
}) => {
  const ref = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.max(40, el.scrollHeight)}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      rows={1}
      wrap="soft"
      className={styles.nameTextarea}
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value.replace(/\r?\n/g, ' '))}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
        }
      }}
    />
  )
}

/** 可自动换行、自适应增高、并支持一键「展开全文 / 收起」的角色卡字段编辑框 */
const ExpandableField = ({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (next: string) => void
}) => {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const COMPACT_MAX = 180

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    const full = Math.max(76, el.scrollHeight)
    setOverflows(full > COMPACT_MAX)
    el.style.height = `${expanded ? full : Math.min(full, COMPACT_MAX)}px`
  }, [value, expanded])

  return (
    <div className={styles.field}>
      <div className={styles.labelRow}>
        <div className={styles.label}>{label}</div>
        <div className={styles.fieldMeta}>
          {value.length > 0 ? <span className={styles.charCount}>{value.length} 字</span> : null}
          {overflows || expanded ? (
            <button
              type="button"
              className={styles.expandToggle}
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? '收起' : '展开全部'}
            </button>
          ) : null}
        </div>
      </div>
      <textarea
        ref={ref}
        wrap="soft"
        className={expanded ? styles.textareaExpanded : styles.textarea}
        value={value}
        placeholder={placeholder}
        enterKeyHint="enter"
        onChange={(event) => onChange(event.target.value)}
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
          onChange(`${element.value.slice(0, start)}\n${element.value.slice(end)}`)
          requestAnimationFrame(() => {
            element.focus({ preventScroll: true })
            element.setSelectionRange(start + 1, start + 1)
          })
        }}
      />
    </div>
  )
}

/** 角色卡编辑器：本地新建或编辑，保存后写入持久角色库 */
export const PersonaEditor = ({
  id,
  initial,
  avatar: initialAvatar,
  onClose,
}: {
  /** null 表示新建 */
  id: string | null
  initial?: PersonaCard
  /** 已有的头像（data URL） */
  avatar?: string
  onClose: () => void
}) => {
  const t = useTranslate()
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const bgInputRef = useRef<HTMLInputElement>(null)
  const [avatar, setAvatar] = useState<string | undefined>(initialAvatar)
  const [cropFile, setCropFile] = useState<File | null>(null)
  const [bgCropFile, setBgCropFile] = useState<File | null>(null)
  const [hasBg, setHasBg] = useState<boolean>(() => (id ? hasScopedWallpaper('persona', id) : false))
  const [pendingBgBlob, setPendingBgBlob] = useState<Blob | null>(null)
  const [bgCleared, setBgCleared] = useState(false)
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
    const entryId = savePersonaCard(id, { ...draft, name })
    if (avatar !== initialAvatar) {
      setPersonaAvatar(entryId, avatar ?? null)
    }
    if (pendingBgBlob !== null) {
      void setScopedWallpaperBlob('persona', entryId, pendingBgBlob)
    } else if (bgCleared) {
      void clearScopedWallpaper('persona', entryId)
    }
    showToast({ key: 'personaSaved', params: { name } })
    onClose()
  }

  // 安卓 WebView 没有下载监听，<a download> 点了没反应；统一走 saveFile（APK 里是系统分享面板）
  const exportJson = () => {
    const blob = new Blob([cardToJsonText(draft)], { type: 'application/json' })
    void saveFile(blob, `${draft.name || 'persona'}.json`).catch(() => {
      showToast({ key: 'personaExportFailed' })
    })
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
      scrollable
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
        <div className={styles.label}>{t('personaAvatar')}</div>
        <div className={styles.avatarRow}>
          {avatar ? (
            <img className={styles.avatarPreview} src={avatar} alt="" />
          ) : (
            <div className={styles.avatarEmpty}>{(draft.name.trim() || '?').slice(0, 1)}</div>
          )}
          <Button variant="outlined" size="s" onClick={() => avatarInputRef.current?.click()}>
            {t('personaAvatarPick')}
          </Button>
          {avatar ? (
            <Button variant="outlined" size="s" onClick={() => setAvatar(undefined)}>
              {t('personaAvatarRemove')}
            </Button>
          ) : null}
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            style={HIDDEN_FILE_INPUT_STYLE}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (!file) {
                return
              }
              setCropFile(file)
            }}
          />
        </div>
      </div>

      {cropFile !== null ? (
        <ImageCropDialog
          file={cropFile}
          aspect="square"
          onCancel={() => setCropFile(null)}
          onConfirm={(blob) => {
            setCropFile(null)
            const cropped = new File([blob], 'avatar.png', { type: 'image/png' })
            void toAvatarDataUrl(cropped).then((url) => {
              if (url) {
                setAvatar(url)
              } else {
                showToast({ key: 'personaAvatarFailed', type: 'error' })
              }
            })
          }}
        />
      ) : null}

      <div className={styles.field}>
        <div className={styles.label}>角色专属聊天背景</div>
        <div className={styles.avatarRow}>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
            {hasBg ? '已绑定专属背景（低于单会话背景，高于全局背景）' : '未设置（默认跟随全局背景）'}
          </span>
          <Button variant="outlined" size="s" onClick={() => bgInputRef.current?.click()}>
            {hasBg ? '更换背景' : '选择背景'}
          </Button>
          {hasBg ? (
            <Button
              variant="outlined"
              size="s"
              onClick={() => {
                setHasBg(false)
                setPendingBgBlob(null)
                setBgCleared(true)
              }}
            >
              清除
            </Button>
          ) : null}
          <input
            ref={bgInputRef}
            type="file"
            accept="image/*"
            style={HIDDEN_FILE_INPUT_STYLE}
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                setBgCropFile(file)
              }
            }}
          />
        </div>
      </div>

      {bgCropFile !== null ? (
        <ImageCropDialog
          file={bgCropFile}
          aspect="screen"
          onCancel={() => setBgCropFile(null)}
          onConfirm={(blob) => {
            setBgCropFile(null)
            setPendingBgBlob(blob)
            setHasBg(true)
            setBgCleared(false)
          }}
        />
      ) : null}

      <div className={styles.field}>
        <div className={styles.label}>
          {t('personaName')}
          <span className={styles.required}>*</span>
        </div>
        <NameTextarea
          value={draft.name}
          placeholder={t('personaNamePlaceholder')}
          onChange={(name) => set({ name })}
        />
      </div>

      {fields.map((field) => (
        <ExpandableField
          key={field.key}
          label={field.label}
          value={draft[field.key]}
          placeholder={field.hint}
          onChange={(value) => set({ [field.key]: value } as Partial<PersonaCard>)}
        />
      ))}
    </Modal>
  )
}
