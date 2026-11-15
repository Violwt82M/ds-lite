import { useMemo } from 'react'
import { create } from 'zustand'
import { usePersona, type PersonaEntry } from './store.js'

/**
 * 会话级人设绑定：每个对话自己决定用哪张卡。
 *
 * 值是卡片 id，或 'none'（这个对话不使用人设）。新对话在创建时把当时的全局设置
 * 快照进来，之后全局怎么改都不动老对话；任何对话都能随时从标题栏的「人设」按钮改。
 *
 * 存在 localStorage，不进导出 ZIP，也不改 IndexedDB 结构 —— 导入的历史会话默认「不使用」。
 */
const STORAGE_KEY = 'ds-lite:persona-scope'

type ScopeMap = Record<string, string>

const read = (): ScopeMap => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    const map: ScopeMap = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value !== '') {
        map[key] = value
      }
    }
    return map
  } catch {
    return {}
  }
}

export const usePersonaScope = create<{ map: ScopeMap }>(() => ({ map: read() }))

const commit = (map: ScopeMap) => {
  usePersonaScope.setState({ map })
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 存储不可用时只影响下次打开，不阻断当前操作
  }
}

/** 设置某个对话的人设：cardId 或 'none' */
export const setSessionPersona = (sessionId: string, scope: string) => {
  commit({ ...usePersonaScope.getState().map, [sessionId]: scope })
}

/** 卡片被删掉时顺手清理指向它的绑定，避免对话停在「人设：已删除」 */
usePersona.subscribe((state) => {
  const ids = new Set(state.cards.map((entry) => entry.id))
  const map = usePersonaScope.getState().map
  const kept = Object.entries(map).filter(([, value]) => value === 'none' || ids.has(value))
  if (kept.length !== Object.keys(map).length) {
    commit(Object.fromEntries(kept))
  }
})

export type SessionPersona = {
  /** 生效的条目；null 表示这个对话不注入人设 */
  entry: PersonaEntry | null
  cardId: string | null
}

const resolve = (cards: PersonaEntry[], scope: string | undefined): SessionPersona => {
  if (scope === undefined || scope === 'none') {
    return { entry: null, cardId: null }
  }
  const entry = cards.find((item) => item.id === scope) ?? null
  return { entry, cardId: entry?.id ?? null }
}

/**
 * 还没发第一句话时（欢迎页）选的人设：先存在这里，等会话创建时写进绑定。
 * undefined = 没选过，按全局默认走。
 */
export const usePersonaDraft = create<{ cardId: string | undefined }>(() => ({ cardId: undefined }))

export const setDraftPersona = (cardId: string | undefined) =>
  usePersonaDraft.setState({ cardId })

/** 标题栏 / 欢迎页共用：sessionId 为 null 时看「下一条新对话」 */
export const useChatPersona = (sessionId: string | null): SessionPersona => {
  const cards = usePersona((state) => state.cards)
  const enabled = usePersona((state) => state.enabled)
  const activeId = usePersona((state) => state.activeId)
  const scope = usePersonaScope((state) => (sessionId === null ? undefined : state.map[sessionId]))
  const draft = usePersonaDraft((state) => state.cardId)
  return useMemo(() => {
    if (sessionId !== null) {
      return resolve(cards, scope)
    }
    if (draft !== undefined) {
      return resolve(cards, draft)
    }
    const usable = enabled && activeId !== null && cards.some((entry) => entry.id === activeId)
    return resolve(cards, usable ? activeId : 'none')
  }, [cards, enabled, activeId, scope, draft, sessionId])
}

/** 新对话创建时写入绑定：优先用欢迎页选的，否则快照全局设置 */
export const bindPersonaForNewSession = (sessionId: string) => {
  const map = usePersonaScope.getState().map
  if (map[sessionId] !== undefined) {
    return
  }
  const { enabled, activeId, cards } = usePersona.getState()
  const draft = usePersonaDraft.getState().cardId
  // 欢迎页选过卡就直接用；卡被删了则退回全局默认
  const picked = draft !== undefined && cards.some((entry) => entry.id === draft) ? draft : undefined
  const usable = enabled && activeId !== null && cards.some((entry) => entry.id === activeId)
  const scope = picked ?? (usable ? (activeId as string) : 'none')
  commit({ ...map, [sessionId]: scope })
  if (draft !== undefined) {
    usePersonaDraft.setState({ cardId: undefined })
  }
}

/** 非响应式解析，给请求组装用 */
export const resolveSessionPersona = (sessionId: string | null): SessionPersona => {
  const cards = usePersona.getState().cards
  const scope = sessionId === null ? undefined : usePersonaScope.getState().map[sessionId]
  return resolve(cards, scope)
}

/** 界面用：当前对话的人设，随角色库与绑定变化实时更新 */
export const useSessionPersona = (sessionId: string | null): SessionPersona => {
  const cards = usePersona((state) => state.cards)
  const scope = usePersonaScope((state) => (sessionId === null ? undefined : state.map[sessionId]))
  return useMemo(() => resolve(cards, scope), [cards, scope])
}
