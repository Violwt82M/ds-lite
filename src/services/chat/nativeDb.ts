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
const META_PATH = `${ROOT}/meta.json`

type StoredSessionSummary = SessionSummary & { fileIds: string[] }

type NativeMeta = {
  version: number
  migratedFromIdb: boolean
}

export type IdbMigrationSource = {
  loadSessionSummaries: () => Promise<SessionSummary[]>
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

const readJson = async <T>(path: string): Promise<T | undefined> => {
  try {
    const res = await Filesystem.readFile({
      path,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    })
    if (typeof res.data !== 'string') {
      return undefined
    }
    return JSON.parse(res.data) as T
  } catch {
    return undefined
  }
}

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (dir) {
    await ensureDir(dir)
  }
  const tmp = `${path}.tmp`
  await Filesystem.writeFile({
    path: tmp,
    data: JSON.stringify(value),
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
}

const deleteFileSafe = async (path: string): Promise<void> => {
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Data })
  } catch {
    // 文件不存在时忽略
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

const readSummariesMap = async (): Promise<Record<string, StoredSessionSummary>> =>
  (await readJson<Record<string, StoredSessionSummary>>(SUMMARIES_PATH)) ?? {}

let migrationPromise: Promise<void> | null = null

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

    const summaries = await source.loadSessionSummaries()
    const summaryMap: Record<string, StoredSessionSummary> = {}
    const fileIds = new Set<string>()

    for (const item of summaries) {
      const session = await source.loadSession(item.id)
      if (!session) {
        continue
      }
      const cleaned = cleanSessionText(session)
      const summary = storedSummary(cleaned)
      summaryMap[cleaned.id] = summary
      for (const fid of summary.fileIds) {
        fileIds.add(fid)
      }
      await writeJsonAtomic(`${SESSIONS_DIR}/${cleaned.id}.json`, cleaned)
    }

    for (const fid of fileIds) {
      const blob = await source.loadFile(fid)
      if (!blob) {
        continue
      }
      const b64 = await blobToBase64(blob)
      await Filesystem.writeFile({
        path: `${FILES_DIR}/${fid}`,
        data: b64,
        directory: Directory.Data,
        recursive: true,
      })
      if (blob.type) {
        await writeJsonAtomic(`${FILES_DIR}/${fid}.mime`, blob.type)
      }
    }

    const searchDocs = await source.loadAllSearchDocs()
    for (const doc of searchDocs) {
      await writeJsonAtomic(`${SEARCH_DIR}/${doc.id}.json`, doc)
    }

    await writeJsonAtomic(SUMMARIES_PATH, summaryMap)
    await writeJsonAtomic(META_PATH, { version: 1, migratedFromIdb: true } satisfies NativeMeta)
  })().catch((error: unknown) => {
    migrationPromise = null
    throw error
  })
  return migrationPromise
}

export const nativeLoadSessionSummaries = async (
  source: IdbMigrationSource
): Promise<SessionSummary[]> => {
  await ensureNativeMigrated(source)
  const map = await readSummariesMap()
  return Object.values(map).map(toSessionSummary)
}

export const nativeLoadSession = async (
  id: string,
  source: IdbMigrationSource
): Promise<Session | undefined> => {
  await ensureNativeMigrated(source)
  return readJson<Session>(`${SESSIONS_DIR}/${id}.json`)
}

export const nativeSaveSessionRecord = async (
  session: Session,
  source: IdbMigrationSource
): Promise<void> => {
  await ensureNativeMigrated(source)
  const cleaned = cleanSessionText(session)
  const summary = storedSummary(cleaned)
  await writeJsonAtomic(`${SESSIONS_DIR}/${cleaned.id}.json`, cleaned)
  const map = await readSummariesMap()
  map[cleaned.id] = summary
  await writeJsonAtomic(SUMMARIES_PATH, map)
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
  const map = await readSummariesMap()
  map[id] = storedSummary(session)
  await writeJsonAtomic(SUMMARIES_PATH, map)
}

export const nativeDeleteSession = async (
  sessionId: string,
  source: IdbMigrationSource
): Promise<void> => {
  await ensureNativeMigrated(source)
  const map = await readSummariesMap()
  const target = map[sessionId]
  const nextMap = Object.fromEntries(Object.entries(map).filter(([id]) => id !== sessionId))
  await writeJsonAtomic(SUMMARIES_PATH, nextMap)
  await deleteFileSafe(`${SESSIONS_DIR}/${sessionId}.json`)
  await deleteFileSafe(`${SEARCH_DIR}/${sessionId}.json`)

  if (!target?.fileIds?.length) {
    return
  }
  const stillReferenced = new Set<string>()
  for (const item of Object.values(nextMap)) {
    for (const fid of item.fileIds ?? []) {
      stillReferenced.add(fid)
    }
  }
  for (const fid of target.fileIds) {
    if (!stillReferenced.has(fid)) {
      await deleteFileSafe(`${FILES_DIR}/${fid}`)
      await deleteFileSafe(`${FILES_DIR}/${fid}.mime`)
    }
  }
}

const putNativeFiles = async (dir: string, files: StoredFile[]): Promise<void> => {
  await ensureDir(dir)
  for (const file of files) {
    const b64 = await blobToBase64(file.blob)
    await Filesystem.writeFile({
      path: `${dir}/${file.id}`,
      data: b64,
      directory: Directory.Data,
      recursive: true,
    })
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
  let map = merge ? await readSummariesMap() : {}

  if (!merge) {
    await clearDir(SESSIONS_DIR)
    await clearDir(FILES_DIR)
    await clearDir(SEARCH_DIR)
    await ensureDir(SESSIONS_DIR)
    await ensureDir(FILES_DIR)
    await ensureDir(SEARCH_DIR)
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
      map[session.id] = summary
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

  await writeJsonAtomic(SUMMARIES_PATH, map)
  await nativeClearStaging()
  return summaries
}
