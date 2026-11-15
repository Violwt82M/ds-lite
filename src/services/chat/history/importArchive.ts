import * as db from '../db.js'
import { BackupError, fail } from './errors.js'
import type { SessionIndexEntry } from './format.js'
import { INDEX_PATH, MANIFEST_PATH, USER_PATH, parseSessionPath, sessionFilesDir } from './paths.js'
import { checkManifest, readSessionFile, readSessionIndex } from './schema.js'
import { toLocalSession } from './toLocal.js'
import {
  ArchiveError,
  isZipFile,
  readArchive,
  readEntry,
  skipEntry,
  type ArchiveEntry,
  type EntryProgress,
} from './zipReader.js'

/** 从原件字节补充图片 MIME；无法识别时为空字符串，图片身份仍由归档的 is_image 决定。 */
const imageType = (bytes: Uint8Array): string => {
  const startsWith = (...prefix: number[]) => prefix.every((byte, index) => bytes[index] === byte)
  const header = new TextDecoder('ascii').decode(bytes.subarray(0, 12))
  if (startsWith(0xff, 0xd8, 0xff)) {
    return 'image/jpeg'
  }
  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    return 'image/png'
  }
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) {
    return 'image/gif'
  }
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') {
    return 'image/webp'
  }
  if (startsWith(0x42, 0x4d)) {
    return 'image/bmp'
  }
  if (startsWith(0x49, 0x49, 0x2a, 0) || startsWith(0x4d, 0x4d, 0, 0x2a)) {
    return 'image/tiff'
  }
  if (header.slice(4, 8) === 'ftyp' && ['avif', 'avis'].includes(header.slice(8, 12))) {
    return 'image/avif'
  }
  return ''
}

const readJson = async (entry: ArchiveEntry): Promise<unknown> => {
  const text = await (await readEntry(entry)).text()
  try {
    return JSON.parse(text)
  } catch {
    return fail('backupInvalidJson')
  }
}

/**
 * 检查 ZIP 格式、首个 manifest 条目及格式版本。
 * 校验失败时保留正在生成的回答和现有暂存数据。
 */
export const checkArchiveFormat = async (
  file: File,
  /** 解析中央目录时的进度回调；解析结果会缓存给导入阶段复用 */
  onDirectory?: (done: number, total: number) => void
): Promise<void> => {
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  try {
    for await (const entry of readArchive(file, { onDirectory })) {
      if (entry.path !== MANIFEST_PATH) {
        fail('backupUnrecognized')
      }
      checkManifest(await readJson(entry))
      return
    }
  } catch (error) {
    if (error instanceof ArchiveError) {
      throw new BackupError('backupIncomplete', 'ZIP 结构无法解析')
    }
    throw error
  }
  fail('backupUnrecognized')
}

/**
 * 流式导入：manifest → user（不导入）→ 全部会话 JSON → index → 全部图片。
 * 也支持会话与图片交错排列、index 位于末尾的条目顺序。
 * 会话读完立即暂存，只保留图片路径映射；图片全部读完后逐会话回填 MIME，不改变图片身份。
 * 写入导入暂存存储；调用方负责先清空暂存，成功后替换正式数据，失败时清理暂存。
 */
export type ImportArchiveOptions = {
  /** 逐条回调导入进度 */
  onEntry?: (progress: EntryProgress) => void
  /** 跳过附件本体（图片）：大归档里图片占绝大部分体积，跳过能快一个数量级 */
  skipImages?: boolean
  /** 只导入这些会话 id；缺省表示整包导入 */
  sessionIds?: string[]
  /** 本机已有的会话 id：这些会话连同附件一起跳过，本机版本保留不覆盖 */
  existingIds?: string[]
}

/** 条目属于哪个会话：会话 JSON 或它的附件目录 */
const sessionIdOfPath = (path: string): string | null => {
  const direct = parseSessionPath(path)
  if (direct !== null) {
    return direct
  }
  const match = /^chat_sessions\/([^/]+)_files\//.exec(path)
  return match?.[1] ?? null
}

export type ImportArchiveResult = {
  /** 实际写入暂存的会话数 */
  imported: number
  /** 因为本机已有而跳过的会话数 */
  skipped: number
}

export const importArchive = async (
  file: File,
  options: ImportArchiveOptions = {}
): Promise<ImportArchiveResult> => {
  const { onEntry, skipImages, sessionIds, existingIds } = options
  const wanted = sessionIds ? new Set(sessionIds) : null
  const existing = existingIds ? new Set(existingIds) : null
  const skippedSessions = new Set<string>()
  /** 未选中的会话连同它的附件一起跳过，读都不读 */
  const pathSelected = (path: string) => {
    const id = sessionIdOfPath(path)
    return id === null || wanted === null || wanted.has(id)
  }
  /** 本机已有的会话：连附件一起跳过，不覆盖本机版本 */
  const pathOwned = (path: string) => {
    const id = sessionIdOfPath(path)
    return id !== null && existing !== null && existing.has(id)
  }

  /** 真正要处理的条目：选中且本机没有的会话文字，以及（未勾选跳过时的）图片 */
  const pathWorked = (path: string) =>
    pathSelected(path) && !pathOwned(path) && (!skipImages || !path.includes('_files/'))
  if (!(await isZipFile(file))) {
    fail('backupUnrecognized')
  }
  const imported = new Set<string>()
  const images = new Map<string, string>()
  /** 已保存的原件：文件 ID → MIME。同一图片出现在多个会话目录时只保存一次。 */
  const stored = new Map<string, string>()
  let manifest = false
  let index: SessionIndexEntry[] | undefined
  let currentSessionId: string | undefined
  /** 当前正在处理的条目，出错时写进提示，方便定位是哪个文件导致了失败 */
  let currentPath = ''

  const saveImage = async (entry: ArchiveEntry, id: string) => {
    if (stored.has(id)) {
      await skipEntry(entry)
      return
    }
    const data = await readEntry(entry)
    const type = imageType(new Uint8Array(await data.slice(0, 16).arrayBuffer()))
    await db.saveStagingFiles([{ id, blob: new Blob([data], { type }) }])
    stored.set(id, type)
  }

  try {
    for await (const entry of readArchive(file, {
      onEntry,
      // 大图片/大附件内部也汇报进度，别让进度条看着像卡死
      onEntryProgress: onEntry,
      // 未选中的会话、以及要跳过的图片条目：不读盘、不解压，只保留元数据
      consume: pathWorked,
      // 进度只按要处理的条目算：只导入一个会话时不该显示整包 1800 项
      count: pathWorked,
    })) {
      const { path } = entry
      currentPath = path
      if (!pathSelected(path)) {
        continue
      }
      // 本机已有的会话：整条跳过（附件也不读），保留下本机版本
      if (pathOwned(path)) {
        const ownedId = sessionIdOfPath(path)
        if (ownedId !== null) {
          skippedSessions.add(ownedId)
        }
        continue
      }
      const sessionId = parseSessionPath(path)
      if (!manifest) {
        if (path !== MANIFEST_PATH) {
          fail('backupUnrecognized')
        }
        checkManifest(await readJson(entry))
        manifest = true
      } else if (path === USER_PATH && !index && imported.size === 0) {
        // 账号信息（已脱敏）不导入；文件可能缺失。
        await skipEntry(entry)
      } else if (sessionId !== null && !index) {
        const local = toLocalSession(readSessionFile(await readJson(entry)))
        if (local.session.id !== sessionId || imported.has(sessionId)) {
          fail('backupIncomplete')
        }
        imported.add(sessionId)
        currentSessionId = sessionId
        for (const [imagePath, id] of local.images) {
          images.set(imagePath, id)
        }
        await db.addStagingSession(local.session)
      } else if (path === INDEX_PATH && !index) {
        index = readSessionIndex(await readJson(entry))
      } else if (
        index
          ? imported.has(/^chat_sessions\/([^/]+)_files\//.exec(path)?.[1] ?? '')
          : currentSessionId && path.startsWith(sessionFilesDir(currentSessionId))
      ) {
        // 没有被引用的条目不保存，引用了但缺失的图片只展示文件名。
        const id = images.get(path)
        if (skipImages) {
          // 主动跳过附件：只保留文件名，不写入本机存储
          continue
        }
        await (id === undefined ? skipEntry(entry) : saveImage(entry, id))
      } else {
        fail('backupIncomplete')
      }
    }
  } catch (error) {
    const detail = currentPath === '' ? undefined : `ZIP 条目 ${currentPath}`
    if (error instanceof ArchiveError) {
      throw new BackupError('backupIncomplete', detail)
    }
    if (error instanceof BackupError) {
      throw new BackupError(error.key, error.detail ?? detail)
    }
    throw error
  }
  if (!manifest) {
    fail('backupUnrecognized')
  }
  // 清单只保留真正写出的会话：既筛掉未选中的，也筛掉因为本机已有而跳过的
  if (index) {
    index = index.filter((entry) => imported.has(entry.id))
  }
  // index 只列出成功写出的会话，与会话文件一一对应。
  const listed = new Set(index?.map((entry) => entry.id))
  if (
    !index ||
    listed.size !== index.length ||
    listed.size !== imported.size ||
    [...imported].some((id) => !listed.has(id))
  ) {
    fail('backupIncomplete')
  }
  await db.updateStagingFileTypes(stored)
  return { imported: imported.size, skipped: skippedSessions.size }
}
