import { useMemo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  addMemoryNote,
  cancelMemoryCompaction,
  clearSessionMemory,
  compactSessionMemory,
  getFoldedRounds,
  removeMemoryNote,
  saveMemoryNote,
  useChatStore,
} from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import {
  formatCharCount,
  getContextLevel,
  getContextUsage,
  getUnfoldedRounds,
} from '../../services/memory/context.js'
import { closeMemoryPanel, useMemoryPanel } from '../../services/memory/state.js'
import { saveFile } from '../../services/export/saveFile.js'
import { setAutoMemory, useSettings } from '../../services/settings.js'
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
  const error = useMemoryPanel((state) => state.errors[session.id])
  const autoMemory = useSettings((state) => state.autoMemory)
  const hasApiKey = useSettings((state) => Boolean(state.apiKey))
  const streaming = useChatStore((state) => Boolean(state.streaming[session.id]))
  const notes = session.memory?.notes ?? []
  const roundCount = getUnfoldedRounds(session).length
  // 手动整理保留最近 1 轮原文，其余折叠成笔记
  const foldable = Math.max(0, roundCount - 1)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
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
        <div className={styles.compactRow}>
          <Button size="m" disabled={blocked !== null} onClick={() => void onCompact()}>
            {t(compacting ? 'memoryCompacting' : 'memoryCompactNow')}
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
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>{t('memoryNotesTitle', { count: notes.length })}</span>
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
        {notes.length === 0 ? (
          <div className={styles.empty}>{t('memoryNotesEmpty')}</div>
        ) : (
          <div className={styles.notes}>
            {notes.map((note) =>
              editing?.id === note.id ? (
                <div key={note.id} className={styles.noteEdit}>
                  <textarea
                    className={styles.textarea}
                    value={editing.text}
                    rows={3}
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
                  <div className={styles.noteText}>
                    {note.text || t('memoryNotePlaceholder')}
                  </div>
                  <div className={styles.noteMeta}>
                    <span className={styles.noteSource}>
                      {t(note.source === 'auto' ? 'memorySourceAuto' : 'memorySourceManual')}
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
      </div>
    </Modal>
  )
}
