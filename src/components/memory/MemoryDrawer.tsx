import { useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  addMemoryNote,
  cancelMemoryCompaction,
  clearSessionMemory,
  compactSessionMemory,
  generateMemoryNote,
  getFoldedRounds,
  removeAttachmentMemory,
  removeMemoryNote,
  saveAttachmentMemory,
  saveMemoryNote,
  setMemoryInstruction,
  useChatStore,
} from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { openSettings } from '../settings/settingsDialogState.js'
import {
  formatCharCount,
  getContextLevel,
  getContextUsage,
  getUnfoldedRounds,
  splitFoldableRounds,
} from '../../services/memory/context.js'
import { closeMemoryPanel, useMemoryPanel } from '../../services/memory/state.js'
import { saveFile } from '../../services/export/saveFile.js'
import { setAutoMemory, setMemoryMode, useSettings } from '../../services/settings.js'
import { formatTokens } from '../../services/usage.js'
import { Button } from '../base/Button.js'
import { IconEditOutline16, IconNotebookOutline16, IconTrashOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './MemoryDrawer.module.css'

/** 聊天页右上角的记忆（笔记）面板：看上下文占用、手动整理、编辑笔记、导出或清空。 */
export const MemoryDrawer = ({ session }: { session: Session }) => {
  const open = useMemoryPanel((state) => state.open)
  return open ? <MemoryPanel session={session} /> : null
}

const MemoryPanel = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const usage = useMemo(() => getContextUsage(session), [session])
  const compacting = useMemoryPanel((state) => Boolean(state.compacting[session.id]))
  const progress = useMemoryPanel((state) => state.progress[session.id])
  const error = useMemoryPanel((state) => state.errors[session.id])
  const autoMemory = useSettings((state) => state.autoMemory)
  const hasApiKey = useSettings((state) => Boolean(state.apiKey))
  const memoryMode = useSettings((state) => state.memoryMode)
  const memoryKeepTokens = useSettings((state) => state.memoryKeepTokens)
  const locale = useSettings((state) => state.locale)
  const streaming = useChatStore((state) => Boolean(state.streaming[session.id]))
  const notes = session.memory?.notes ?? []
  const attachments = session.memory?.attachments ?? []
  const zh = locale === 'zh-CN'
  const roundCount = getUnfoldedRounds(session).length
  // 与真正整理共用同一套保留上下文 token 数：说「能整理」就一定整理得出东西
  const foldable = splitFoldableRounds(getUnfoldedRounds(session), memoryKeepTokens).foldable.length
  const tokenStats = useMemo(() => {
    let totalInput = 0
    let cacheRead = 0
    let output = 0
    for (const msg of session.messages) {
      if (msg.role === 'assistant' && msg.usage) {
        totalInput +=
          msg.usage.input_tokens +
          msg.usage.cache_creation_input_tokens +
          msg.usage.cache_read_input_tokens
        cacheRead += msg.usage.cache_read_input_tokens
        output += msg.usage.output_tokens
      }
    }
    return { totalInput, cacheRead, output }
  }, [session.messages])
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [editingAttachment, setEditingAttachment] = useState<{ id: string; summary: string } | null>(
    null
  )
  const [expandedAttachments, setExpandedAttachments] = useState<Record<string, boolean>>({})
  const [instruction, setInstruction] = useState(session.memory?.instruction ?? '')
  const [summaryInstruction, setSummaryInstruction] = useState('')
  const [notesOpen, setNotesOpen] = useState(true)
  const [expandedNotes, setExpandedNotes] = useState<Record<string, boolean>>({})
  const [summarizing, setSummarizing] = useState(false)
  const [summaryError, setSummaryError] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmDisableAuto, setConfirmDisableAuto] = useState(false)
  const level = getContextLevel(usage.ratio)
  const percent = Math.min(100, Math.round(usage.ratio * 100))

  // 按钮为什么不能按，直接写在旁边，别让人猜
  const blocked = compacting
    ? null
    : streaming
      ? t('memoryCompactWaitReply')
      : !hasApiKey
        ? t('memoryCompactNeedKey')
        : roundCount < 1
          ? session.messages.length > 0
            ? t('memoryCompactNoRounds', { count: session.messages.length })
            : t('memoryCompactEmptyChat')
          : foldable < 1
            ? t('memoryCompactTooShort')
            : null

  const onCompact = async () => {
    const before = getFoldedRounds(session.id)
    // 只有 1 轮可折叠时（常见于刚导入的老记录），保留 0 轮，别让按钮变成摆设
    const options = roundCount < 2 ? { keep: 0 } : undefined
    const ok = await compactSessionMemory(session.id, 'manual', options)
    if (ok) {
      showToast({
        key: 'memoryCompactDone',
        params: { count: Math.max(1, getFoldedRounds(session.id) - before) },
      })
    }
  }

  const onCancelEdit = () => {
    if (editing) {
      const note = notes.find((item) => item.id === editing.id)
      if (!note || (note.text === '' && editing.text.trim() === '')) {
        removeMemoryNote(session.id, editing.id)
      }
    }
    setEditing(null)
  }

  const onClear = () => {
    clearSessionMemory(session.id)
    setConfirmClear(false)
    setEditing(null)
    setEditingAttachment(null)
    showToast({ key: 'memoryClearDone' })
  }

  const onExport = async () => {
    const data = {
      app: 'DS Lite',
      sessionId: session.id,
      title: session.title,
      exportedAt: new Date().toISOString(),
      foldedRounds: session.memory?.foldedRounds ?? 0,
      notes: notes.map((note) => ({ text: note.text, source: note.source, createdAt: note.createdAt })),
      attachments: attachments.map((item) => ({
        name: item.name,
        summary: item.summary,
        createdAt: item.createdAt,
      })),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    try {
      await saveFile(blob, `ds-lite-memory-${(session.title || session.id).slice(0, 24)}.json`)
    } catch (error) {
      showToast({
        key: 'historyExportFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
        type: 'error',
      })
    }
  }

  return (
    <Modal
      title={
        <span className={styles.titleRow}>
          <IconNotebookOutline16 />
          {t('memoryTitle')}
        </span>
      }
      closable
      className={styles.dialog}
      mainClassName={styles.main}
      scrollable
      onClose={closeMemoryPanel}
      footer={
        <div className={styles.footer}>
          <Button size="m" variant="outlined" disabled={notes.length === 0} onClick={onExport}>
            {t('memoryExport')}
          </Button>
          {confirmClear ? (
            <Button size="m" variant="danger" onClick={onClear}>
              {t('memoryClearConfirm')}
            </Button>
          ) : (
            <Button
              size="m"
              variant="dangerOutlined"
              disabled={!session.memory}
              onClick={() => setConfirmClear(true)}
            >
              {t('memoryClear')}
            </Button>
          )}
          <Button size="m" onClick={closeMemoryPanel}>
            {t('memoryDone')}
          </Button>
        </div>
      }
    >
      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>{t('memoryContextTitle')}</span>
          <span className={styles.sectionValue}>
            {t('memoryContextLine', {
              used: formatCharCount(usage.usedTokens),
              limit: formatCharCount(usage.limitTokens),
              percent,
            })}
          </span>
        </div>
        <div className={styles.progress} aria-hidden="true">
          <div
            className={styles.progressFill}
            style={{ width: `${Math.max(2, percent)}%` }}
            data-level={level}
          />
        </div>
        <div className={styles.meta}>{t('memoryRoundCount', { count: roundCount })}</div>
        <div className={styles.meta}>{t('memoryFoldedCount', { count: usage.foldedRounds })}</div>
        {tokenStats.totalInput > 0 || tokenStats.output > 0 ? (
          <div className={styles.meta}>
            {t('memoryCacheHitStats', {
              cached: formatTokens(tokenStats.cacheRead),
              input: formatTokens(tokenStats.totalInput),
              rate:
                tokenStats.totalInput > 0
                  ? Math.round((tokenStats.cacheRead / tokenStats.totalInput) * 100)
                  : 0,
              output: formatTokens(tokenStats.output),
            })}
          </div>
        ) : null}
        <div className={styles.legend}>
          <div className={styles.legendRow}>
            <span className={styles.dot} data-level="low" />
            {t('memoryLegendLow')}
          </div>
          <div className={styles.legendRow}>
            <span className={styles.dot} data-level="mid" />
            {t('memoryLegendMid')}
          </div>
          <div className={styles.legendRow}>
            <span className={styles.dot} data-level="high" />
            {t('memoryLegendHigh')}
          </div>
          <div className={styles.legendRow}>
            <span className={styles.dot} data-level="critical" />
            {t('memoryLegendCritical')}
          </div>
        </div>
        <div className={styles.hint}>{t('memoryContextHint')}</div>
      </div>

      <div className={styles.section}>
        <div className={styles.row}>
          <div className={styles.rowText}>
            <div className={styles.rowLabel}>{t('memoryAuto')}</div>
            <div className={styles.hint}>{t('memoryAutoDescription')}</div>
          </div>
          {confirmDisableAuto ? (
            <div className={styles.confirmBox}>
              <div className={styles.hint}>{t('memoryAutoDisableHint')}</div>
              <div className={styles.noteActions}>
                <Button size="s" variant="outlined" onClick={() => setConfirmDisableAuto(false)}>
                  {t('cancel')}
                </Button>
                <Button
                  size="s"
                  variant="danger"
                  onClick={() => {
                    setAutoMemory(false)
                    setConfirmDisableAuto(false)
                  }}
                >
                  {t('memoryAutoDisableConfirm')}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="m"
              variant={autoMemory ? 'outlined' : 'dangerOutlined'}
              onClick={() => {
                if (autoMemory) {
                  setConfirmDisableAuto(true)
                } else {
                  setAutoMemory(true)
                }
              }}
            >
              {t(autoMemory ? 'personaTurnOff' : 'personaTurnOn')}
            </Button>
          )}
        </div>
        <div className={styles.instruction}>
          <div className={styles.instructionLabel}>{t('memoryInstructionLabel')}</div>
          <input
            className={styles.instructionInput}
            type="text"
            maxLength={200}
            placeholder={t('memoryInstructionPlaceholder')}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            onBlur={() => setMemoryInstruction(session.id, instruction)}
          />
          <div className={styles.hint}>{t('memoryInstructionHint')}</div>
        </div>
        <div className={styles.modeRow}>
          <span className={styles.modeLabel}>{t('memoryModeLabel')}</span>
          <div className={styles.modeGroup}>
            {(
              [
                ['auto', 'memoryModeAuto'],
                ['rp', 'memoryModeRp'],
                ['plain', 'memoryModePlain'],
              ] as const
            ).map(([value, key]) => (
              <button
                key={value}
                type="button"
                className={memoryMode === value ? styles.modeActive : styles.mode}
                onClick={() => setMemoryMode(value)}
              >
                {t(key)}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.hint}>{t('memoryModeHint')}</div>
        <div className={styles.compactRow}>
          <Button size="m" disabled={blocked !== null} onClick={() => void onCompact()}>
            {compacting && progress
              ? t('memoryCompactProgress', { done: progress.done, total: progress.total })
              : t(compacting ? 'memoryCompacting' : 'memoryCompactNow')}
          </Button>
          {compacting ? (
            <Button size="m" variant="outlined" onClick={() => cancelMemoryCompaction(session.id)}>
              {t('cancel')}
            </Button>
          ) : (
            <span className={styles.hint}>
              {blocked ??
                t('memoryCompactHint', { count: Math.max(1, foldable) })}
            </span>
          )}
        </div>
        {error ? (
          <div className={styles.error}>{t(error.key, error.params)}</div>
        ) : null}
        <div className={styles.hint}>{t('memoryCompactKeeps')}</div>
      </div>

        <div className={styles.summaryCard}>
          <div className={styles.summaryHead}>
            <span className={styles.summaryTitle}>{t('memorySummaryLabel')}</span>
            <span className={styles.summaryBadge}>{t('memorySummaryBadge')}</span>
          </div>
          <div className={styles.summaryHint}>{t('memorySummaryHint')}</div>
          <textarea
            className={styles.summaryInput}
            rows={2}
            maxLength={300}
            placeholder={t('memorySummaryDefault')}
            value={summaryInstruction}
            onChange={(event) => setSummaryInstruction(event.target.value)}
          />
          <div className={styles.summaryActions}>
            {summaryError !== null ? (
              <span className={styles.error}>{summaryError}</span>
            ) : (
              <span />
            )}
            <Button
              size="m"
              disabled={summarizing || streaming || !hasApiKey}
              onClick={async () => {
                setSummarizing(true)
                setSummaryError(null)
                const result = await generateMemoryNote(
                  session.id,
                  summaryInstruction.trim() || t('memorySummaryDefault')
                )
                setSummarizing(false)
                if (!result.ok) {
                  setSummaryError(
                    result.reason === 'nokey'
                      ? t('memoryCompactNeedKey')
                      : t('memorySummaryFailed', { message: result.reason ?? '' })
                  )
                }
              }}
            >
              {summarizing ? t('memorySummaryBusy') : t('memorySummaryButton')}
            </Button>
          </div>
        </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <button
            type="button"
            className={styles.sectionToggle}
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen((value) => !value)}
          >
            <span className={styles.sectionTitle}>
              {t('memoryNotesTitle', { count: notes.length })}
            </span>
            <span className={notesOpen ? styles.chevronOpen : styles.chevron} aria-hidden>
              ▾
            </span>
          </button>
          <Button
            size="s"
            variant="outlined"
            onClick={() => {
              const id = addMemoryNote(session.id)
              setEditing({ id, text: '' })
            }}
          >
            {t('memoryAdd')}
          </Button>
        </div>
        {!notesOpen ? null : notes.length === 0 ? (
          <div className={styles.empty}>{t('memoryNotesEmpty')}</div>
        ) : (
          <div className={styles.notes}>
            {notes.map((note) =>
              editing?.id === note.id ? (
                <div key={note.id} className={styles.noteEdit}>
                  <textarea
                    className={styles.textarea}
                    value={editing.text}
                    rows={12}
                    autoFocus
                    placeholder={t('memoryNotePlaceholder')}
                    onChange={(event) => setEditing({ id: note.id, text: event.target.value })}
                  />
                  <div className={styles.noteActions}>
                    <Button size="s" variant="outlined" onClick={onCancelEdit}>
                      {t('cancel')}
                    </Button>
                    <Button
                      size="s"
                      onClick={() => {
                        saveMemoryNote(session.id, note.id, editing.text)
                        setEditing(null)
                      }}
                    >
                      {t('memorySave')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div key={note.id} className={styles.note}>
                  <div
                    className={
                      expandedNotes[note.id] ? styles.noteText : `${styles.noteText} ${styles.noteTextClamp}`
                    }
                  >
                    {note.text || t('memoryNotePlaceholder')}
                  </div>
                  {note.text.length > 120 ? (
                    <button
                      type="button"
                      className={styles.noteToggle}
                      onClick={() =>
                        setExpandedNotes((current) => ({
                          ...current,
                          [note.id]: !current[note.id],
                        }))
                      }
                    >
                      {t(expandedNotes[note.id] ? 'recordsCollapse' : 'recordsExpand')}
                    </button>
                  ) : null}
                  <div className={styles.noteMeta}>
                    <span className={styles.noteSource}>
                      {t(
                    note.source === 'auto'
                      ? 'memorySourceAuto'
                      : note.source === 'summary'
                        ? 'memorySourceSummary'
                        : 'memorySourceManual'
                  )}
                    </span>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={t('memoryEdit')}
                      onClick={() => setEditing({ id: note.id, text: note.text })}
                    >
                      <IconEditOutline16 />
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={t('delete')}
                      onClick={() => removeMemoryNote(session.id, note.id)}
                    >
                      <IconTrashOutline16 />
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
        )}
        <div className={styles.hint}>{t('memoryCaveat')}</div>
      </div>

      {attachments.length > 0 ? (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>
              {zh ? `资料记忆（${attachments.length}）` : `Attachment memory (${attachments.length})`}
            </span>
          </div>
          <div className={styles.hint}>
            {zh
              ? '从附件内容提炼的独立资料摘要，不会被常规剧情整理覆盖；可编辑或删除。'
              : 'Standalone digests distilled from uploaded files. They survive normal compaction and can be edited or deleted.'}
          </div>
          <div className={styles.notes}>
            {attachments.map((item) =>
              editingAttachment?.id === item.id ? (
                <div key={item.id} className={styles.noteEdit}>
                  <div className={styles.attachmentName}>{item.name}</div>
                  <textarea
                    className={styles.textarea}
                    value={editingAttachment.summary}
                    rows={8}
                    autoFocus
                    placeholder={
                      zh ? '写清这份资料的核心内容与结论…' : 'Summarise the key content and conclusions…'
                    }
                    onChange={(event) =>
                      setEditingAttachment({ id: item.id, summary: event.target.value })
                    }
                  />
                  <div className={styles.noteActions}>
                    <Button size="s" variant="outlined" onClick={() => setEditingAttachment(null)}>
                      {t('cancel')}
                    </Button>
                    <Button
                      size="s"
                      onClick={() => {
                        saveAttachmentMemory(session.id, item.id, editingAttachment.summary)
                        setEditingAttachment(null)
                      }}
                    >
                      {t('memorySave')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div key={item.id} className={styles.note}>
                  <div className={styles.attachmentBody}>
                    <div className={styles.attachmentName}>{item.name}</div>
                    <div
                      className={
                        expandedAttachments[item.id]
                          ? styles.attachmentSummary
                          : `${styles.attachmentSummary} ${styles.noteTextClamp}`
                      }
                    >
                      {item.summary}
                    </div>
                    {item.summary.length > 120 ? (
                      <button
                        type="button"
                        className={styles.noteToggle}
                        onClick={() =>
                          setExpandedAttachments((current) => ({
                            ...current,
                            [item.id]: !current[item.id],
                          }))
                        }
                      >
                        {t(expandedAttachments[item.id] ? 'recordsCollapse' : 'recordsExpand')}
                      </button>
                    ) : null}
                  </div>
                  <div className={styles.noteMeta}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={t('memoryEdit')}
                      onClick={() => setEditingAttachment({ id: item.id, summary: item.summary })}
                    >
                      <IconEditOutline16 />
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={t('delete')}
                      onClick={() => {
                        removeAttachmentMemory(session.id, item.id)
                        if (editingAttachment?.id === item.id) {
                          setEditingAttachment(null)
                        }
                      }}
                    >
                      <IconTrashOutline16 />
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
          <div className={styles.hint}>
            {zh
              ? '资料记忆单独保存，不参与覆盖式整理；删除后可在下次整理附件时重新提炼。'
              : 'These digests are stored separately and are not overwritten by compaction; deleted ones can be rebuilt the next time the attachment is condensed.'}
          </div>
        </div>
      ) : null}

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>{t('contextGuideTitle')}</span>
        </div>
        <ul className={styles.guideList}>
          <li>{t('contextGuidePoint1')}</li>
          <li>{t('contextGuidePoint2')}</li>
          <li>{t('contextGuidePoint3')}</li>
        </ul>
        <div className={styles.guideTip}>{t('contextGuideTip')}</div>
        <button
          type="button"
          className={styles.guideLink}
          onClick={() => openSettings('about')}
        >
          {t('tutorialLinkHint')} →
        </button>
      </div>
    </Modal>
  )
}
