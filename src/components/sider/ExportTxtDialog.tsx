import { useState } from 'react'
import * as db from '../../services/chat/db.js'
import {
  buildSessionTxt,
  readExportTxtOptions,
  saveExportTxtOptions,
  type ExportTxtOptions,
} from '../../services/chat/exportTxt.js'
import { useChatStore } from '../../services/chat/store.js'
import { saveFile } from '../../services/export/saveFile.js'
import { resolveSessionPersona } from '../../services/persona/scope.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './ExportTxtDialog.module.css'

export const ExportTxtDialog = ({
  sessionId,
  sessionTitle,
  onClose,
}: {
  sessionId: string
  sessionTitle: string
  onClose: () => void
}) => {
  const [options, setOptions] = useState<ExportTxtOptions>(() => readExportTxtOptions())
  const [busy, setBusy] = useState(false)

  const personaName = resolveSessionPersona(sessionId).entry?.card.name ?? null

  const update = <K extends keyof ExportTxtOptions>(key: K, value: ExportTxtOptions[K]) => {
    setOptions((prev) => ({ ...prev, [key]: value }))
  }

  const handleExport = async () => {
    if (busy) {
      return
    }
    setBusy(true)
    saveExportTxtOptions(options)
    try {
      const cached = useChatStore.getState().sessionCache[sessionId]
      const session = cached ?? (await db.loadSession(sessionId))
      if (!session) {
        showToast('未找到该对话内容')
        return
      }
      const { name, blob } = buildSessionTxt(session, options, personaName)
      await saveFile(blob, name)
      showToast('已导出对话 TXT')
      onClose()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      showToast(`导出失败：${reason}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`导出当前对话（txt）`}
      closable
      onClose={onClose}
      footer={
        <div className={styles.footer}>
          <Button variant="outlined" size="m" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button size="m" disabled={busy} onClick={() => void handleExport()}>
            {busy ? '导出中…' : '导出 TXT'}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <div className={styles.rowHint}>目标对话：{sessionTitle}</div>

        <label className={styles.row}>
          <span className={styles.rowInfo}>
            <span>包含思考过程</span>
            <span className={styles.rowHint}>默认关闭，开启后在正文前附带思考内容</span>
          </span>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={options.includeThinking}
            onChange={(event) => update('includeThinking', event.target.checked)}
          />
        </label>

        <label className={styles.row}>
          <span className={styles.rowInfo}>
            <span>包含时间与模型名</span>
            <span className={styles.rowHint}>在每条消息标题处标注发送时间与模型</span>
          </span>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={options.includeMeta}
            onChange={(event) => update('includeMeta', event.target.checked)}
          />
        </label>

        <label className={styles.row}>
          <span className={styles.rowInfo}>
            <span>显示人设名字</span>
            <span className={styles.rowHint}>
              {personaName
                ? `开启后 AI 名称显示为「${personaName}」，关闭则显示「AI」`
                : '当前对话未绑定人设，默认显示为「AI」'}
            </span>
          </span>
          <input
            type="checkbox"
            className={styles.checkbox}
            checked={options.showPersonaName}
            onChange={(event) => update('showPersonaName', event.target.checked)}
          />
        </label>

        <div className={styles.inputGroup}>
          <label className={styles.inputLabel} htmlFor="export-txt-user-name">
            自定义用户在 txt 内的名字
          </label>
          <input
            id="export-txt-user-name"
            type="text"
            className={styles.input}
            maxLength={32}
            placeholder="默认：我"
            value={options.userName}
            onChange={(event) => update('userName', event.target.value)}
          />
        </div>
      </div>
    </Modal>
  )
}
