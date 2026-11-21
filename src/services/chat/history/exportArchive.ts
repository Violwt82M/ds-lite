import * as db from '../db.js'
import type { Session } from '../types.js'
import { DS_LITE_EXTRAS_PATH, buildArchiveExtras } from './extras.js'
import { EXPORT_FORMAT_VERSION, type Manifest, type SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, imagePath, sessionPath } from './paths.js'
import { toIndexEntry, toSessionFile } from './toArchive.js'
import { writeArchive } from './zipWriter.js'

const json = (value: unknown) => new Blob([JSON.stringify(value)], { type: 'application/json' })

/**
 * 按导出格式生成 ZIP：manifest → [可选 ds-lite-extras.json] → 全部会话 JSON → index → 全部图片。
 * 没有账号信息，不写 user.json，绝不包含 API Key。
 * 只写出本地有原件的图片，每个会话目录各写一份；其他附件只有元数据。
 */
export const exportArchive = async (
  sessions: Iterable<Session> | AsyncIterable<Session>,
  options: { includeExtras?: boolean } = {}
): Promise<Blob> => {
  const { includeExtras = false } = options
  const manifest: Manifest = { export_format_version: EXPORT_FORMAT_VERSION }
  const entries = [{ name: MANIFEST_PATH, blob: json(manifest) }]
  const imageEntries: { name: string; blob: Blob }[] = []
  const index: SessionIndexEntry[] = []
  const originals = new Map<string, Blob | undefined>()
  const extraSnapshots: Session[] = []
  for await (const session of sessions) {
    if (includeExtras) {
      extraSnapshots.push({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: [],
        ...(session.memory ? { memory: session.memory } : {}),
        ...(session.records ? { records: session.records } : {}),
        ...(session.memoryBackup ? { memoryBackup: true } : {}),
      })
    }
    for (const message of session.messages) {
      if (message.role === 'user') {
        for (const file of message.files) {
          if (file.isImage && !originals.has(file.id)) {
            originals.set(file.id, await db.loadFile(file.id))
          }
        }
      }
    }
    const images = new Map<string, Blob>()
    const data = toSessionFile(session, ({ id, name, isImage }) => {
      const blob = originals.get(id)
      if (!blob || !isImage) {
        return null
      }
      const path = imagePath(session.id, id, name)
      images.set(path, blob)
      return path
    })
    entries.push({ name: sessionPath(session.id), blob: json(data) })
    for (const [name, blob] of images) {
      imageEntries.push({ name, blob })
    }
    index.push(toIndexEntry(data))
  }
  if (includeExtras) {
    // 紧跟 manifest 之后，方便流式导入先读出记忆与人设再逐条回填到会话
    entries.splice(1, 0, {
      name: DS_LITE_EXTRAS_PATH,
      blob: json(buildArchiveExtras(extraSnapshots)),
    })
  }
  entries.push({ name: INDEX_PATH, blob: json(index) })
  return writeArchive(entries.concat(imageEntries))
}
