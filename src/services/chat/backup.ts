import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import { replaceHistory, useChatStore } from './store.js'
import type { ImportSessionOption } from './history/importIndex.js'
import {
  beginImport,
  endImport,
  reportImportEntries,
  reportScanProgress,
  startCommitting,
  startReading,
} from './transfer.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

export type ExportHistoryOptions = {
  /** 是否附带 DS Lite 专属扩展文件（记忆笔记、折叠状态、人设卡与绑定，不含 API Key） */
  includeExtras?: boolean
}

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (
  options: ExportHistoryOptions = {}
): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions(), {
      includeExtras: options.includeExtras === true,
    })
    return { name: backupFileName(now), blob }
  })

/**
 * 确认覆盖后调用：先检查 ZIP 格式与版本，校验失败时保留正在生成的回答；
 * 通过后从 ZIP 流式写入暂存，成功才替换原有会话与图片原件。返回导入的会话数。
 */
export type ImportHistoryOptions = {
  /** 只导入对话文字，跳过图片附件（大归档明显更快，且不占本机存储） */
  skipImages?: boolean
  /** 只导入这些会话 id；缺省表示整包导入 */
  sessionIds?: string[]
  /** 允许重新导入本机已有的会话（以新 id 导入为副本，不覆盖本机原会话） */
  allowDuplicate?: boolean
}

/** 解析归档里的会话清单，用于导入前让用户挑选（只读，不改动本机数据） */
export const readImportSessions = (file: File): Promise<ImportSessionOption[]> =>
  enqueueBackup(async () => {
    const { readImportSessions: read } = await import('./history/importIndex.js')
    return read(file)
  })

/** 本机已有的会话 id：导入时用来标出「本机已有」并跳过，避免覆盖本机版本 */
export const readLocalSessionIds = (): Promise<string[]> =>
  enqueueBackup(async () => (await db.loadSessionSummaries()).map((summary) => summary.id))

/** 导入结果：写入的新会话数，以及因为本机已有而跳过的会话数 */
export type ImportHistoryResult = { imported: number; skipped: number; failed: number }

/**
 * 追加导入：勾选的会话并入本机对话列表，本机已有数据和已有会话都保留。
 * 同一会话（id 相同）在本机已存在时跳过，不让导入覆盖本机更晚的聊天记录。
 */
export const importHistory = (
  file: File,
  options: ImportHistoryOptions = {}
): Promise<ImportHistoryResult> =>
  enqueueBackup(async () => {
    beginImport(file)
    try {
      const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
      const { applyArchiveExtrasPersonas } = await import('./history/extras.js')
      await checkArchiveFormat(file, reportScanProgress)
      const existingIds = (await db.loadSessionSummaries()).map((summary) => summary.id)
      startReading()
      let result: Awaited<ReturnType<typeof importArchive>> = {
        imported: 0,
        skipped: 0,
        failed: 0,
        extras: null,
        idMap: new Map(),
      }
      const imported = await replaceHistory(
        async () => {
          result = await importArchive(file, {
            onEntry: reportImportEntries,
            existingIds,
            ...options,
          })
          startCommitting()
        },
        { merge: true }
      )
      applyArchiveExtrasPersonas(result.extras, result.idMap)
      return { imported, skipped: result.skipped, failed: result.failed }
    } finally {
      endImport()
    }
  })

/**
 * 导出全部会话的记忆笔记。
 * 官方导出格式里没有这个字段，所以单独出一个 JSON：换机、重装后至少还能对照恢复。
 */
export const exportMemoryNotes = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    const { sessions, sessionCache } = useChatStore.getState()
    const entries: unknown[] = []
    for (const summary of sessions) {
      const session = Object.hasOwn(sessionCache, summary.id)
        ? sessionCache[summary.id]
        : await db.loadSession(summary.id)
      const memory = session?.memory
      if (!memory || memory.notes.length === 0) {
        continue
      }
      entries.push({
        id: session.id,
        title: session.title,
        foldedRounds: memory.foldedRounds,
        notes: memory.notes.map((note) => ({
          text: note.text,
          source: note.source,
          createdAt: new Date(note.createdAt).toISOString(),
        })),
      })
    }
    const payload = {
      app: 'DS Lite',
      kind: 'memory-notes',
      version: 1,
      exportedAt: new Date().toISOString(),
      sessions: entries,
    }
    return {
      name: `ds-lite-memory-${formatDate(new Date())}.json`,
      blob: new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    }
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
