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
/**
 * 每个会话在结果列表里先给几条正文命中当预览。
 * 以前是「每会话最多 20 条、全库 500 条就停」，长会话里 20 条根本不够翻；
 * 现在改成按会话分组：组头显示精确命中总数，点开可以继续加载（见 MAX_HITS_PER_SESSION）。
 */
const PREVIEW_PER_SESSION = 5
/** 展开单个会话时最多返回多少条：再多 DOM 会爆（单个会话最多见过 4,686 条消息） */
const MAX_HITS_PER_SESSION = 1000
/** 保存后多久重建该会话的索引：流式回复期间 persist 很频繁，攒一下再写 */
const REINDEX_DELAY_MS = 1200
/**
 * 索引格式版本，与 db.ts 的 SessionSearchDocs.v 对应。
 * 2：SearchDoc 增加 at（消息时间），搜索结果右下角要显示日期。旧索引没有这个字段，
 * 靠 updatedAt 比对发现不了（会话没变），必须用版本号强制重建一次。
 */
const DOC_VERSION = 2

/** 一条正文命中：只带消息 id、角色和片段，会话信息在 SearchGroup 上 */
export type SearchHit = {
  messageId: string
  role: Message['role']
  /** 这条消息的创建时间，结果行右下角的日期用它 */
  at: number
  snippet: SearchSnippet | null
}

/** 一个会话的命中：标题命中（titleRanges 非空）+ 正文命中（totalHits 条，hits 里是前几条预览） */
export type SearchGroup = {
  sessionId: string
  title: string
  updatedAt: number
  /** 标题里的命中位置，升序；没命中标题就是空数组 */
  titleRanges: SearchRange[]
  /** 该会话的正文命中总数（精确，不受预览条数影响） */
  totalHits: number
  /** 预览用的前几条正文命中 */
  hits: SearchHit[]
}

export type SearchResult = {
  groups: SearchGroup[]
  /** 还有多少个会话没进索引（首次安装/刚导入时为非 0，索引建完就是 0） */
  pending: number
  /** 所有会话的正文命中总数 */
  totalHits: number
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
      docs.push({ id: message.id, role: message.role, text, at: message.createdAt })
    }
  }
  return docs
}

const toRecord = (session: Session): SessionSearchDocs => ({
  id: session.id,
  updatedAt: session.updatedAt,
  v: DOC_VERSION,
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
      // v 对不上说明是旧格式索引（例如还没有 at 字段）：会话内容没变也得重建
      return !record || record.v !== DOC_VERSION || record.updatedAt !== summary.updatedAt
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
 * 搜索全部会话，按会话分组返回：
 * 每个命中会话给一条 SearchGroup（含精确命中总数和前 PREVIEW_PER_SESSION 条正文命中），
 * 组顺序跟会话列表一致（置顶 → 最近更新）。sessions 的顺序由调用方决定。
 *
 * 为什么不再「每会话 20 条就停」：那会让长会话里的第 21 条起永远搜不到，
 * 而用户要的恰恰是「长对话里还能往下翻」。现在总数照数、预览只给几条，
 * 想看全部再调 searchSessionHits 按需展开。
 */
export const searchAll = async (
  query: string,
  sessions: readonly SessionSummary[]
): Promise<SearchResult> => {
  const keyword = normalizeQuery(query)
  if (!keyword) {
    return { groups: [], pending: 0, totalHits: 0 }
  }
  const map = await readCache()
  const ascii = /[a-z]/i.test(keyword)
  const keywordLower = ascii ? keyword.toLowerCase() : keyword
  const groups: SearchGroup[] = []
  let pending = 0
  let totalHits = 0
  for (const session of sessions) {
    const title = collapseSpaces(session.title).trim()
    const titleRanges = findRanges(title, keyword)
    const record = map.get(session.id)
    if (!record) {
      pending += 1
      if (titleRanges.length > 0) {
        groups.push({
          sessionId: session.id,
          title,
          updatedAt: session.updatedAt,
          titleRanges,
          totalHits: 0,
          hits: [],
        })
      }
      continue
    }
    const hits: SearchHit[] = []
    let count = 0
    // 由新到旧扫描：预览和展开列表都按「最新的消息在最上面」展示（对齐原版搜索页）
    for (let i = record.docs.length - 1; i >= 0; i--) {
      const doc = record.docs[i]
      const index = findInDoc(doc.text, keyword, keywordLower, ascii)
      if (index < 0) {
        continue
      }
      count += 1
      if (hits.length < PREVIEW_PER_SESSION) {
        hits.push({
          messageId: doc.id,
          role: doc.role,
          at: doc.at,
          snippet: buildSnippet(doc.text, keyword, index, CONTEXT_CHARS),
        })
      }
    }
    totalHits += count
    if (count > 0 || titleRanges.length > 0) {
      groups.push({
        sessionId: session.id,
        title,
        updatedAt: session.updatedAt,
        titleRanges,
        totalHits: count,
        hits,
      })
    }
  }
  return { groups, pending, totalHits }
}

/**
 * 展开某个会话时把它的正文命中全取出来（最多 MAX_HITS_PER_SESSION 条）。
 * 只扫这一个会话的索引，不碰其它会话；索引在内存里，几十毫秒级。
 */
export const searchSessionHits = async (
  sessionId: string,
  query: string
): Promise<SearchHit[]> => {
  const keyword = normalizeQuery(query)
  if (!keyword) {
    return []
  }
  const map = await readCache()
  const record = map.get(sessionId)
  if (!record) {
    return []
  }
  const ascii = /[a-z]/i.test(keyword)
  const keywordLower = ascii ? keyword.toLowerCase() : keyword
  const hits: SearchHit[] = []
  // 由新到旧：列表从上到下是最新 → 最早（对齐原版搜索页）
  for (let i = record.docs.length - 1; i >= 0; i--) {
    const doc = record.docs[i]
    const index = findInDoc(doc.text, keyword, keywordLower, ascii)
    if (index < 0) {
      continue
    }
    hits.push({
      messageId: doc.id,
      role: doc.role,
      at: doc.at,
      snippet: buildSnippet(doc.text, keyword, index, CONTEXT_CHARS),
    })
    if (hits.length >= MAX_HITS_PER_SESSION) {
      break
    }
  }
  return hits
}
