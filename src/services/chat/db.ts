import { Capacitor } from '@capacitor/core'
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { cleanSessionText } from './clean.js'
import {
  nativeAddStagingSession,
  nativeClearStaging,
  nativeCommitStaging,
  nativeDeleteSession,
  nativeLoadAllSearchDocs,
  nativeLoadFile,
  nativeLoadSession,
  nativeLoadSessionSummaries,
  nativeRenameSession,
  nativeSaveSearchDocs,
  nativeSaveSessionFiles,
  nativeSaveSessionRecord,
  nativeSaveStagingFiles,
  nativeUpdateStagingFileTypes,
  type IdbMigrationSource,
} from './nativeDb.js'
import { toSessionSummary, type Session, type SessionSummary } from './types.js'

const isNative = () => Capacitor.isNativePlatform()

/**
 * IndexedDB 存储结构版本；新增或调整存储、索引时递增。
 * 12：新增 searchDocs（正文搜索索引，见 searchIndex.ts）。
 */
const DB_VERSION = 12

/** 文件原件按附件的本地 id 存储，所有引用同一 id 的消息共用一份；用于缩略图、打开查看，以及没有 serverId 时补传。 */
export type StoredFile = {
  id: string
  blob: Blob
}

/** 文件引用留在摘要中，删除会话时通过索引判断原件是否仍被引用。 */
type StoredSessionSummary = SessionSummary & { fileIds: string[] }

/** 搜索索引里的一条消息：只有正文（用户输入 / 助手文本回答），不含思考过程与工具调用。 */
export type SearchDoc = {
  /** 消息 id；同一会话内唯一 */
  id: string
  role: 'user' | 'assistant'
  /** 已折叠空白、已 trim 的正文；没有正文的消息不入索引 */
  text: string
  /** 消息创建时间：搜索结果每行右下角要显示日期（旧索引没有这个字段，靠 v 版本号整体重建） */
  at: number
}

/**
 * 一个会话的正文索引。按会话整条存取：写入是一条记录，加载也是一条记录，
 * 搜索时整库只在内存里扫一遍，不碰 IndexedDB。
 * updatedAt 用于判断索引是否过期（晚于它的会话改动会被重新索引）。
 */
export type SessionSearchDocs = {
  id: string
  updatedAt: number
  /**
   * 索引格式版本，必须等于 searchIndex.ts 的 DOC_VERSION。
   * 给 SearchDoc 加字段时递增：旧记录没有新字段，只能整条重建（updatedAt 比较发现不了）。
   */
  v: number
  /** 按消息顺序排列 */
  docs: SearchDoc[]
}

interface ChatDB extends DBSchema {
  /** 当前使用的会话，界面读写都在这里 */
  sessions: { key: string; value: Session }
  sessionSummaries: {
    key: string
    value: StoredSessionSummary
    indexes: { fileIds: string }
  }
  /** 当前使用的文件原件 */
  files: { key: string; value: StoredFile }
  /**
   * 历史导入的暂存：导入过程中会话与原件只写入这两个存储，`sessions` / `files` 保持不变；
   * 全部校验通过后在一个事务中替换正式数据并清空暂存，失败时只清空暂存。
   */
  sessionsStaging: { key: string; value: Session }
  filesStaging: { key: string; value: StoredFile }
  /** 正文搜索索引：一个会话一条，搜索时整库读进内存（见 searchIndex.ts） */
  searchDocs: { key: string; value: SessionSearchDocs }
}

let dbPromise: Promise<IDBPDatabase<ChatDB>> | null = null

const storedSummary = (session: Session): StoredSessionSummary => ({
  ...toSessionSummary(session),
  fileIds: [
    ...new Set(
      // 旧数据/导入数据可能缺 files；这里容错，避免一条坏记录让整条会话永远存不进去
      session.messages.flatMap((message) =>
        message.role === 'user' && Array.isArray(message.files)
          ? message.files.map((file) => file.id)
          : []
      )
    ),
  ],
})

const abortTransaction = (tx: { abort(): void }) => {
  try {
    tx.abort()
  } catch {
    // 事务已因请求失败中止。
  }
}

// 每个操作拿到连接后立即创建事务；IndexedDB 按创建顺序执行范围重叠的事务，读取总能看到之前发起的写入。
const getDB = () =>
  (dbPromise ??= openDB<ChatDB>('chat-demo', DB_VERSION, {
    upgrade(db, _oldVersion, _newVersion, tx) {
      // 初始化当前格式需要的存储与索引，不迁移旧消息。
      for (const name of [
        'sessions',
        'files',
        'sessionsStaging',
        'filesStaging',
        'searchDocs',
      ] as const) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
      const summaries = db.objectStoreNames.contains('sessionSummaries')
        ? tx.objectStore('sessionSummaries')
        : db.createObjectStore('sessionSummaries', { keyPath: 'id' })
      if (!summaries.indexNames.contains('fileIds')) {
        summaries.createIndex('fileIds', 'fileIds', { multiEntry: true })
      }
    },
    terminated() {
      dbPromise = null
    },
  })
    .then((db) => {
      db.addEventListener('close', () => {
        dbPromise = null
      })
      return db
    })
    .catch((error: unknown) => {
      // 打开失败后允许界面重试，避免一直复用已拒绝的 Promise。
      dbPromise = null
      throw error
    }))

const isConnectionClosedError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false
  }
  if (error.name === 'InvalidStateError') {
    return true
  }
  const msg = error.message.toLowerCase()
  return msg.includes('closing') || msg.includes('closed') || msg.includes('terminated')
}

const withDB = async <T>(fn: (db: IDBPDatabase<ChatDB>) => Promise<T>): Promise<T> => {
  try {
    return await fn(await getDB())
  } catch (error) {
    if (!isConnectionClosedError(error)) {
      throw error
    }
    dbPromise = null
    return await fn(await getDB())
  }
}

/** 静默申请持久化存储，降低系统在存储紧张时清理 WebView IndexedDB 的概率 */
export const requestPersistentStorage = (): void => {
  try {
    void navigator.storage?.persist?.().catch(() => {})
  } catch {
    // 部分旧 WebView 不支持 navigator.storage
  }
}

/**
 * 读取会话列表。正常情况一次 getAll；只要有一条记录反序列化失败，getAll 会整体报错，
 * 列表就全空、界面显示「对话列表加载失败」——用户看到的就是「重启后会话全没了」。
 * 所以失败后退化成按 key 逐条读：坏的那条跳过，其它会话照常列出来。
 */
const idbLoadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const db = await getDB()
  try {
    return (await db.getAll('sessionSummaries')).map(toSessionSummary)
  } catch (error) {
    reportStorageError('read local sessions')(error)
  }
  const keys = await db.getAllKeys('sessionSummaries')
  const summaries: SessionSummary[] = []
  for (const key of keys) {
    try {
      const value = await db.get('sessionSummaries', key)
      if (value) {
        summaries.push(toSessionSummary(value))
      }
    } catch (error) {
      // 单条坏记录只丢这一个会话，不影响其它记录
      reportStorageError('read session summary')(error)
    }
  }
  return summaries
}

const idbLoadSession = async (id: string): Promise<Session | undefined> =>
  (await getDB()).get('sessions', id)

const idbLoadFile = async (id: string): Promise<Blob | undefined> =>
  (await (await getDB()).get('files', id))?.blob

const idbLoadAllSearchDocs = async (): Promise<SessionSearchDocs[]> =>
  (await getDB()).getAll('searchDocs')

const idbSource: IdbMigrationSource = {
  loadSessionSummaries: idbLoadSessionSummaries,
  loadSession: idbLoadSession,
  loadFile: idbLoadFile,
  loadAllSearchDocs: idbLoadAllSearchDocs,
}

export const loadSessionSummaries = async (): Promise<SessionSummary[]> =>
  isNative() ? nativeLoadSessionSummaries(idbSource) : idbLoadSessionSummaries()

export const loadSession = async (id: string): Promise<Session | undefined> =>
  isNative() ? nativeLoadSession(id, idbSource) : idbLoadSession(id)

/**
 * 写会话正文与列表摘要。
 * 和附件分成两个事务：空间不足时附件可能写不进去，但正文先落地，
 * 用户至少不会因为一张图片丢掉整轮对话（0.9.52 用户反馈「保存失败，重试没反应」）。
 */
const isDataCloneError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'DataCloneError'

const writeSessionRecord = async (session: Session, summary: StoredSessionSummary): Promise<void> => {
  await withDB(async (db) => {
    const tx = db.transaction(['sessions', 'sessionSummaries'], 'readwrite')
    await Promise.all([
      (async () => {
        try {
          await tx.objectStore('sessions').put(session)
          await tx.objectStore('sessionSummaries').put(summary)
        } catch (error) {
          abortTransaction(tx)
          throw error
        }
      })(),
      tx.done,
    ])
  })
}

export const saveSessionRecord = async (session: Session): Promise<void> => {
  if (isNative()) {
    await nativeSaveSessionRecord(session, idbSource)
    return
  }
  // 写库前清洗异常字符与漏进来的协议标记；没有改动时返回原对象，不影响流式期间的引用比较
  session = cleanSessionText(session)
  const summary = storedSummary(session)
  try {
    await writeSessionRecord(session, summary)
  } catch (error) {
    if (!isDataCloneError(error)) {
      throw error
    }
    // 兜底：若消息对象意外混入不可克隆字段，用 JSON 清洗一次再写，避免整条会话永久卡死
    const sanitized = JSON.parse(JSON.stringify(session)) as Session
    await writeSessionRecord(sanitized, storedSummary(sanitized))
  }
}

/** 读取整库正文索引；搜索时一次性读进内存，之后不再碰 IndexedDB。 */
export const loadAllSearchDocs = async (): Promise<SessionSearchDocs[]> =>
  isNative() ? nativeLoadAllSearchDocs(idbSource) : idbLoadAllSearchDocs()

/** 写入一个会话的正文索引（整条覆盖）。 */
export const saveSearchDocs = async (docs: SessionSearchDocs): Promise<void> => {
  if (isNative()) {
    await nativeSaveSearchDocs(docs, idbSource)
    return
  }
  await (await getDB()).put('searchDocs', docs)
}

/** 未打开的会话也可重命名，只读取该会话，原子更新详情和列表。 */
export const renameSession = async (id: string, title: string): Promise<void> => {
  if (isNative()) {
    await nativeRenameSession(id, title, idbSource)
    return
  }
  const tx = (await getDB()).transaction(['sessions', 'sessionSummaries'], 'readwrite')
  await Promise.all([
    (async () => {
      try {
        const sessions = tx.objectStore('sessions')
        const session = await sessions.get(id)
        if (session) {
          session.title = title
          await sessions.put(session)
          await tx.objectStore('sessionSummaries').put(storedSummary(session))
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

/** 删除会话，仅清理已无会话引用的本地原件；远端文件不删。 */
export const deleteSession = async (sessionId: string): Promise<void> => {
  if (isNative()) {
    await nativeDeleteSession(sessionId, idbSource)
    return
  }
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'searchDocs'],
    'readwrite'
  )
  await Promise.all([
    (async () => {
      try {
        const summaries = tx.objectStore('sessionSummaries')
        const summary = await summaries.get(sessionId)
        await tx.objectStore('sessions').delete(sessionId)
        await summaries.delete(sessionId)
        await tx.objectStore('searchDocs').delete(sessionId)
        for (const id of summary?.fileIds ?? []) {
          if ((await summaries.index('fileIds').count(id)) === 0) {
            await tx.objectStore('files').delete(id)
          }
        }
      } catch (error) {
        abortTransaction(tx)
        throw error
      }
    })(),
    tx.done,
  ])
}

const putFiles = async (store: 'files' | 'filesStaging', files: StoredFile[]) => {
  await withDB(async (db) => {
    const tx = db.transaction(store, 'readwrite')
    await Promise.all([...files.map((file) => tx.store.put(file)), tx.done])
  })
}

/** 附件原件单独写：失败只影响缩略图/补传，正文已经在上一步落地 */
export const saveSessionFiles = (files: StoredFile[]): Promise<void> =>
  isNative() ? nativeSaveSessionFiles(files, idbSource) : putFiles('files', files)

export const loadFile = async (id: string): Promise<Blob | undefined> =>
  isNative() ? nativeLoadFile(id, idbSource) : idbLoadFile(id)

/** 清空导入暂存：开始导入前清除上次中断（如关闭页面）遗留的数据，导入失败后清除本次写入。 */
export const clearStaging = async (): Promise<void> => {
  if (isNative()) {
    await nativeClearStaging()
    return
  }
  const tx = (await getDB()).transaction(['sessionsStaging', 'filesStaging'], 'readwrite')
  await Promise.all([
    tx.objectStore('sessionsStaging').clear(),
    tx.objectStore('filesStaging').clear(),
    tx.done,
  ])
}

export const addStagingSession = async (session: Session): Promise<void> => {
  if (isNative()) {
    await nativeAddStagingSession(session)
    return
  }
  await (await getDB()).add('sessionsStaging', session)
}

export const saveStagingFiles = (files: StoredFile[]): Promise<void> =>
  isNative() ? nativeSaveStagingFiles(files) : putFiles('filesStaging', files)

/** 图片位于会话 JSON 之后；全部读完后回填具体 MIME，保留归档给出的 isImage 标识。 */
export const updateStagingFileTypes = async (types: ReadonlyMap<string, string>): Promise<void> => {
  if (isNative()) {
    await nativeUpdateStagingFileTypes(types)
    return
  }
  const tx = (await getDB()).transaction('sessionsStaging', 'readwrite')
  await Promise.all([
    (async () => {
      for (let cursor = await tx.store.openCursor(); cursor; cursor = await cursor.continue()) {
        const session = cursor.value
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
          await cursor.update(session)
        }
      }
    })(),
    tx.done,
  ])
}

/**
 * 导入完成后把暂存并入正式数据，并清空暂存。
 * 默认（replace）用于「清空后替换」：删除全部对话时用；
 * merge 用于导入追加：只写入本次导入的会话与原件，本机已有数据原样保留
 * （同 id 的会话在导入阶段就被跳过，不会覆盖本机版本）。
 * 逐条游标复制，同一时间只读取一条记录；事务失败时整体回滚，正式数据不变。
 */
export const commitStaging = async (
  options: { merge?: boolean } = {}
): Promise<SessionSummary[]> => {
  if (isNative()) {
    return nativeCommitStaging(options, idbSource)
  }
  const { merge = false } = options
  const summaries: SessionSummary[] = []
  const tx = (await getDB()).transaction(
    ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging', 'searchDocs'],
    'readwrite'
  )
  const move = async (from: 'sessionsStaging' | 'filesStaging', to: 'sessions' | 'files') => {
    try {
      const target = tx.objectStore(to)
      if (!merge) {
        await target.clear()
        if (to === 'sessions') {
          await tx.objectStore('sessionSummaries').clear()
          await tx.objectStore('searchDocs').clear()
        }
      }
      for (
        let cursor = await tx.objectStore(from).openCursor();
        cursor;
        cursor = await cursor.continue()
      ) {
        await target.put(cursor.value)
        if (to === 'sessions') {
          const summary = storedSummary(cursor.value as Session)
          await tx.objectStore('sessionSummaries').put(summary)
          summaries.push(toSessionSummary(summary))
        }
      }
      await tx.objectStore(from).clear()
    } catch (error) {
      // 同步抛出的错误不会让事务自动回滚，需显式中止，避免只提交清空和部分移入。
      abortTransaction(tx)
      throw error
    }
  }
  await Promise.all([move('sessionsStaging', 'sessions'), move('filesStaging', 'files'), tx.done])
  // 直接返回本次提交的列表，调用方无需在替换成功后再发起可能失败的读取。
  return summaries
}

/** 本地存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
