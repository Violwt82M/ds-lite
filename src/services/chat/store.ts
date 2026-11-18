import { create } from 'zustand'
import { translate, type TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import { safeTail, truncatePercent } from '../../utils/safeText.js'
import { ApiError, streamMessage } from '../api/client.js'
import type { ChatModel } from '../api/types.js'
import { isCustomApiOrigin } from '../api/base.js'
import { extractFileIds, getFileErrorCode, isRetryableApiError } from '../api/errors.js'
import { cancelUpload, describeUploadError, uploadAttachment, useUploads } from '../attachments.js'
import { useSettings } from '../settings.js'
import { showToast } from '../../components/base/toastState.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import { flushSearchIndex, scheduleSessionIndex } from './searchIndex.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { buildSystemPrompt } from '../persona/prompt.js'
import {
  bindPersonaForNewSession,
  resolveSessionPersona,
  setSessionPersona,
  usePersonaScope,
} from '../persona/scope.js'
import { usePersona } from '../persona/store.js'
import {
  buildTranscript,
  charsForTokens,
  MAX_BIG_NOTE_CHARS,
  bigNoteLimit,
  parseBigNote,
  roundsChars,
  SEGMENT_CHARS,
  splitRounds,
  renderMemorySection,
  rewriteNotes,
  summarizeOverview,
  mergeOverview,
  summarizeRounds,
} from '../memory/compact.js'
import {
  estimateMessageTokens,
  formatCharCount,
  getContextUsage,
  MANUAL_KEEP_TOKENS,
  MEMORY_KEEP_TOKENS,
  splitFoldableRounds,
  getFoldedChars,
  getFoldedIds,
  getUnfoldedRounds,
  type ContextUsage,
} from '../memory/context.js'
import { setCompactProgress, setCompacting, setMemoryError, setMemoryNotice } from '../memory/state.js'
import { createLatestReminder } from './latestReminder.js'
import {
  buildInternalRequest,
  buildRequest,
  EXTENDED_INPUT_LIMIT_TOKENS,
  wantsExtendedRequest,
} from './request.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  settleReply,
  toRequestMessages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type MemoryNote,
  type Message,
  type Session,
  type SessionMemory,
  type SessionRecord,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/**
 * 当前模型：设置里选的（默认 flash，只有它支持图片输入）。
 * 换了第三方 API 地址时强制走 flash：对方的模型名和价格都可能不一样，不能按官方 pro 发。
 */
const currentModel = (): ChatModel =>
  isCustomApiOrigin() ? 'deepseek-flash' : useSettings.getState().model
/** 一次整理最多处理多少段，剩下的留给下次运行 */
const MAX_COMPACT_SEGMENTS = 30
/** 单段最多送多少字：先按大段试，服务端拒收时自动对半降级 */
const MAX_SEGMENT_CHARS = 120_000
/** 理想分段数：1M 字按 8 段算，每段 12 万字左右，跑得比 30 段快得多 */
const TARGET_SEGMENTS = 8
/** 长期概览在笔记里的标题，用来区分两层记忆 */
const OVERVIEW_TITLE = '【长期概览】'
/** 最近多少字保留详细笔记，更早的只压概览 */
const RECENT_CHARS = 120_000
/** 老内容每段送多少字再压概览：输出很短，段可以开大点 */
const OVERVIEW_SEGMENT_CHARS = 60_000
/** 所有生成请求统一携带的助手身份说明 */
/** 手动生成笔记只防跑飞，篇幅听用户的 */
const MAX_MANUAL_NOTE_CHARS = 20_000

const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000
/** 喂给整理调用当「只读参考」的最近原文上限：只用来判断旧笔记哪句过期了 */
const RECENT_REF_TOKENS = 4_000
/** 自动整理至少要有这么多可折叠轮次，避免每轮都触发一次额外调用 */
const MEMORY_MIN_FOLD_ROUNDS = 2
/**
 * 自动整理线：上下文粗估到 45% 就把较早轮次折叠成记忆笔记。
 * 1M 能装很多，但每轮都要为未命中缓存的部分付钱（flash 高峰 2 元/百万），
 * 早一点折叠能让长对话的每轮成本保持平稳。
 */
const AUTO_COMPACT_TOKENS = 450_000
/**
 * 自动整理开着时的兜底护栏：可折叠轮次不够（比如最近几轮自带超大附件）时，
 * 到 900K 仍然先整理一次再发，避免请求被服务端直接拒绝。
 */
const CONTEXT_GUARD_TOKENS = 850_000
/** 服务端上下文 1,048,576；留 4 万给输出与估算误差，超过就拦下而不是发出去被拒 */
const CONTEXT_BLOCK_TOKENS = 1_000_000

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
  /** 置顶：会话 id → 置顶时间。纯本地列表偏好，不写进会话数据，也不随导出备份 */
  pins: Record<string, number>
}

const PINS_KEY = 'ds-lite.pinnedSessions'

/** 读本机记住的置顶；坏数据一律当没置顶 */
const readPins = (): Record<string, number> => {
  try {
    const raw = window.localStorage.getItem(PINS_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

const writePins = (pins: Record<string, number>) => {
  try {
    window.localStorage.setItem(PINS_KEY, JSON.stringify(pins))
  } catch {
    // 隐私模式写不进去就只在本次运行里生效
  }
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
  pins: readPins(),
}))

const { getState: get, setState: set } = useChatStore

/** 置顶的排在最前（后置顶的更前），其余按最后更新时间 */
const sortSessions = (sessions: SessionSummary[], pins: Record<string, number> = get().pins) =>
  [...sessions].sort(
    (a, b) => (pins[b.id] ?? 0) - (pins[a.id] ?? 0) || b.updatedAt - a.updatedAt
  )

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        // 正文搜索索引跟着数据走：会话存进库后顺手重建它那一条（防抖，流式期间不会反复写）
        scheduleSessionIndex(session)
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
    // 待写的搜索索引也落盘：不然刚聊完就关页面，下次搜不到最后一轮
    flushSearchIndex()
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model: currentModel(),
    thinking,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换或追加历史对话：先写入暂存，成功后一次事务落库。
 * - 默认替换：清空旧记录，写入为空即删除全部会话与附件（删除全部对话用）；
 *   期间停止生成、清空详情缓存，避免旧数据残留。
 * - merge 追加：本机已有会话与附件原样保留，只并入本次导入的新会话；
 *   不打断正在生成的回答，也不清空任何缓存。
 * 失败时清除暂存，保留原有记录。返回写入的会话数。
 */
export const replaceHistory = async (
  write: () => Promise<void>,
  options: { merge?: boolean } = {}
): Promise<number> => {
  const { merge = false } = options
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    if (!merge) {
      for (const controller of Object.values(get().streaming)) {
        controller.abort()
      }
      // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
      await Promise.all(deletionTasks)
      historyEpoch += 1
      initTask = undefined
      sessionLoads.clear()
      await waitForIdle()
    }
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging({ merge })
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    if (merge) {
      // 会话 id 由导入阶段去重，这里直接并进列表即可；详情缓存对已有会话仍然有效。
      set({ sessions: sortSessions([...get().sessions, ...summaries]) })
      return summaries.length
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

export const newChat = () => {
  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

/** 置顶：没置顶过的排到最前；已经置顶的再点一次也排到最前（按置顶时间排） */
export const pinSession = (id: string) => {
  const pins = { ...get().pins, [id]: Date.now() }
  writePins(pins)
  set((state) => ({ pins, sessions: sortSessions(state.sessions, pins) }))
}

export const unpinSession = (id: string) => {
  const pins = Object.fromEntries(
    Object.entries(get().pins).filter(([key]) => key !== id)
  ) as Record<string, number>
  writePins(pins)
  set((state) => ({ pins, sessions: sortSessions(state.sessions, pins) }))
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
    }
    sessionId = session.id
    bindPersonaForNewSession(session.id)
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType, truncated, tokens }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
      ...(truncated ? { truncated } : {}),
      ...(typeof tokens === 'number' ? { tokens } : {}),
    })),
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  // 官方口径：文档过大时照样发，但明确告诉用户模型只读了多少
  const sliced = files.find((file) => file.truncated)
  if (sliced?.truncated) {
    showToast({
      key: 'attachmentTruncatedNotice',
      params: {
        name: sliced.name,
        percent: truncatePercent(sliced.truncated.kept, sliced.truncated.total),
        kept: formatCharCount(sliced.truncated.keptTokens),
        total: formatCharCount(sliced.truncated.totalTokens),
      },
    })
  }
  void streamReply(sessionId, reply, { history, question })
  return true
}

/**
 * 从某条回答分叉：把「到这条消息为止」的可见记录、记忆笔记、人设绑定复制到一个新会话。
 * 原会话完全不动，用户可以在新会话里换一种写法接着聊。
 */
export const forkSession = (sessionId: string, messageId: string): string | null => {
  const state = get()
  if (state.importingHistory || deletingSessions.has(sessionId)) {
    return null
  }
  const session = getSession(sessionId)
  if (!session) {
    return null
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  if (index < 0) {
    return null
  }
  const now = Date.now()
  // 消息是纯 JSON 结构（附件只存 id，原件在 files 表里共用），深拷贝一份即可，两边互不影响
  const messages = path
    .slice(0, index + 1)
    .map((message) => JSON.parse(JSON.stringify(message)) as Message)
  const baseTitle = session.title.trim() || translate('untitledChat')
  const forked: Session = {
    id: createId(),
    title: `${baseTitle}${translate('forkTitleSuffix')}`,
    createdAt: now,
    updatedAt: now,
    messages,
    rootMessageId: messages[0]?.id ?? null,
    ...(session.memory
      ? { memory: JSON.parse(JSON.stringify(session.memory)) as SessionMemory }
      : {}),
  }
  // 人设：源会话显式绑过就照抄；没绑过（用全局默认）则让新会话沿用当前默认
  const scope = usePersonaScope.getState().map[sessionId]
  if (scope !== undefined) {
    setSessionPersona(forked.id, scope)
  } else {
    bindPersonaForNewSession(forked.id)
  }
  touchSession(forked.id)
  set((current) => ({
    sessions: [toSessionSummary(forked), ...current.sessions],
    sessionCache: { ...current.sessionCache, [forked.id]: forked },
    activeId: forked.id,
  }))
  persist(forked.id)
  return forked.id
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? currentModel(),
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

// ---------------- 外置记忆 ----------------

/** 正在整理记忆的会话：同一会话同时只允许一次整理 */
const compactionTasks = new Map<string, Promise<boolean>>()
const memoryControllers = new Map<string, AbortController>()

const emptyMemory = (): SessionMemory => ({
  notes: [],
  foldedIds: [],
  foldedRounds: 0,
  updatedAt: Date.now(),
})

/** 改写会话的外置记忆并落盘；memory 为空对象表示恢复全量上下文 */
const updateMemory = (
  sessionId: string,
  update: (memory: SessionMemory) => SessionMemory | undefined
) => {
  updateSession(sessionId, (session) => {
    const memory = update(session.memory ?? emptyMemory())
    return { ...session, ...(memory ? { memory } : { memory: undefined }) }
  })
  persist(sessionId)
}

/* ---------- 记录：AI 写的回顾/日记，纯观赏，不进上下文 ---------- */

export const addSessionRecord = (sessionId: string, title: string, text: string): string | null => {
  const session = getSession(sessionId)
  if (!session) {
    return null
  }
  const now = Date.now()
  const record: SessionRecord = { id: createId(), title, text, createdAt: now, updatedAt: now }
  updateSession(sessionId, (current) => ({ ...current, records: [record, ...(current.records ?? [])] }))
  persist(sessionId)
  return record.id
}

export const updateSessionRecord = (
  sessionId: string,
  recordId: string,
  patch: { title?: string; text?: string }
) => {
  updateSession(sessionId, (session) => ({
    ...session,
    records: (session.records ?? []).map((record) =>
      record.id === recordId ? { ...record, ...patch, updatedAt: Date.now() } : record
    ),
  }))
  persist(sessionId)
}

export const deleteSessionRecord = (sessionId: string, recordId: string) => {
  updateSession(sessionId, (session) => ({
    ...session,
    records: (session.records ?? []).filter((record) => record.id !== recordId),
  }))
  persist(sessionId)
}

/** 记录只取最近这么多条消息，避免生成调用本身把上下文撑爆 */
const RECORD_SOURCE_MESSAGES = 20
const RECORD_SOURCE_CHARS = 6000

const recordText = (message: Message): string => {
  if (message.role === 'user') {
    return message.content
  }
  return message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/**
 * 按用户给的提示词生成一段记录（回顾/日记）。
 * 素材是记忆笔记 + 最近若干条消息；用记录专用模型（默认 flash）单独发一次请求，
 * 结果只存本地展示，不进入对话上下文。
 */
export const generateSessionRecord = async (
  sessionId: string,
  instruction: string
): Promise<{ ok: boolean; reason?: string }> => {
  const { apiKey, locale } = useSettings.getState()
  const session = getSession(sessionId)
  if (!apiKey || !session) {
    return { ok: false, reason: 'nokey' }
  }
  if (getStreamController(sessionId)) {
    return { ok: false, reason: 'busy' }
  }
  const persona = resolveSessionPersona(sessionId).entry
  const notes = (session.memory?.notes ?? []).map((note) => `- ${note.text}`).join('\n')
  const recent = getVisibleMessages(session).slice(-RECORD_SOURCE_MESSAGES)
  const transcript = safeTail(
    recent
      .map((message) => `${message.role === 'user' ? '用户' : (persona ? persona.card.name : 'AI')}：${recordText(message)}`)
      .join('\n'),
    RECORD_SOURCE_CHARS
  )
  const english = locale === 'en-US'
  const system = [
    persona
      ? english
        ? `You are roleplaying ${persona.card.name}. Stay fully in character and write in that voice.`
        : `你现在扮演「${persona.card.name}」，用这个角色的语气和视角来写。`
      : '',
    english
      ? 'You write short first-person records of past conversations for the user to keep. Be concrete, no preamble, no meta commentary.'
      : '你要为用户写一段第一人称的回顾记录，供他留存。要具体，不要开场白，不要说明自己在做什么。',
  ]
    .filter(Boolean)
    .join('\n')
  const { body } = buildInternalRequest({
    model: isCustomApiOrigin() ? 'deepseek-flash' : useSettings.getState().recordModel,
    system,
    messages: [
      {
        role: 'user',
        content: [
          instruction.trim() ? `${english ? '[Requirement]' : '【要求】'}\n${instruction.trim()}` : '',
          notes ? `${english ? '[Memory notes]' : '【记忆笔记】'}\n${notes}` : '',
          `${english ? '[Recent conversation]' : '【最近对话】'}\n${transcript}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    let text = ''
    for await (const event of streamMessage(apiKey, body, controller.signal)) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text
      }
    }
    const trimmed = parseBigNote(text, MAX_MANUAL_NOTE_CHARS)
    if (trimmed === '') {
      return { ok: false, reason: 'empty' }
    }
    const firstLine = trimmed.split('\n').find((line) => line.trim() !== '') ?? trimmed
    const title = firstLine.replace(/^#+\s*/, '').slice(0, 30)
    addSessionRecord(sessionId, title, trimmed)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * 按用户的提示词，把最近的对话写成一条记忆笔记（source: summary）。
 * 和「记录」不同：这条笔记会通过系统提示词进入上下文，等于让 AI 按你的要求记住某些内容。
 */
export const generateMemoryNote = async (
  sessionId: string,
  instruction: string
): Promise<{ ok: boolean; reason?: string }> => {
  const { apiKey } = useSettings.getState()
  const session = getSession(sessionId)
  if (!apiKey || !session) {
    return { ok: false, reason: 'nokey' }
  }
  const notes = (session.memory?.notes ?? []).map((note) => `- ${note.text}`).join('\n')
  const personaEntry = resolveSessionPersona(sessionId).entry
  const transcript = safeTail(
    getVisibleMessages(session)
      .slice(-RECORD_SOURCE_MESSAGES)
      .map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${recordText(message)}`)
      .join('\n'),
    RECORD_SOURCE_CHARS
  )
  const { body } = buildInternalRequest({
    model: 'deepseek-flash',
    system:
      '你把对话压缩成供后续对话使用的记忆笔记：只写事实、结论、偏好和待办，不写寒暄和过程；它是被省略原文的替代索引，不是当前剧情，也不写场景描写。' +
      '输出一份笔记，用「【重要设定】【用户偏好】【约定与未决】【待办】」分段，每条以「· 」开头；不要抄台词，语气由后续的近期原文维持；只输出笔记正文。' +
      '篇幅由用户的要求决定：用户说要多长就写多长，没有说明时保持精简（约 600 字）。',
    messages: [
      {
        role: 'user',
        content: [
          instruction.trim() ? `【整理要求】\n${instruction.trim()}` : '',
          personaEntry
            ? `【角色扮演背景】\n你在扮演「${personaEntry.card.name}」${personaEntry.card.style ? `，说话风格：${personaEntry.card.style}` : ''}。务必留下角色的当前状态与关系，以及这段对话里发生过的关键事件（只记事件与结果，不写场景过程）。`
            : '',
          notes ? `【已有笔记】\n${notes}` : '',
          `【最近的对话】\n${transcript}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
  })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    let text = ''
    for await (const event of streamMessage(apiKey, body, controller.signal)) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text
      }
    }
    const trimmed = text.trim()
    if (trimmed === '') {
      return { ok: false, reason: 'empty' }
    }
    const now = Date.now()
    const noteId = createId()
    updateMemory(sessionId, (memory) => ({
      ...memory,
      notes: [...memory.notes, { id: noteId, text: trimmed, createdAt: now, source: 'summary' }],
      updatedAt: now,
    }))
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}

/** 记录用户对整理的额外要求（最多 200 字，空字符串表示恢复默认） */
export const setMemoryInstruction = (sessionId: string, instruction: string) => {
  const trimmed = instruction.trim().slice(0, 200)
  updateMemory(sessionId, (memory) => ({ ...memory, instruction: trimmed === '' ? undefined : trimmed }))
}

/** 已折叠的轮数：面板在整理完成后据此算出本次折叠了多少轮 */
export const getFoldedRounds = (sessionId: string): number =>
  getSession(sessionId)?.memory?.foldedRounds ?? 0

/** 当前会话的上下文占用，供界面展示 */
export const getSessionContextUsage = (sessionId: string): ContextUsage | undefined => {
  const session = getSession(sessionId)
  return session ? getContextUsage(session) : undefined
}

/** 手动触发一次记忆整理：把较早的轮次压缩成笔记并从请求上下文里折叠掉。 */
export const compactSessionMemory = (
  sessionId: string,
  source: 'auto' | 'manual',
  /** 发送前的护栏传 duringStream：此时已经登记了流控制器，但请求还没发出 */
  options: { duringStream?: boolean; keep?: number; minimum?: number } = {}
): Promise<boolean> => {
  const running = compactionTasks.get(sessionId)
  if (running) {
    return running
  }
  const task = runCompaction(sessionId, source, options)
  compactionTasks.set(sessionId, task)
  return task.finally(() => compactionTasks.delete(sessionId))
}

const runCompaction = async (
  sessionId: string,
  source: 'auto' | 'manual',
  options: { duringStream?: boolean; keep?: number; minimum?: number } = {}
): Promise<boolean> => {
  const { apiKey, locale } = useSettings.getState()
  const session = getSession(sessionId)
  if (!apiKey || !session || get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  if (!options.duringStream && getStreamController(sessionId)) {
    return false
  }
  const rounds = getUnfoldedRounds(session)
  // 近期原文按 token 保底，不按轮数：同一轮可以是 200 字也可以是 3000 字。
  // 切法与横幅、面板共用 splitFoldableRounds，界面上说「能整理」就一定能整理。
  const { kept, foldable: candidates } = splitFoldableRounds(
    rounds,
    source === 'manual' ? MANUAL_KEEP_TOKENS : MEMORY_KEEP_TOKENS,
    options.keep
  )
  const minimum = options.minimum ?? (source === 'manual' ? 1 : MEMORY_MIN_FOLD_ROUNDS)
  if (candidates.length < minimum) {
    // 近期窗口按 token 保底，短对话整段都在窗口里：点「立即整理」不该毫无反应
    if (source === 'manual' && rounds.length > 0) {
      setMemoryError(sessionId, { key: 'memoryCompactTooShort' })
    }
    return false
  }
  // 这次不折叠、会原样留在上下文里的最近对话：给整理调用当只读参考，
  // 否则摘要只描述「整理那一刻」的状态，和近期原文里已经发生的事打架。
  const recentTranscript = buildTranscript(kept, locale, charsForTokens(RECENT_REF_TOKENS))
  const controller = new AbortController()
  memoryControllers.set(sessionId, controller)
  setCompacting(sessionId, true)
  try {
    // 两层记忆：
    //   老内容 → 只压成概览（越老越简，像人回忆很久以前的事，跑得也快）
    //   最近内容 → 详细笔记（含角色状态、关系、文风样本）
    // 每次整理都会把「上一次的概览」一起重新概括，只留下主线。
    // 笔记预算按**累计**折叠量算：这次要折的 + 之前已经折掉的
    const total = roundsChars(candidates) + getFoldedChars(session)
    const initialBudget = Math.min(
      MAX_SEGMENT_CHARS,
      Math.max(SEGMENT_CHARS, Math.ceil(total / TARGET_SEGMENTS))
    )
    const noteLimit = bigNoteLimit(total)
    const personaEntry = resolveSessionPersona(sessionId).entry
    const persona = personaEntry
      ? { name: personaEntry.card.name, style: personaEntry.card.style }
      : undefined

    // 最近一段保留细节：按字数切出 RECENT_CHARS 的内容
    let recentStart = candidates.length
    let recentChars = 0
    while (recentStart > 0 && recentChars < RECENT_CHARS) {
      recentStart -= 1
      recentChars += roundsChars([candidates[recentStart]])
    }
    const oldRounds = candidates.slice(0, recentStart)
    const recentRounds = candidates.slice(recentStart)

    const previousOverview = (session.memory?.notes ?? [])
      .map((note) => note.text)
      .find((noteText) => noteText.startsWith(OVERVIEW_TITLE)) ?? ''
    const overviewLines: string[] = []
    const oldChunks = oldRounds.length > 0 ? splitRounds(oldRounds, OVERVIEW_SEGMENT_CHARS) : []
    const recentQueue = splitRounds(recentRounds, initialBudget).slice(0, MAX_COMPACT_SEGMENTS)
    const folded: [UserMessage, AssistantMessage][] = []
    let notes = (session.memory?.notes ?? [])
      .map((note) => note.text)
      .filter((noteText) => !noteText.startsWith(OVERVIEW_TITLE))
    let done = 0
    let totalSegments = oldChunks.length + recentQueue.length + (oldChunks.length > 0 ? 1 : 0)
    let splits = 0
    let effectiveBudget = initialBudget
    setCompactProgress(sessionId, { done, total: totalSegments })

    // ---- 第一层：老内容压概览 ----
    for (const chunk of oldChunks) {
      const timeout = setTimeout(() => controller.abort(), 180_000)
      try {
        const line = await summarizeOverview({
          apiKey,
          transcript: buildTranscript(chunk, locale, OVERVIEW_SEGMENT_CHARS),
          locale,
          signal: controller.signal,
        })
        if (line !== '') {
          overviewLines.push(line)
        }
      } catch (error) {
        if (!isTooLongError(error) || chunk.length < 2) {
          throw error
        }
        // 太长就拆一半再试，概览本来就不要求一次读完
        const half = Math.ceil(chunk.length / 2)
        const parts = [chunk.slice(0, half), chunk.slice(half)]
        for (const part of parts) {
          const line = await summarizeOverview({
            apiKey,
            transcript: buildTranscript(part, locale, OVERVIEW_SEGMENT_CHARS),
            locale,
            signal: controller.signal,
          })
          if (line !== '') {
            overviewLines.push(line)
          }
        }
      } finally {
        clearTimeout(timeout)
      }
      folded.push(...chunk)
      done += 1
      setCompactProgress(sessionId, { done, total: totalSegments })
    }

    // 把「上一次的概览」和新概览合并成一条，越老越简
    let overview = previousOverview
    if (overviewLines.length > 0) {
      overview = await mergeOverview({
        apiKey,
        prev: previousOverview,
        lines: overviewLines,
        locale,
        signal: controller.signal,
      })
      done += 1
      setCompactProgress(sessionId, { done, total: totalSegments })
    }

    // ---- 第二层：最近内容写详细笔记 ----
    const queue = [...recentQueue]
    while (queue.length > 0) {
      const chunk = queue.shift()
      if (!chunk) {
        break
      }
      const transcript = buildTranscript(chunk, locale, effectiveBudget)
      const timeout = setTimeout(
        () => controller.abort(),
        Math.min(600_000, 120_000 + transcript.length * 2)
      )
      let reply: string
      try {
        reply = await summarizeRounds({
          apiKey,
          transcript,
          existingNotes: notes,
          locale,
          signal: controller.signal,
          instruction: session.memory?.instruction,
          noteLimit,
          persona,
          recent: recentTranscript,
        })
      } catch (error) {
        // 400 且提示超长：把这一段对半砍开重试，并把后续段预算压下来
        if (isTooLongError(error) && chunk.length > 1 && splits < 20) {
          splits += 1
          effectiveBudget = Math.max(SEGMENT_CHARS, Math.floor(effectiveBudget / 2))
          const half = Math.ceil(chunk.length / 2)
          queue.unshift(chunk.slice(half))
          queue.unshift(chunk.slice(0, half))
          totalSegments += 1
          setCompactProgress(sessionId, { done, total: totalSegments })
          continue
        }
        throw error
      } finally {
        clearTimeout(timeout)
      }
      const parsed = parseBigNote(reply, noteLimit)
      if (parsed === '') {
        setMemoryError(sessionId, { key: 'memoryCompactEmpty' })
        return false
      }
      notes = [parsed]
      folded.push(...chunk)
      done += 1
      setCompactProgress(sessionId, { done, total: totalSegments })
    }
    if (overview !== '') {
      notes = [`${OVERVIEW_TITLE}\n${overview}`, ...notes]
    }
    const now = Date.now()
    const foldedIds = folded.map(([, reply]) => reply.id)
    updateMemory(sessionId, (memory) => ({
      // 覆盖式：模型输出的就是最新一版笔记，旧笔记被整体替换
      notes: rewriteNotes(memory, notes, now, MAX_BIG_NOTE_CHARS),
      foldedIds: [...memory.foldedIds, ...foldedIds],
      foldedRounds: memory.foldedRounds + foldedIds.length,
      updatedAt: now,
    }))
    // 自动整理是后台行为，留一条一次性提示，免得用户觉得"它怎么突然失忆了"
    if (source === 'auto') {
      setMemoryNotice(sessionId, foldedIds.length)
    }
    return true
  } catch (error) {
    if (controller.signal.aborted) {
      return false
    }
    setMemoryError(sessionId, describeCompactFailure(error))
    return false
  } finally {
    memoryControllers.delete(sessionId)
    setCompactProgress(sessionId, undefined)
    setCompacting(sessionId, false)
  }
}

/** 服务端因为输入过长拒收：各渠道文案不同，按关键词加状态码判断 */
const isTooLongError = (error: unknown): boolean =>
  error instanceof ApiError &&
  error.status === 400 &&
  /too long|exceeds (max|the maximum)|context length|maximum context|tokens/i.test(error.message)

/** 整理失败时把「哪个服务、什么状态码」一起说出来，405 单独给提示 */
const describeCompactFailure = (error: unknown): TranslationMessage => {
  if (error instanceof ApiError) {
    const host = error.url === undefined ? '' : ` · ${safeHost(error.url)}`
    if (error.status === 405) {
      return { key: 'memoryCompactMethodNotAllowed', params: { host } }
    }
    // HTTP 200 却进了错误分支：说明对方回的不是流式响应，请求根本没打到 DeepSeek 接口
    // （校园网/公司网关的登录页、WAF 拦截页、中转或反代都会这样）
    if (error.status === 200) {
      return { key: 'memoryCompactNotStream', params: { host } }
    }
    if (error.status !== undefined) {
      return {
        key: 'memoryCompactFailedWithStatus',
        params: { status: String(error.status), host, message: error.message },
      }
    }
  }
  return {
    key: 'memoryCompactFailed',
    params: { message: error instanceof Error ? error.message : String(error) },
  }
}

const safeHost = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 取消正在进行的整理（用户关掉面板或点了取消） */
export const cancelMemoryCompaction = (sessionId: string) => {
  memoryControllers.get(sessionId)?.abort()
}

/**
 * 回复落地后检查是否需要自动整理：上下文粗估超过阈值、且攒够可折叠轮次时触发一次。
 * 折叠是整段进行的，折叠后的前缀保持稳定，避免破坏服务端的前缀缓存。
 */
const maybeAutoCompactMemory = async (sessionId: string) => {
  if (!useSettings.getState().autoMemory) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId) || compactionTasks.has(sessionId)) {
    return
  }
  if (getContextUsage(session).usedTokens < AUTO_COMPACT_TOKENS) {
    return
  }
  await compactSessionMemory(sessionId, 'auto')
}

/** 手动新增一条空笔记，交由面板立刻进入编辑态 */
export const addMemoryNote = (sessionId: string): string => {
  const now = Date.now()
  const id = createId()
  updateMemory(sessionId, (memory) => ({
    ...memory,
    notes: [
      ...memory.notes,
      { id, text: '', createdAt: now, source: 'manual' } satisfies MemoryNote,
    ],
    updatedAt: now,
  }))
  return id
}

/** 保存笔记；保存为空文本等同于删除 */
export const saveMemoryNote = (sessionId: string, noteId: string, text: string) => {
  const trimmed = text.trim()
  updateMemory(sessionId, (memory) => {
    // 用户改过的笔记标成手写：之后的自动整理不会把它删掉
    const notes = trimmed
      ? memory.notes.map((note) =>
          note.id === noteId ? { ...note, text: trimmed, source: 'manual' as const } : note
        )
      : memory.notes.filter((note) => note.id !== noteId)
    return { ...memory, notes, updatedAt: Date.now() }
  })
}

export const removeMemoryNote = (sessionId: string, noteId: string) => {
  updateMemory(sessionId, (memory) => ({
    ...memory,
    notes: memory.notes.filter((note) => note.id !== noteId),
    updatedAt: Date.now(),
  }))
}

/** 清空记忆：笔记与折叠一起丢掉，上下文恢复全量（原文一直都在本机） */
export const clearSessionMemory = (sessionId: string) => {
  updateSession(sessionId, (session) => ({ ...session, memory: undefined }))
  persist(sessionId)
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) =>
              serverIds.has(file.id) ? { ...file, serverId: serverIds.get(file.id) ?? null } : file
            ),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const apiKey = useSettings.getState().apiKey ?? ''
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(apiKey, file)
      if (serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  // 已折叠的轮次不进入请求，它们的附件也不必再补传
  const folded = new Set(getSession(sessionId)?.memory?.foldedIds ?? [])
  for (const [user, reply] of [...getContextRounds(request.history)].reverse()) {
    if (folded.has(reply.id)) {
      continue
    }
    for (const file of user.files) {
      if (!file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const serverId = await Promise.race([ensureServerId(apiKey, file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]))
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/** 扩展模式裁剪的余量：本地估算允许 10%~20% 误差，还要给服务端的工具结果留位置 */
const EXTENDED_TRIM_MARGIN_TOKENS = 1_000

/**
 * 为扩展模式（联网搜索 / 阅读链接 / 严格审查）裁剪一份「只用于本次请求」的历史视图。
 *
 * 服务端在这类请求上的输入上限只有 32768 token，而历史附件按体积折算后会一直占着本地估算，
 * 不裁剪的话「发过一次大文档」就会让联网从此用不了。所以这里宁可少发一些旧上下文，
 * 也要保住用户明确点过的扩展能力：
 * - 历史附件（图片和文档）都不进入本次请求：正文与原件都还在本地，只是这次不带；
 * - 从最旧的轮次开始丢，用 folded 集合让 toRequestMessages 跳过，绝不写回会话；
 * - 至少保留最近一轮历史，本轮提问的附件保留（用户刚发的文件不能悄悄丢掉）。
 * 返回 null 表示裁完仍然装不下（例如本轮提问本身就超限），调用方走原有的降级路径。
 */
const trimHistoryForExtended = (
  session: Session,
  history: Message[],
  question: UserMessage,
  folded: ReadonlySet<string>
): { history: Message[]; folded: Set<string>; tokens: number } | null => {
  const rounds = getContextRounds(history).filter(([, reply]) => !folded.has(reply.id))
  // 系统提示、记忆笔记与协议头的固定开销：总用量减去历史轮次，剩下的就是它
  const fixedTokens =
    getContextUsage(session).usedTokens -
    rounds.reduce(
      (sum, [user, reply]) => sum + estimateMessageTokens(user) + estimateMessageTokens(reply),
      0
    )
  const questionTokens = estimateMessageTokens(question)
  // 连「系统提示 + 记忆 + 本轮提问」都超过硬上限：没有裁剪空间，别伪装成功
  if (fixedTokens + questionTokens > EXTENDED_INPUT_LIMIT_TOKENS) {
    return null
  }
  // 历史附件一律先踢掉（图片按官方惯例 1024 token，文档按体积折算，都是大头），正文照旧保留
  const stripped = rounds.map(([user, reply]) => ({
    replyId: reply.id,
    tokens: estimateMessageTokens({ ...user, files: [] }) + estimateMessageTokens(reply),
  }))
  const budget = EXTENDED_INPUT_LIMIT_TOKENS - EXTENDED_TRIM_MARGIN_TOKENS
  const droppedReplyIds: string[] = []
  let keptCount = 0
  let tokens = fixedTokens + questionTokens
  for (let index = stripped.length - 1; index >= 0; index--) {
    const next = tokens + stripped[index].tokens
    if (next > budget) {
      if (keptCount > 0) {
        // 预算不够了：这一条和更旧的轮次都不用发了
        droppedReplyIds.push(...stripped.slice(0, index + 1).map((round) => round.replyId))
        break
      }
      // 最近一轮就吃满安全预算：本地估算偏保守，只要没超硬上限就先留着
      if (next > EXTENDED_INPUT_LIMIT_TOKENS) {
        return null
      }
    }
    tokens = next
    keptCount += 1
  }
  // 什么都没裁掉（例如超限来自本轮提问自身）：交回现有降级逻辑，不制造假动作
  if (droppedReplyIds.length === 0 && !rounds.some(([user]) => user.files.length > 0)) {
    return null
  }
  const foldedForRequest = new Set(folded)
  for (const id of droppedReplyIds) {
    foldedForRequest.add(id)
  }
  return {
    history: history.map((message) =>
      message.role === 'user' && message.files.length > 0 ? { ...message, files: [] } : message
    ),
    folded: foldedForRequest,
    tokens,
  }
}

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  if (!getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  /** 撞上扩展模式的 32768 token 上限后，本轮改用标准模式重发一次（估算可能偏小） */
  let standardForced = false
  /** 本轮为保住扩展能力裁剪了上下文：确认请求被接受后再提示，失败时别给误导信息 */
  let trimmedForExtended = false
  try {
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      try {
        const prepared = await prepareFiles(sessionId, request, controller.signal)
        preparing = false
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        // 上下文快满（比如刚导入的超长会话）时先整理一轮再发，否则服务端必然拒绝
        const snapshot = getSession(sessionId)
        // 护栏估算必须含附件：一份 785 KB 的 txt 就是 17 万 token，
        // 只算文字会让「堆了几份文档」的会话悄悄冲过 104.8 万的上限。
        const guardTokens = snapshot
          ? getContextUsage(snapshot).usedTokens + estimateMessageTokens(prepared.question)
          : estimateMessageTokens(prepared.question)
        if (snapshot && guardTokens > CONTEXT_GUARD_TOKENS) {
          // 用户关掉自动整理时不再替他整理，直接说明；开着就先自动整一轮再发
          if (useSettings.getState().autoMemory) {
            await compactSessionMemory(sessionId, 'auto', {
              duringStream: true,
              keep: 1,
              minimum: 1,
            })
          }
          const after =
            getContextUsage(getSession(sessionId) ?? snapshot).usedTokens +
            estimateMessageTokens(prepared.question)
          if (after > CONTEXT_BLOCK_TOKENS) {
            reply = settleReply(reply, 'error', Date.now(), {
              kind: 'protocol',
              message: '',
              localMessage: { key: 'replyContextFull', params: { tokens: after } },
            })
            break
          }
        }
        const activeSession = getSession(sessionId)
        const prefs = useSettings.getState()
        // getContextUsage 只统计「提问 + 有回答」的成对轮次，本轮提问还没成形，
        // 得单独加上，否则带附件的长文档会被算成 0，永远触发不了降级判断。
        const requestTokens =
          (activeSession ? getContextUsage(activeSession).usedTokens : 0) +
          estimateMessageTokens(prepared.question)
        const folded = activeSession ? getFoldedIds(activeSession) : undefined
        /**
         * 本轮用户明确点了联网 / 提问带链接 / 开着严格审查时，宁可裁掉较早的上下文也要保住这些能力：
         * 服务端扩展模式只有 32768 token，不裁的话「发过一次大文档」就会让联网从此被悄悄关掉。
         * 裁剪只影响这一次请求，历史附件和轮次都不写回会话；估算仍偏小时走下面的 400 兜底。
         */
        const trimmed =
          activeSession &&
          !standardForced &&
          requestTokens > EXTENDED_INPUT_LIMIT_TOKENS &&
          wantsExtendedRequest({
            questionText: prepared.question.content,
            search: initial.search ?? false,
            safety: prefs.safety,
          })
            ? trimHistoryForExtended(
                activeSession,
                prepared.history,
                prepared.question,
                folded ?? new Set<string>()
              )
            : null
        trimmedForExtended = trimmed !== null
        const messages = toRequestMessages(
          trimmed ? trimmed.history : prepared.history,
          prepared.question,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder,
          trimmed ? trimmed.folded : folded,
          // v4 pro 不支持图片：历史里的图片块直接不发（用户选择「发得出去但看不见图」）
          initial.model === 'deepseek-v4-pro'
        )
        // 请求体只从这里出去：扩展模式的四道闸门（工具 / 严格审查 / 标题 / 长输入）
        // 全在 buildRequest 里统一判定，别再往这里加字段。
        const built = buildRequest({
          model: initial.model ?? currentModel(),
          system: buildSystemPrompt(
            SYSTEM_PROMPT,
            renderMemorySection(activeSession?.memory, prefs.locale),
            (() => {
              const entry = resolveSessionPersona(sessionId).entry
              return entry === null
                ? null
                : { card: entry.card, userName: usePersona.getState().userName }
            })()
          ),
          messages,
          questionText: prepared.question.content,
          search: initial.search ?? false,
          safety: prefs.safety,
          thinking: initial.thinking ?? false,
          effort: prefs.thinkingEffort,
          wantTitle: titleRequests.has(controller),
          // 传裁剪后的估算值：degraded 只该反映「真的降级了」，裁完还能联网就不算降级
          inputTokens: trimmed ? trimmed.tokens : requestTokens,
          forceStandard: standardForced,
        })
        if (built.degraded) {
          // 自动降级要说得清楚：用户可能刚点了联网，不能悄悄当没点
          showToast({
            key: 'replyExtendedDowngraded',
            params: { chars: Math.max(1, Math.round(charsForTokens(requestTokens) / 10_000)) },
          })
        }
        // 没要到服务端标题时本地兜一个，免得会话一直叫「新对话」
        if (titleRequests.has(controller) && !built.titleRequested) {
          titleRequests.delete(controller)
          const fallback = prepared.question.content.trim().replace(/\s+/g, ' ')
          if (fallback) {
            updateSession(sessionId, (session) =>
              session.title ? session : { ...session, title: fallback.slice(0, 20) }
            )
          }
        }
        const events = streamMessage(prefs.apiKey ?? '', built.body, controller.signal)
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          // 等服务端真的开始响应再提示：请求被拒时这条「已自动裁剪」的说明会误导用户
          if (trimmedForExtended) {
            showToast({ key: 'replySearchTrimmed' })
            trimmedForExtended = false
          }
          receivedContent ||= event.type === 'content_block_start'
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        reply = settleReply(reply, 'done', Date.now())
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 扩展模式的 32768 输入上限：报这个错时本轮退回标准模式重发一次，别让用户看到红字
        if (
          !standardForced &&
          !receivedContent &&
          error instanceof ApiError &&
          error.status === 400 &&
          /user input too long/i.test(error.message)
        ) {
          standardForced = true
          continue
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
    // 这一轮的真实花费会体现在余额里，顺手刷新一下（同一分钟内复用结果）
    void import('../balance.js').then((module) => module.refreshBalanceIfStale())
    void maybeAutoCompactMemory(sessionId)
  }
}
