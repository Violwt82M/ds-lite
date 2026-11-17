import { getVisibleMessages } from './branches.js'
import {
  loadAllSearchDocs,
  loadSession,
  loadSessionSummaries,
  saveSearchDocs,
  type SearchDoc,
  type SessionSearchDocs,
} from './db.js'
import {
  buildSnippet,
  collapseSpaces,
  findRanges,
  messageText,
  normalizeQuery,
  type SearchRange,
  type SearchSnippet,
} from './searchText.js'
import type { Message, Session, SessionSummary } from './types.js'

/**
 * 正文搜索索引：把每个会话每条消息的正文抽出来，按会话整条存进 IndexedDB，
 * 搜索时整库一次性读进内存，之后每个字都在内存里扫（4.8 万条消息 / 1000 万字 ≈ 几十毫秒）。
 *
 * 为什么不用「每次搜索去读库」：旧实现每个关键词都要从 IndexedDB 读并 JSON.parse 几十个会话，
 * UI 线程被解析占满，用户感觉就是「卡」。索引只在数据变化时增量重建，搜索本身不碰 IO。
 */

/** 命中上下文左右各保留多少字 */
const CONTEXT_CHARS = 40
/** 一次最多返回多少条结果：再多用户也滚不到底，滚到底之前会提示「换个更具体的关键词」 */
const MAX_ROWS = 500
/**
 * 单个会话最多占几条正文结果。完全不限的话，几条几千条的会话会把名额吃光，
 * 别的会话一条都看不到（搜索结果全变成同一个会话）；20 条足够在一个会话里浏览上下文。
 */
const MAX_ROWS_PER_SESSION = 20
/** 保存后多久重建该会话的索引：流式回复期间 persist 很频繁，攒一下再写 */
const REINDEX_DELAY_MS = 1200

/** 一条搜索结果：标题命中没有消息，正文命中带一条消息的片段 */
export type SearchRow = {
  sessionId: string
  title: string
  updatedAt: number
  source: 'title' | 'content'
  /** 标题里的命中位置，升序 */
  titleRanges: SearchRange[]
  /** 正文命中：消息 id 与角色 */
  messageId: string | null
  role: Message['role'] | null
  snippet: SearchSnippet | null
}

export type SearchResult = {
  rows: SearchRow[]
  /** 还有多少个会话没进索引（首次安装/刚导入时为非 0，索引建完就是 0） */
  pending: number
  /** 命中太多被截断：结果区提示「只看得到前 N 条」 */
  truncated: boolean
}

export type IndexProgress = { done: number; total: number }

/** 整库索引缓存：一次加载常驻内存，新数据只更新对应会话那一条 */
let cache: Map<string, SessionSearchDocs> | null = null
let loading: Promise<Map<string, SessionSearchDocs>> | null = null
/** 同一时间只跑一个重建任务：多次调用共享同一个 Promise */
let warming: Promise<void> | null = null
/** 待重建的会话（保存后防抖） */
const dirty = new Map<string, { session: Session; timer: ReturnType<typeof setTimeout> }>()

const readCache = (): Promise<Map<string, SessionSearchDocs>> => {
  if (cache) {
    return Promise.resolve(cache)
  }
  loading ??= loadAllSearchDocs()
    .then((records) => {
      const map = new Map(records.map((record) => [record.id, record]))
      cache = map
      return map
    })
    .catch((error: unknown) => {
      // 读失败允许重试，不要一直复用已拒绝的 Promise
      loading = null
      throw error
    })
  return loading
}

/** 抽取一个会话的正文（只走当前选中分支，切走的版本搜出来也没有上下文） */
const buildDocs = (session: Session): SearchDoc[] => {
  const docs: SearchDoc[] = []
  for (const message of getVisibleMessages(session)) {
    const text = messageText(message)
    if (text) {
      docs.push({ id: message.id, role: message.role, text })
    }
  }
  return docs
}

const toRecord = (session: Session): SessionSearchDocs => ({
  id: session.id,
  updatedAt: session.updatedAt,
  docs: buildDocs(session),
})

const writeSession = async (session: Session): Promise<void> => {
  const record = toRecord(session)
  await saveSearchDocs(record)
  ;(await readCache()).set(session.id, record)
}

/** 会话保存后调用：防抖重建该会话的索引（含流式回复，收尾时再写一次就稳了） */
export const scheduleSessionIndex = (session: Session): void => {
  const existing = dirty.get(session.id)
  if (existing) {
    clearTimeout(existing.timer)
  }
  dirty.set(session.id, {
    session,
    timer: setTimeout(() => {
      dirty.delete(session.id)
      void writeSession(session).catch(() => {
        // 索引是加速手段，写失败不影响对话；下次启动会按 updatedAt 重新补齐
      })
    }, REINDEX_DELAY_MS),
  })
}

/** 页面要隐藏/关闭时把待写的索引立刻落盘，避免「刚聊完搜不到」 */
export const flushSearchIndex = (): void => {
  for (const [id, entry] of dirty) {
    clearTimeout(entry.timer)
    dirty.delete(id)
    void writeSession(entry.session).catch(() => {})
  }
}

/**
 * 补齐索引：读出整库索引，把「没有索引」或「updatedAt 对不上」的会话逐个重建。
 * 只在启动后空闲时跑一次；真正的搜索不等它，先用手上已有的索引出结果。
 */
export const warmSearchIndex = (onProgress?: (progress: IndexProgress) => void): Promise<void> => {
  if (warming) {
    return warming
  }
  warming = (async () => {
    const map = await readCache()
    const summaries = await loadSessionSummaries()
    const stale = summaries.filter((summary) => {
      const record = map.get(summary.id)
      return !record || record.updatedAt !== summary.updatedAt
    })
    if (stale.length === 0) {
      onProgress?.({ done: 0, total: 0 })
      return
    }
    let done = 0
    for (const summary of stale) {
      const session = await loadSession(summary.id)
      if (session) {
        await writeSession(session)
      } else {
        // 会话在列里但已经读不出来：别让索引一直等它
        map.delete(summary.id)
      }
      done += 1
      onProgress?.({ done, total: stale.length })
      // 每个会话让出一次主线程：首次建立索引（几万字的长会话）不能把界面卡住
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  })()
    .catch(() => {
      // 索引建不起来只是慢，不该影响搜索本身
    })
    .finally(() => {
      warming = null
    })
  return warming
}

/** 英文关键词不区分大小写：先按原样找，找不到再把正文转小写找（比每条都转小写省一半时间） */
const findInDoc = (text: string, keyword: string, keywordLower: string, ascii: boolean): number => {
  const direct = text.indexOf(keyword)
  if (direct >= 0 || !ascii) {
    return direct
  }
  return text.toLowerCase().indexOf(keywordLower)
}

/**
 * 搜索全部会话：先按「置顶 → 最近更新」的列表顺序给出标题命中，
 * 再逐会话给出正文命中（一条消息一行），最多 MAX_ROWS 条。
 * sessions 的顺序由调用方决定（抽屉和全屏页都按列表顺序传）。
 */
export const searchAll = async (
  query: string,
  sessions: readonly SessionSummary[]
): Promise<SearchResult> => {
  const keyword = normalizeQuery(query)
  if (!keyword) {
    return { rows: [], pending: 0, truncated: false }
  }
  const map = await readCache()
  const ascii = /[a-z]/i.test(keyword)
  const keywordLower = ascii ? keyword.toLowerCase() : keyword
  const rows: SearchRow[] = []
  let pending = 0
  for (const session of sessions) {
    const title = collapseSpaces(session.title).trim()
    const titleRanges = findRanges(title, keyword)
    if (titleRanges.length > 0) {
      rows.push({
        sessionId: session.id,
        title,
        updatedAt: session.updatedAt,
        source: 'title',
        titleRanges,
        messageId: null,
        role: null,
        snippet: null,
      })
    }
    const record = map.get(session.id)
    if (!record) {
      pending += 1
      continue
    }
    let contentRows = 0
    for (const doc of record.docs) {
      if (contentRows >= MAX_ROWS_PER_SESSION) {
        break
      }
      const index = findInDoc(doc.text, keyword, keywordLower, ascii)
      if (index < 0) {
        continue
      }
      contentRows += 1
      rows.push({
        sessionId: session.id,
        title,
        updatedAt: session.updatedAt,
        source: 'content',
        titleRanges,
        messageId: doc.id,
        role: doc.role,
        snippet: buildSnippet(doc.text, keyword, index, CONTEXT_CHARS),
      })
      if (rows.length >= MAX_ROWS) {
        return { rows, pending, truncated: true }
      }
    }
  }
  return { rows, pending, truncated: false }
}
