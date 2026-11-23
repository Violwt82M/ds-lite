import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { cleanSessionText } from './clean.js'
import type { SessionSearchDocs, StoredFile } from './db.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

const ROOT = 'ds-lite'
const SESSIONS_DIR = `${ROOT}/sessions`
const FILES_DIR = `${ROOT}/files`
const SEARCH_DIR = `${ROOT}/search`
const STAGING_SESSIONS_DIR = `${ROOT}/staging/sessions`
const STAGING_FILES_DIR = `${ROOT}/staging/files`
const SUMMARIES_PATH = `${ROOT}/summaries.json`
const SUMMARIES_BACKUP_PATH = `${SUMMARIES_PATH}.bak`
const TOMBSTONES_PATH = `${ROOT}/tombstones.json`
const META_PATH = `${ROOT}/meta.json`

type StoredSessionSummary = SessionSummary & { fileIds: string[] }
type SummaryMap = Record<string, StoredSessionSummary>

type NativeMeta = {
  version: number
  migratedFromIdb: boolean
  /** 迁移统计：只用于诊断，缺省表示老版本写的 meta */
  migration?: {
    finishedAt: number
    idbSessionCount: number
    written: number
    missing: number
    failed: number
    sourceReadable: boolean
  }
}

/** 已删除会话的墓碑：对账/补迁时据此跳过，避免把用户删掉的会话复活。 */
type NativeTombstones = {
  v: 1
  ids: Record<string, number>
  /** 最近一次「清空全部」的时间，仅用于诊断 */
  clearedAt?: number
}

export type IdbMigrationSource = {
  /** 同时枚举 sessions 与 sessionSummaries 的 key（不依赖摘要是否完整） */
  loadSessionIds: () => Promise<string[]>
  loadSession: (id: string) => Promise<Session | undefined>
  loadFile: (id: string) => Promise<Blob | undefined>
  loadAllSearchDocs: () => Promise<SessionSearchDocs[]>
}

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      session.messages.flatMap((message) =>
        message.role === 'user' && Array.isArray(message.files)
          ? message.files.map((file) => file.id)
          : []
      )
    ),
  ],
})

const ensureDir = async (path: string): Promise<void> => {
  try {
    await Filesystem.mkdir({ path, directory: Directory.Data, recursive: true })
  } catch {
    // 目录已存在时部分平台会抛错，忽略即可
  }
}

const deleteFileSafe = async (path: string): Promise<void> => {
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Data })
  } catch {
    // 文件不存在时忽略
  }
}

/** Capacitor 各平台对「文件不存在」的报错文案不完全一致，统一按关键字识别。 */
const isMissingError = (error: unknown): boolean => {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : ''
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return (
    name === 'NotFoundError' ||
    /does not exist|not found|no such file|enoent/i.test(`${name} ${message}`)
  )
}

/** 只判断存在性：不确定时按「存在」处理，宁可跳过写入也不误覆盖原生数据。 */
const fileExists = async (path: string): Promise<boolean> => {
  try {
    const info = await Filesystem.stat({ path, directory: Directory.Data })
    return info.type !== 'directory'
  } catch (error) {
    return !isMissingError(error)
  }
}

/** 每次写入用独立临时名：并发写同一个目标时不会互相覆盖 .tmp / 抢 rename。 */
let tmpSequence = 0

const writeTextAtomic = async (path: string, text: string): Promise<void> => {
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (dir) {
    await ensureDir(dir)
  }
  tmpSequence += 1
  const tmp = `${path}.${tmpSequence}.tmp`
  try {
    await Filesystem.writeFile({
      path: tmp,
      data: text,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
      recursive: true,
    })
    await Filesystem.rename({
      from: tmp,
      to: path,
      directory: Directory.Data,
      toDirectory: Directory.Data,
    })
  } catch (error) {
    await deleteFileSafe(tmp)
    throw error
  }
}

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> =>
  writeTextAtomic(path, JSON.stringify(value))

const writeBlobFile = async (path: string, blob: Blob): Promise<void> => {
  const b64 = await blobToBase64(blob)
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (dir) {
    await ensureDir(dir)
  }
  await Filesystem.writeFile({
    path,
    data: b64,
    directory: Directory.Data,
    recursive: true,
  })
}

/** 读文本：文件不存在返回 {ok:true}（无 text）；存在但读失败/非字符串返回 {ok:false}。 */
const readText = async (path: string): Promise<{ ok: true; text?: string } | { ok: false }> => {
  try {
    const res = await Filesystem.readFile({
      path,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    })
    return typeof res.data === 'string' ? { ok: true, text: res.data } : { ok: false }
  } catch (error) {
    if (isMissingError(error)) {
      return { ok: true }
    }
    // 原因不明确时用 stat 再确认一次；仍不确定就按「存在但读失败」处理，拒绝覆盖
    try {
      await Filesystem.stat({ path, directory: Directory.Data })
      return { ok: false }
    } catch (statError) {
      return isMissingError(statError) ? { ok: true } : { ok: false }
    }
  }
}

/** 宽松读：会话文件/搜索索引/暂存/迁移用，坏数据一律当没有。 */
const readJson = async <T>(path: string): Promise<T | undefined> => {
  const res = await readText(path)
  if (!res.ok || res.text === undefined) {
    return undefined
  }
  try {
    return JSON.parse(res.text) as T
  } catch {
    return undefined
  }
}

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'))
    reader.readAsDataURL(blob)
  })

const base64ToBlob = (base64: string, mimeType = ''): Blob => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], mimeType ? { type: mimeType } : undefined)
}

/* ---------------- 索引（summaries.json + tombstones.json） ---------------- */

type SummariesRead =
  | { ok: true; map: SummaryMap; existed: boolean }
  | { ok: false }

type TombstonesRead = { ok: true; value: NativeTombstones } | { ok: false }

let summariesCache: SummaryMap | null = null
let tombstonesCache: NativeTombstones | null = null
/** 索引与墓碑的写入共用一条串行队列：彻底消除跨会话并发 read-modify-write 丢更新。 */
let indexQueue: Promise<unknown> = Promise.resolve()

const withIndex = <T>(run: () => Promise<T>): Promise<T> => {
  const task = indexQueue.then(run, run)
  indexQueue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

const isStoredSummary = (value: unknown): value is StoredSessionSummary => {
  if (value === null || typeof value !== 'object') {
    return false
  }
  const item = value as Partial<StoredSessionSummary>
  return (
    typeof item.id === 'string' &&
    typeof item.title === 'string' &&
    typeof item.createdAt === 'number' &&
    typeof item.updatedAt === 'number'
  )
}

/** 解析索引 JSON：可解析但结构不合法时丢弃坏条目（缺的会话由目录自愈补回），整体不是对象则视为损坏。 */
const parseSummaryMap = (text: string | undefined): SummaryMap | null => {
  if (text === undefined) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const map: SummaryMap = {}
  for (const value of Object.values(parsed)) {
    if (!isStoredSummary(value)) {
      continue
    }
    map[value.id] = {
      ...value,
      fileIds: Array.isArray(value.fileIds)
        ? value.fileIds.filter((id): id is string => typeof id === 'string')
        : [],
    }
  }
  return map
}

/** 读一个索引文件：不存在 → 空表；损坏/读失败 → map=null（调用方决定回退或拒绝覆盖）。 */
const readSummaryFile = async (
  path: string
): Promise<{ exists: boolean; map: SummaryMap | null }> => {
  const res = await readText(path)
  if (!res.ok) {
    return { exists: true, map: null }
  }
  if (res.text === undefined) {
    return { exists: false, map: {} }
  }
  return { exists: true, map: parseSummaryMap(res.text) }
}

/**
 * 严格读索引：
 * - 主文件不存在 → 空表（正常新装）；
 * - 主文件损坏/读失败 → 先试 `.bak`，成功则用备份恢复主文件；
 * - 备份也不可用 → `{ok:false}`，调用方**绝不能**用 `{}` 覆盖。
 */
const loadSummariesUncached = async (): Promise<SummariesRead> => {
  const primary = await readSummaryFile(SUMMARIES_PATH)
  if (primary.map !== null) {
    summariesCache = primary.map
    return { ok: true, map: primary.map, existed: primary.exists }
  }
  const backup = await readSummaryFile(SUMMARIES_BACKUP_PATH)
  if (backup.map !== null && backup.exists) {
    summariesCache = backup.map
    // 从备份恢复主文件：不能再写一次备份，否则会用坏主文件覆盖好备份。
    await writeTextAtomic(SUMMARIES_PATH, JSON.stringify(backup.map))
    return { ok: true, map: backup.map, existed: true }
  }
  return { ok: false }
}

const ensureSummaries = async (): Promise<SummariesRead> =>
  summariesCache !== null
    ? { ok: true, map: summariesCache, existed: true }
    : loadSummariesUncached()

/** 严格读索引，读失败返回 `{ok:false}`（绝不伪造成 `{}`）。 */
export const readSummariesMapStrict = (): Promise<SummariesRead> => withIndex(ensureSummaries)

/** 写索引前先把「可解析的旧主文件」留一份 `.bak`，坏文件不会冲掉好备份。 */
const writeSummariesWithBackup = async (map: SummaryMap): Promise<void> => {
  const current = await readSummaryFile(SUMMARIES_PATH)
  if (current.exists && current.map !== null) {
    await writeTextAtomic(SUMMARIES_BACKUP_PATH, JSON.stringify(current.map))
  }
  await writeTextAtomic(SUMMARIES_PATH, JSON.stringify(map))
}

/** 在串行队列里改一整张索引：读 → 改 → 写，任何时刻只有一个写者。 */
const updateSummaries = <T>(mutate: (map: SummaryMap) => T): Promise<T> =>
  withIndex(async () => {
    const read = await ensureSummaries()
    if (!read.ok) {
      throw new Error('summaries.json is unreadable; refusing to overwrite the index')
    }
    const map: SummaryMap = { ...read.map }
    const result = mutate(map)
    summariesCache = map
    await writeSummariesWithBackup(map)
    return result
  })

/** 索引整体替换：只用于「从备份恢复失败后，用 sessions/ 目录重建」和清空全部。 */
const replaceSummaries = (map: SummaryMap): Promise<void> =>
  withIndex(async () => {
    summariesCache = map
    await writeSummariesWithBackup(map)
  })

/** 删除一条索引并返回被删项/剩余引用：用重建对象代替动态 delete（V8 快属性）。 */
const removeSummary = (
  id: string
): Promise<{ target?: StoredSessionSummary; stillReferenced: Set<string> }> =>
  withIndex(async () => {
    const read = await ensureSummaries()
    if (!read.ok) {
      throw new Error('summaries.json is unreadable; refusing to overwrite the index')
    }
    const target = read.map[id]
    const next: SummaryMap = {}
    const stillReferenced = new Set<string>()
    for (const [key, item] of Object.entries(read.map)) {
      if (key === id) {
        continue
      }
      next[key] = item
      for (const fid of item.fileIds ?? []) {
        stillReferenced.add(fid)
      }
    }
    summariesCache = next
    await writeSummariesWithBackup(next)
    return { target, stillReferenced }
  })

const loadTombstonesUncached = async (): Promise<TombstonesRead> => {
  const res = await readText(TOMBSTONES_PATH)
  if (!res.ok) {
    return { ok: false }
  }
  if (res.text === undefined) {
    tombstonesCache = { v: 1, ids: {} }
    return { ok: true, value: tombstonesCache }
  }
  try {
    const parsed = JSON.parse(res.text) as Partial<NativeTombstones>
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.ids !== 'object' || parsed.ids === null) {
      return { ok: false }
    }
    tombstonesCache = {
      v: 1,
      ids: parsed.ids as Record<string, number>,
      ...(typeof parsed.clearedAt === 'number' ? { clearedAt: parsed.clearedAt } : {}),
    }
    return { ok: true, value: tombstonesCache }
  } catch {
    return { ok: false }
  }
}

const ensureTombstones = async (): Promise<TombstonesRead> =>
  tombstonesCache !== null ? { ok: true, value: tombstonesCache } : loadTombstonesUncached()

const readTombstonesStrict = (): Promise<TombstonesRead> => withIndex(ensureTombstones)

/** 记墓碑：写失败会抛错，调用方据此中止删除（宁可删失败，不可复活）。 */
const recordTombstones = (ids: Iterable<string>, clearedAt?: number): Promise<void> =>
  withIndex(async () => {
    const read = await ensureTombstones()
    if (!read.ok) {
      throw new Error('tombstones.json is unreadable; refusing to delete without a tombstone')
    }
    const now = Date.now()
    const next: NativeTombstones = { v: 1, ids: { ...read.value.ids } }
    if (read.value.clearedAt !== undefined) {
      next.clearedAt = read.value.clearedAt
    }
    let changed = false
    for (const id of ids) {
      if (id) {
        next.ids[id] = now
        changed = true
      }
    }
    if (clearedAt !== undefined) {
      next.clearedAt = Math.max(next.clearedAt ?? 0, clearedAt)
      changed = true
    }
    if (!changed) {
      return
    }
    tombstonesCache = next
    await writeJsonAtomic(TOMBSTONES_PATH, next)
  })

/** 清空全部前，把「原生列表里的 id + 旧 IDB 里全部 id」都记成墓碑。 */
const recordClearAllTombstones = async (source: IdbMigrationSource): Promise<void> => {
  let idbIds: string[] = []
  try {
    idbIds = await source.loadSessionIds()
  } catch {
    // IDB 不可用（被系统清理/打不开）：只墓碑原生已有的 id
  }
  const ids = new Set(idbIds)
  const read = await readSummariesMapStrict()
  if (read.ok) {
    for (const id of Object.keys(read.map)) {
      ids.add(id)
    }
  }
  await recordTombstones(ids, Date.now())
}

/* ---------------- 旧 IDB → 原生迁移 / 对账 ---------------- */

let migrationPromise: Promise<void> | null = null

/**
 * 首次迁移：只补原生磁盘里没有的会话，绝不覆盖原生已有数据。
 * 全部成功才写 `migratedFromIdb:true`；有读失败则下次启动重试，避免 R1（漏迁却已写标记）。
 */
export const ensureNativeMigrated = (source: IdbMigrationSource): Promise<void> => {
  if (migrationPromise) {
    return migrationPromise
  }
  migrationPromise = (async () => {
    const meta = await readJson<NativeMeta>(META_PATH)
    if (meta?.migratedFromIdb) {
      return
    }
    await ensureDir(SESSIONS_DIR)
    await ensureDir(FILES_DIR)
    await ensureDir(SEARCH_DIR)

    let ids: string[] = []
    let sourceReadable = true
    try {
      ids = await source.loadSessionIds()
    } catch {
      // WebView 的 IndexedDB 可能已被系统清理：不能让迁移失败拖垮整个原生存储
      sourceReadable = false
    }

    const tombs = await readTombstonesStrict()
    const migrated: SummaryMap = {}
    const fileIds = new Set<string>()
    let missing = 0
    let failed = 0

    for (const id of ids) {
      if (tombs.ok && tombs.value.ids[id]) {
        continue
      }
      // 原生已经有这条会话：无论新旧，一律不覆盖
      if (await fileExists(`${SESSIONS_DIR}/${id}.json`)) {
        continue
      }
      let session: Session | undefined
      try {
        session = await source.loadSession(id)
      } catch {
        failed += 1
        continue
      }
      if (!session) {
        // IDB 只有摘要、没有正文：源里本来就没有，记录后不再阻塞标记
        missing += 1
        continue
      }
      if (session.id !== id) {
        // key 与正文 id 不一致：不写，避免污染别的会话
        failed += 1
        continue
      }
      let cleaned: Session
      try {
        cleaned = cleanSessionText(session)
      } catch {
        failed += 1
        continue
      }
      await writeJsonAtomic(`${SESSIONS_DIR}/${id}.json`, cleaned)
      const summary = storedSummary(cleaned)
      migrated[id] = summary
      for (const fid of summary.fileIds) {
        fileIds.add(fid)
      }
    }

    for (const fid of fileIds) {
      if (await fileExists(`${FILES_DIR}/${fid}`)) {
        continue
      }
      let blob: Blob | undefined
      try {
        blob = await source.loadFile(fid)
      } catch {
        continue
      }
      if (!blob) {
        continue
      }
      await writeBlobFile(`${FILES_DIR}/${fid}`, blob)
      if (blob.type) {
        await writeJsonAtomic(`${FILES_DIR}/${fid}.mime`, blob.type)
      }
    }

    try {
      const searchDocs = await source.loadAllSearchDocs()
      for (const doc of searchDocs) {
        if (await fileExists(`${SEARCH_DIR}/${doc.id}.json`)) {
          continue
        }
        await writeJsonAtomic(`${SEARCH_DIR}/${doc.id}.json`, doc)
      }
    } catch {
      // 搜索索引可以按会话重建，不阻塞迁移
    }

    if (Object.keys(migrated).length > 0) {
      await updateSummaries((map) => {
        for (const [id, summary] of Object.entries(migrated)) {
          if (!map[id]) {
            map[id] = summary
          }
        }
      })
    }

    await writeJsonAtomic(META_PATH, {
      version: 2,
      migratedFromIdb: sourceReadable && failed === 0,
      migration: {
        finishedAt: Date.now(),
        idbSessionCount: ids.length,
        written: Object.keys(migrated).length,
        missing,
        failed,
        sourceReadable,
      },
    } satisfies NativeMeta)
  })().catch((error: unknown) => {
    migrationPromise = null
    throw error
  })
  return migrationPromise
}

const listSessionFiles = async (): Promise<{ name: string }[]> => {
  try {
    const dir = await Filesystem.readdir({ path: SESSIONS_DIR, directory: Directory.Data })
    return dir.files.filter(
      (entry) => entry.type !== 'directory' && entry.name.endsWith('.json')
    )
  } catch {
    // 目录不存在/读失败：没有可扫描的会话
    return []
  }
}

const readSessionFileFromDisk = async (name: string, id: string): Promise<Session | undefined> => {
  const session = await readJson<Session>(`${SESSIONS_DIR}/${name}`)
  if (!session || session.id !== id || !Array.isArray(session.messages)) {
    return undefined
  }
  try {
    return cleanSessionText(session)
  } catch {
    return undefined
  }
}

let repairPromise: Promise<void> | null = null

/**
 * 启动索引自愈：扫描 `sessions/`，把不在 `summaries.json` 里的会话补回索引（不覆盖已有项）。
 * - 主索引可读：只补缺口，正常启动只做一次 readdir + 集合比较；
 * - 主索引损坏且备份也不可用：用目录里能解析的会话整体重建，救回列表。
 * 幂等，可重复调用；并发调用复用同一个 Promise。
 */
export const nativeRepairIndexFromDir = (): Promise<void> => {
  if (repairPromise) {
    return repairPromise
  }
  repairPromise = (async () => {
    const files = await listSessionFiles()
    if (files.length === 0) {
      return
    }
    const read = await readSummariesMapStrict()
    const known = read.ok ? read.map : {}
    const targets = read.ok
      ? files.filter((entry) => !known[entry.name.slice(0, -'.json'.length)])
      : files
    if (read.ok && targets.length === 0) {
      return
    }

    const repaired: SummaryMap = {}
    for (const entry of targets) {
      const id = entry.name.slice(0, -'.json'.length)
      if (known[id]) {
        continue
      }
      const session = await readSessionFileFromDisk(entry.name, id)
      if (!session) {
        // 单个坏文件跳过，不阻塞其它会话恢复
        continue
      }
      repaired[id] = storedSummary(session)
    }

    if (read.ok) {
      if (Object.keys(repaired).length === 0) {
        return
      }
      await updateSummaries((map) => {
        for (const [id, summary] of Object.entries(repaired)) {
          if (!map[id]) {
            map[id] = summary
          }
        }
      })
      return
    }

    // 索引主/备都坏了：目录里的会话就是唯一真相，整体重建。
    // 一个都读不出来时保留原损坏文件（不拿 {} 覆盖），让上层显示「加载失败」并留待人工恢复。
    if (Object.keys(repaired).length === 0) {
      return
    }
    await replaceSummaries(repaired)
  })().finally(() => {
    repairPromise = null
  })
  return repairPromise
}

let repairAttempted = false

/**
 * 幂等补迁：只补「原生磁盘没有、且不在墓碑里」的旧 IDB 会话（连同引用的附件）。
 * 安全可随时调用；返回补回的会话数。
 */
export const reconcileMissingFromIdb = async (source: IdbMigrationSource): Promise<number> => {
  await ensureNativeMigrated(source)
  const tombs = await readTombstonesStrict()
  if (!tombs.ok) {
    return 0
  }
  let ids: string[] = []
  try {
    ids = await source.loadSessionIds()
  } catch {
    return 0
  }
  const read = await readSummariesMapStrict()
  if (!read.ok) {
    return 0
  }

  const missing: string[] = []
  for (const id of ids) {
    if (tombs.value.ids[id]) {
      continue
    }
    if (await fileExists(`${SESSIONS_DIR}/${id}.json`)) {
      continue
    }
    missing.push(id)
  }
  if (missing.length === 0) {
    return 0
  }

  const restored: SummaryMap = {}
  const fileIds = new Set<string>()
  for (const id of missing) {
    let session: Session | undefined
    try {
      session = await source.loadSession(id)
    } catch {
      continue
    }
    if (!session || session.id !== id) {
      continue
    }
    let cleaned: Session
    try {
      cleaned = cleanSessionText(session)
    } catch {
      continue
    }
    await writeJsonAtomic(`${SESSIONS_DIR}/${id}.json`, cleaned)
    const summary = storedSummary(cleaned)
    restored[id] = summary
    for (const fid of summary.fileIds) {
      fileIds.add(fid)
    }
  }
  if (Object.keys(restored).length === 0) {
    return 0
  }

  for (const fid of fileIds) {
    if (await fileExists(`${FILES_DIR}/${fid}`)) {
      continue
    }
    let blob: Blob | undefined
    try {
      blob = await source.loadFile(fid)
    } catch {
      continue
    }
    if (!blob) {
      continue
    }
    await writeBlobFile(`${FILES_DIR}/${fid}`, blob)
    if (blob.type) {
      await writeJsonAtomic(`${FILES_DIR}/${fid}.mime`, blob.type)
    }
  }

  await updateSummaries((map) => {
    for (const [id, summary] of Object.entries(restored)) {
      if (!map[id]) {
        map[id] = summary
      }
    }
  })
  return Object.keys(restored).length
}

/* ---------------- 会话/列表 ---------------- */

export const nativeLoadSessionSummaries = async (
  source: IdbMigrationSource
): Promise<SessionSummary[]> => {
  await ensureNativeMigrated(source)
  if (!repairAttempted) {
    try {
      await nativeRepairIndexFromDir()
      repairAttempted = true
    } catch {
      // 自愈写入失败：保留 false，用户点「重试」/下次加载再试，不阻塞已有索引
    }
  }
  const read = await readSummariesMapStrict()
  if (!read.ok) {
    // 不用空列表掩盖损坏：让调用方显示「加载失败/重试」，避免下一次保存覆盖索引
    throw new Error('summaries.json is unreadable')
  }
  return Object.values(read.map).map(toSessionSummary)
}

export const nativeLoadSession = async (
  id: string,
  source: IdbMigrationSource
): Promise<Session | undefined> => {
  await ensureNativeMigrated(source)
  const native = await readJson<Session>(`${SESSIONS_DIR}/${id}.json`)
  if (native) {
    return native
  }
  // 原生文件缺失/损坏：只读回退旧 IDB（绝不写穿），成功返回后由上层 persist 自愈
  const tombs = await readTombstonesStrict()
  if (!tombs.ok || tombs.value.ids[id]) {
    return undefined
  }
  try {
    return await source.loadSession(id)
  } catch {
    return undefined
  }
}

export const nativeSaveSessionRecord = async (
  session: Session,
  source: IdbMigrationSource
): Promise<void> => {
  await ensureNativeMigrated(source)
  const cleaned = cleanSessionText(session)
  const summary = storedSummary(cleaned)
  await writeJsonAtomic(`${SESSIONS_DIR}/${cleaned.id}.json`, cleaned)
  await updateSummaries((map) => {
    map[cleaned.id] = summary
  })
}

export const nativeLoadAllSearchDocs = async (
  source: IdbMigrationSource
): Promise<SessionSearchDocs[]> => {
  await ensureNativeMigrated(source)
  try {
    const dir = await Filesystem.readdir({ path: SEARCH_DIR, directory: Directory.Data })
    const docs: SessionSearchDocs[] = []
    for (const entry of dir.files) {
      if (!entry.name.endsWith('.json')) {
        continue
      }
      const doc = await readJson<SessionSearchDocs>(`${SEARCH_DIR}/${entry.name}`)
      if (doc) {
        docs.push(doc)
      }
    }
    return docs
  } catch {
    return []
  }
}

export const nativeSaveSearchDocs = async (
  docs: SessionSearchDocs,
  source: IdbMigrationSource
): Promise<void> => {
  await ensureNativeMigrated(source)
  await writeJsonAtomic(`${SEARCH_DIR}/${docs.id}.json`, docs)
}

export const nativeRenameSession = async (
  id: string,
  title: string,
  source: IdbMigrationSource
): Promise<void> => {
  await ensureNativeMigrated(source)
  const session = await readJson<Session>(`${SESSIONS_DIR}/${id}.json`)
  if (!session) {
    return
  }
  session.title = title
  await writeJsonAtomic(`${SESSIONS_DIR}/${id}.json`, session)
  await updateSummaries((map) => {
    map[id] = storedSummary(session)
  })
}

export const nativeDeleteSession = async (
  sessionId: string,
  source: IdbMigrationSource
): Promise<void> => {
  await ensureNativeMigrated(source)
  // 先墓碑、再删索引/文件：任何一步失败都不会让补迁把会话复活
  await recordTombstones([sessionId])
  const { target, stillReferenced } = await removeSummary(sessionId)
  await deleteFileSafe(`${SESSIONS_DIR}/${sessionId}.json`)
  await deleteFileSafe(`${SEARCH_DIR}/${sessionId}.json`)

  if (!target?.fileIds?.length) {
    return
  }
  for (const fid of target.fileIds) {
    if (!stillReferenced.has(fid)) {
      await deleteFileSafe(`${FILES_DIR}/${fid}`)
      await deleteFileSafe(`${FILES_DIR}/${fid}.mime`)
    }
  }
}

/** 清空全部会话/附件/索引（会先给全部旧 id 记墓碑，避免被补迁复活）。 */
export const nativeClearAll = async (source: IdbMigrationSource): Promise<void> => {
  await ensureNativeMigrated(source)
  await recordClearAllTombstones(source)
  for (const dir of [SESSIONS_DIR, FILES_DIR, SEARCH_DIR]) {
    await clearDir(dir)
    await ensureDir(dir)
  }
  await replaceSummaries({})
  await nativeClearStaging()
}

/* ---------------- 附件原件 ---------------- */

const putNativeFiles = async (dir: string, files: StoredFile[]): Promise<void> => {
  await ensureDir(dir)
  for (const file of files) {
    await writeBlobFile(`${dir}/${file.id}`, file.blob)
    if (file.blob.type) {
      await writeJsonAtomic(`${dir}/${file.id}.mime`, file.blob.type)
    }
  }
}

export const nativeSaveSessionFiles = async (
  files: StoredFile[],
  source: IdbMigrationSource
): Promise<void> => {
  await ensureNativeMigrated(source)
  await putNativeFiles(FILES_DIR, files)
}

export const nativeLoadFile = async (
  id: string,
  source: IdbMigrationSource
): Promise<Blob | undefined> => {
  await ensureNativeMigrated(source)
  try {
    const res = await Filesystem.readFile({
      path: `${FILES_DIR}/${id}`,
      directory: Directory.Data,
    })
    if (typeof res.data !== 'string') {
      return undefined
    }
    const mime = (await readJson<string>(`${FILES_DIR}/${id}.mime`)) ?? ''
    return base64ToBlob(res.data, mime)
  } catch {
    return undefined
  }
}

/* ---------------- 导入暂存 ---------------- */

const clearDir = async (path: string): Promise<void> => {
  try {
    await Filesystem.rmdir({ path, directory: Directory.Data, recursive: true })
  } catch {
    // 目录不存在时忽略
  }
}

export const nativeClearStaging = async (): Promise<void> => {
  await clearDir(STAGING_SESSIONS_DIR)
  await clearDir(STAGING_FILES_DIR)
}

export const nativeAddStagingSession = async (session: Session): Promise<void> => {
  await ensureDir(STAGING_SESSIONS_DIR)
  await writeJsonAtomic(`${STAGING_SESSIONS_DIR}/${session.id}.json`, session)
}

export const nativeSaveStagingFiles = async (files: StoredFile[]): Promise<void> => {
  await putNativeFiles(STAGING_FILES_DIR, files)
}

export const nativeUpdateStagingFileTypes = async (
  types: ReadonlyMap<string, string>
): Promise<void> => {
  try {
    const dir = await Filesystem.readdir({ path: STAGING_SESSIONS_DIR, directory: Directory.Data })
    for (const entry of dir.files) {
      if (!entry.name.endsWith('.json')) {
        continue
      }
      const path = `${STAGING_SESSIONS_DIR}/${entry.name}`
      const session = await readJson<Session>(path)
      if (!session) {
        continue
      }
      let changed = false
      for (const message of session.messages) {
        if (message.role !== 'user') {
          continue
        }
        for (const file of message.files) {
          const type = types.get(file.id) ?? ''
          if (file.mimeType !== type) {
            file.mimeType = type
            changed = true
          }
        }
      }
      if (changed) {
        await writeJsonAtomic(path, session)
      }
    }
  } catch {
    // 暂存目录为空时忽略
  }
}

export const nativeCommitStaging = async (
  options: { merge?: boolean } = {},
  source: IdbMigrationSource
): Promise<SessionSummary[]> => {
  await ensureNativeMigrated(source)
  const { merge = false } = options
  const summaries: SessionSummary[] = []
  const staged: SummaryMap = {}

  if (!merge) {
    // 替换/清空：先记全部旧 id 的墓碑，再清目录与索引
    await recordClearAllTombstones(source)
    for (const dir of [SESSIONS_DIR, FILES_DIR, SEARCH_DIR]) {
      await clearDir(dir)
      await ensureDir(dir)
    }
    await replaceSummaries({})
  }

  try {
    const sessionDir = await Filesystem.readdir({
      path: STAGING_SESSIONS_DIR,
      directory: Directory.Data,
    })
    for (const entry of sessionDir.files) {
      if (!entry.name.endsWith('.json')) {
        continue
      }
      const session = await readJson<Session>(`${STAGING_SESSIONS_DIR}/${entry.name}`)
      if (!session) {
        continue
      }
      await writeJsonAtomic(`${SESSIONS_DIR}/${session.id}.json`, session)
      const summary = storedSummary(session)
      staged[session.id] = summary
      summaries.push(toSessionSummary(summary))
    }
  } catch {
    // 无暂存会话
  }

  try {
    const fileDir = await Filesystem.readdir({
      path: STAGING_FILES_DIR,
      directory: Directory.Data,
    })
    for (const entry of fileDir.files) {
      await Filesystem.rename({
        from: `${STAGING_FILES_DIR}/${entry.name}`,
        to: `${FILES_DIR}/${entry.name}`,
        directory: Directory.Data,
        toDirectory: Directory.Data,
      })
    }
  } catch {
    // 无暂存附件
  }

  if (Object.keys(staged).length > 0) {
    // !merge 时索引已在上面清空；这里只合并本次写入的会话
    await updateSummaries((map) => {
      for (const [id, summary] of Object.entries(staged)) {
        map[id] = summary
      }
    })
  }

  await nativeClearStaging()
  return summaries
}
