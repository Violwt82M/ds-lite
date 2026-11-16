import { BackupError, fail } from './errors.js'
import { INDEX_PATH, MANIFEST_PATH } from './paths.js'
import { checkManifest, readSessionIndex } from './schema.js'
import { ArchiveError, isZipFile, readArchiveEntry } from './zipReader.js'
import { findArchivePrefix, withPrefix } from './archivePrefix.js'

/** 导入选择列表里的一条会话 */
export type ImportSessionOption = {
  id: string
  title: string
  messageCount: number
  /** 毫秒时间戳；解析不出来时为 0 */
  updatedAt: number
}

const parseJson = async (blob: Blob): Promise<unknown> => {
  const text = await blob.text()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/**
 * 只读归档里的清单（manifest + chat_session_index.json），用于导入前让用户挑对话。
 * 清单在归档末尾，但中央目录已解析并缓存，随机读这两个小条目很快。
 */
export const readImportSessions = async (file: File): Promise<ImportSessionOption[]> => {
  try {
    if (!(await isZipFile(file))) {
      fail('backupNotZip')
    }
    // 解压后重新压缩的包会多一层文件夹，先认出这一层
    const prefix = await findArchivePrefix(file)
    const manifest = await readArchiveEntry(file, withPrefix(prefix, MANIFEST_PATH))
    if (!manifest) {
      throw new BackupError('backupNoManifest')
    }
    checkManifest(await parseJson(manifest))
    const indexBlob = await readArchiveEntry(file, withPrefix(prefix, INDEX_PATH))
    if (!indexBlob) {
      throw new BackupError('backupIncomplete')
    }
    return readSessionIndex(await parseJson(indexBlob)).map((entry) => ({
      id: entry.id,
      title: entry.title ?? '',
      messageCount: entry.message_count,
      updatedAt: Date.parse(entry.updated_at) || 0,
    }))
  } catch (error) {
    if (error instanceof ArchiveError) {
      throw new BackupError('backupUnrecognized')
    }
    throw error
  }
}
