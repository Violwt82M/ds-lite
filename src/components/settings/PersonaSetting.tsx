import { HIDDEN_FILE_INPUT_STYLE } from '../../utils/hiddenFileInput.js'
import clsx from 'clsx'
import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { parsePersonaJson, parsePersonaPng, type ParseResult, type PersonaCard } from '../../services/persona/card.js'
import {
  addPersonaCard,
  removePersonaCard,
  setActivePersona,
  setPersonaAvatar,
  setPersonaEnabled,
  setPersonaShowAvatar,
  setPersonaUserName,
  usePersona,
} from '../../services/persona/store.js'
import { toAvatarDataUrl } from '../../utils/image.js'
import { setSafety, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { IconEditOutline16, IconUploadOutline14 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { PersonaEditor } from './PersonaEditor.js'
import settingsStyles from './Settings.module.css'
import styles from './PersonaSetting.module.css'

/** 按扩展名 / MIME 选择解析器；PNG 角色卡是酒馆最常见的分发格式 */
const parseFile = async (file: File): Promise<ParseResult> => {
  const isJson = /\.json$/i.test(file.name) || file.type === 'application/json'
  if (isJson) {
    return parsePersonaJson(await file.text())
  }
  return parsePersonaPng(await file.arrayBuffer())
}

const Row = ({
  label,
  description,
  action,
}: {
  label: string
  description?: string
  action: React.ReactNode
}) => (
  <div className={clsx(settingsStyles.cell, settingsStyles.row)}>
    <div className={settingsStyles.text}>
      <div className={settingsStyles.label}>{label}</div>
      {description ? <div className={settingsStyles.description}>{description}</div> : null}
    </div>
    {action}
  </div>
)

/** 设置弹窗的「角色扮演」分组：启用开关、角色库、导入/自建、称呼、内容审查 */
export const PersonaSetting = () => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [editor, setEditor] = useState<{
    id: string | null
    initial?: PersonaCard
    avatar?: string
  } | null>(null)
  const enabled = usePersona((state) => state.enabled)
  const userName = usePersona((state) => state.userName)
  const cards = usePersona((state) => state.cards)
  const activeId = usePersona((state) => state.activeId)
  const showAvatar = usePersona((state) => state.showAvatar)
  const safety = useSettings((state) => state.safety)
  const active = cards.find((entry) => entry.id === activeId)

  const onPick = async (file: File | undefined) => {
    if (!file) {
      return
    }
    try {
      const result = await parseFile(file)
      if (!result.ok) {
        showToast({ key: 'personaImportFailed', params: { message: result.error }, type: 'error' })
        return
      }
      const entryId = addPersonaCard(result.card)
      // PNG 角色卡自带立绘，直接裁成头像；用户之后可以在编辑器里换
      if (file.type === 'image/png') {
        const avatar = await toAvatarDataUrl(file)
        if (avatar) {
          setPersonaAvatar(entryId, avatar)
        }
      }
      showToast({ key: 'personaImported', params: { name: result.card.name } })
    } catch {
      showToast({ key: 'personaImportFailed', params: { message: '' }, type: 'error' })
    }
  }

  return (
    <>
      <Row
        label={t('personaEnable')}
        description={t('personaEnableDescription')}
        action={
          <Button
            variant={enabled ? 'dangerOutlined' : 'outlined'}
            size="m"
            className={settingsStyles.cellButton}
            disabled={!active && !enabled}
            onClick={() => setPersonaEnabled(!enabled)}
          >
            {t(enabled ? 'personaTurnOff' : 'personaTurnOn')}
          </Button>
        }
      />
      <Row
        label={t('personaCard')}
        description={active ? t('personaCurrent', { name: active.card.name }) : t('personaNoCard')}
        action={
          <>
            <Button
              variant="outlined"
              size="m"
              className={settingsStyles.cellButton}
              onClick={() => setEditor({ id: null })}
            >
              {t('personaCreate')}
            </Button>
            <Button
              variant="outlined"
              size="m"
              className={clsx(settingsStyles.cellButton, settingsStyles.uploadButton)}
              onClick={() => inputRef.current?.click()}
            >
              <IconUploadOutline14 />
              {t('personaImport')}
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".png,.json,image/png,application/json"
              style={HIDDEN_FILE_INPUT_STYLE}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                void onPick(file)
              }}
            />
          </>
        }
      />
      {cards.length === 0 ? (
        <div className={styles.empty}>{t('personaEmpty')}</div>
      ) : (
        <div className={styles.list}>
          {cards.map((entry) => (
            <div
              key={entry.id}
              className={clsx(styles.item, entry.id === activeId && styles.itemActive)}
            >
              <button
                type="button"
                className={styles.select}
                onClick={() => setActivePersona(entry.id)}
              >
                {entry.avatar ? (
                  <img className={styles.avatar} src={entry.avatar} alt="" />
                ) : (
                  <span className={styles.avatarText}>{entry.card.name.slice(0, 1)}</span>
                )}
                {entry.card.name}
                {entry.id === activeId ? <span className={styles.tag}>{t('personaInUse')}</span> : null}
              </button>
              <button
                type="button"
                className={styles.editButton}
                aria-label={t('personaEdit')}
                onClick={() => setEditor({ id: entry.id, initial: entry.card, avatar: entry.avatar })}
              >
                <IconEditOutline16 />
              </button>
              <button
                type="button"
                className={styles.remove}
                onClick={() => removePersonaCard(entry.id)}
              >
                {t('personaDelete')}
              </button>
            </div>
          ))}
        </div>
      )}
      <Row
        label={t('personaAvatar')}
        description={t('personaAvatarDescription')}
        action={
          <Button
            variant={showAvatar ? 'dangerOutlined' : 'outlined'}
            size="m"
            className={settingsStyles.cellButton}
            disabled={!enabled}
            onClick={() => setPersonaShowAvatar(!showAvatar)}
          >
            {t(showAvatar ? 'personaAvatarOn' : 'personaAvatarOff')}
          </Button>
        }
      />
      <Row
        label={t('safetyTitle')}
        description={t('safetyDescription')}
        action={
          <Button
            variant={safety === 'high' ? 'dangerOutlined' : 'outlined'}
            size="m"
            className={settingsStyles.cellButton}
            onClick={() => setSafety(safety === 'high' ? 'low' : 'high')}
          >
            {t(safety === 'high' ? 'safetyHigh' : 'safetyLow')}
          </Button>
        }
      />
      <Row
        label={t('personaUserName')}
        description={t('personaUserNameDescription')}
        action={
          <input
            className={styles.input}
            type="text"
            value={userName}
            placeholder={t('personaUserNamePlaceholder')}
            onChange={(event) => setPersonaUserName(event.target.value)}
          />
        }
      />
      {editor ? (
        <PersonaEditor
          id={editor.id}
          initial={editor.initial}
          avatar={editor.avatar}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </>
  )
}
