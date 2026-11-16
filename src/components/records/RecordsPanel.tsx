import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { resolveSessionPersona } from '../../services/persona/scope.js'
import {
  deleteSessionRecord,
  generateSessionRecord,
  updateSessionRecord,
  useChatStore,
} from '../../services/chat/store.js'
import type { Session, SessionRecord } from '../../services/chat/types.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconChevronRightOutline14, IconTrashOutline16 } from '../base/icons.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { Modal } from '../base/Modal.js'
import { closeRecordsPanel } from './recordsPanelState.js'
import styles from './RecordsPanel.module.css'

/** 时间显示到分钟，列表里够看 */
const formatTime = (timestamp: number, locale: string) =>
  new Date(timestamp).toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

/**
 * 一条记录：默认折叠，只显示标题和时间。
 * 标题和正文都能直接改，改完失焦即存；记录不进上下文，也不会跟着导出备份走。
 */
const RecordItem = ({ sessionId, record }: { sessionId: string; record: SessionRecord }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState(record.title)
  const [text, setText] = useState(record.text)

  // 外部改了（例如重新生成覆盖）就同步回来
  useEffect(() => {
    setTitle(record.title)
    setText(record.text)
  }, [record.title, record.text])

  const save = () => {
    const nextTitle = title.trim() === '' ? record.title : title.trim()
    setTitle(nextTitle)
    if (nextTitle !== record.title || text !== record.text) {
      updateSessionRecord(sessionId, record.id, { title: nextTitle, text })
    }
  }

  return (
    <div className={styles.record}>
      <div
        className={styles.recordHead}
        role="button"
        tabIndex={0}
        title={t('recordsFoldHint')}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            setOpen(!open)
          }
        }}
      >
        <span className={clsx(styles.chevron, open && styles.chevronOpen)}>
          <IconChevronRightOutline14 />
        </span>
        <input
          className={styles.titleInput}
          value={title}
          maxLength={60}
          aria-label={t('recordsRename')}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={save}
        />
        <span className={styles.time}>{formatTime(record.createdAt, locale)}</span>
        <span onClick={(event) => event.stopPropagation()}>
          <IconButton
            size="xs"
            tooltip={t('recordsDelete')}
            icon={<IconTrashOutline16 />}
            onClick={() => deleteSessionRecord(sessionId, record.id)}
          />
        </span>
      </div>
      {open ? (
        <textarea
          className={styles.text}
          rows={10}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={save}
        />
      ) : (
        <div className={styles.preview} onClick={() => setOpen(true)}>
          {record.text.slice(0, 120)}
          {record.text.length > 120 ? '…' : ''}
        </div>
      )}
    </div>
  )
}

/**
 * 记录小窗：给一句提示词，让 AI 把这段对话写成一段回顾/日记。
 * 想写什么完全由提示词决定（语气、时间范围、要不要写成日记都行）。
 */
export const RecordsPanel = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const hasApiKey = useSettings((state) => Boolean(state.apiKey))
  const streaming = useChatStore((state) => Boolean(state.streaming[session.id]))
  // 开了人设时预填「写互动日记」的要求，用户可以直接改或清空
  const personaName = resolveSessionPersona(session.id).entry?.card.name ?? null
  const [instruction, setInstruction] = useState(
    personaName === null ? '' : t('recordsPersonaDefault', { name: personaName })
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const records = session.records ?? []

  const generate = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    const result = await generateSessionRecord(session.id, instruction)
    setBusy(false)
    if (!result.ok) {
      setError(result.reason === 'nokey' ? t('recordsNeedKey') : t('recordsFailed', { message: result.reason ?? '' }))
    }
  }

  return (
    <Modal
      title={t('recordsTitle')}
      closable
      className={styles.dialog}
      mainClassName={styles.main}
      onClose={closeRecordsPanel}
      footer={
        <div className={styles.footer}>
          <span className={styles.hint}>{t('recordsFooterHint')}</span>
        </div>
      }
    >
      <div className={styles.generate}>
        <textarea
          className={styles.instruction}
          rows={2}
          maxLength={300}
          placeholder={t('recordsInstructionPlaceholder')}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
        />
        <div className={styles.generateRow}>
          <span className={styles.hint}>{t('recordsHint')}</span>
          <Button
            size="m"
            variant="primary"
            disabled={busy || streaming || !hasApiKey}
            onClick={() => void generate()}
          >
            {busy ? t('recordsGenerating') : t('recordsGenerate')}
          </Button>
        </div>
        <div className={styles.notice}>{t('recordsNotInContext')}</div>
        <button
          type="button"
          className={styles.guideLink}
          onClick={() => openSettings('about')}
        >
          {t('tutorialLinkHint')} →
        </button>
        {streaming ? <div className={styles.hint}>{t('recordsWaitReply')}</div> : null}
        {error !== null ? <div className={styles.error}>{error}</div> : null}
      </div>

      <div className={styles.listHead}>
        <span>{t('recordsListTitle', { count: records.length })}</span>
        <span className={styles.listHint}>{t('recordsFoldHint')}</span>
      </div>
      {records.length === 0 ? (
        <div className={styles.empty}>{t('recordsEmpty')}</div>
      ) : (
        <div className={styles.list}>
          {records.map((record) => (
            <RecordItem key={record.id} sessionId={session.id} record={record} />
          ))}
        </div>
      )}
    </Modal>
  )
}
