import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import type { PersonaCard } from './card.js'

/** 角色库条目：id 只用于本地标识，卡片内容随条目一起保存；avatar 是本机设置的头像（data URL） */
export type PersonaEntry = { id: string; card: PersonaCard; avatar?: string }

/** 本机角色扮演设置，存 localStorage；不涉及任何服务端 */
export type PersonaState = {
  /** 是否把当前角色的设定注入系统提示词 */
  enabled: boolean
  /** 玩家在卡片 {{user}} 占位符里的称呼 */
  userName: string
  cards: PersonaEntry[]
  activeId: string | null
  /** 是否在 AI 消息左上角显示角色头像；默认关闭 */
  showAvatar: boolean
}

const STORAGE_KEY = 'ds-lite:persona'

const emptyState = (): PersonaState => ({
  enabled: false,
  userName: '',
  cards: [],
  activeId: null,
  showAvatar: false,
})

const isEntry = (value: unknown): value is PersonaEntry => {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const entry = value as Partial<PersonaEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.card === 'object' &&
    entry.card !== null &&
    typeof entry.card.name === 'string' &&
    (entry.avatar === undefined || (typeof entry.avatar === 'string' && entry.avatar.startsWith('data:image/')))
  )
}

/** 读取失败或数据损坏时退回空状态，不影响应用启动 */
const readState = (): PersonaState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return emptyState()
    }
    const parsed = JSON.parse(raw) as Partial<PersonaState>
    const cards = Array.isArray(parsed.cards) ? parsed.cards.filter(isEntry) : []
    const activeId = cards.some((entry) => entry.id === parsed.activeId) ? (parsed.activeId ?? null) : null
    return {
      enabled: parsed.enabled === true && activeId !== null,
      userName: typeof parsed.userName === 'string' ? parsed.userName : '',
      cards,
      activeId,
      showAvatar: parsed.showAvatar === true,
    }
  } catch {
    return emptyState()
  }
}

export const usePersona = create<PersonaState>(() => readState())

/** 写入失败只在内存中生效，与 settings.ts 的处理保持一致 */
const commit = (patch: Partial<PersonaState>) => {
  const next = { ...usePersona.getState(), ...patch }
  usePersona.setState(patch)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 存储不可用时不阻断使用
  }
}

/** 新导入的卡片自动成为当前角色；同一张卡重复导入时替换旧的同名条目 */
export const addPersonaCard = (card: PersonaCard) => {
  const state = usePersona.getState()
  const existing = state.cards.find((entry) => entry.card.name === card.name)
  if (existing) {
    commit({
      cards: state.cards.map((entry) => (entry.id === existing.id ? { ...entry, card } : entry)),
      activeId: existing.id,
      enabled: true,
    })
    return existing.id
  }
  const entry = { id: createId(), card }
  commit({ cards: [...state.cards, entry], activeId: entry.id, enabled: true })
  return entry.id
}

export const removePersonaCard = (id: string) => {
  const state = usePersona.getState()
  const cards = state.cards.filter((entry) => entry.id !== id)
  const activeId = state.activeId === id ? (cards[0]?.id ?? null) : state.activeId
  commit({ cards, activeId, enabled: activeId !== null ? state.enabled : false })
}

export const setActivePersona = (id: string) => {
  if (usePersona.getState().cards.some((entry) => entry.id === id)) {
    commit({ activeId: id })
  }
}

/** 新建（id 为 null）或覆盖保存一张卡；新建的卡自动成为当前角色并启用 */
export const savePersonaCard = (id: string | null, card: PersonaCard): string => {
  const state = usePersona.getState()
  if (id === null) {
    const entry = { id: createId(), card }
    commit({ cards: [...state.cards, entry], activeId: entry.id, enabled: true })
    return entry.id
  }
  if (!state.cards.some((entry) => entry.id === id)) {
    const entry = { id: createId(), card }
    commit({ cards: [...state.cards, entry], activeId: entry.id, enabled: true })
    return entry.id
  }
  commit({
    cards: state.cards.map((entry) => (entry.id === id ? { ...entry, card } : entry)),
    enabled: true,
  })
  return id
}

export const setPersonaEnabled = (enabled: boolean) => commit({ enabled })

/** 头像显示开关：默认关闭，开启后 AI 消息左上角出现当前角色的头像 */
export const setPersonaShowAvatar = (showAvatar: boolean) => commit({ showAvatar })

/** 设置某张卡的头像；传 null 移除。图片已在调用侧压成小图，存进 localStorage */
export const setPersonaAvatar = (id: string, avatar: string | null) => {
  const state = usePersona.getState()
  if (!state.cards.some((entry) => entry.id === id)) {
    return
  }
  commit({
    cards: state.cards.map((entry) => {
      if (entry.id !== id) {
        return entry
      }
      return avatar === null ? { id: entry.id, card: entry.card } : { ...entry, avatar }
    }),
  })
}

export const setPersonaUserName = (userName: string) => commit({ userName })

/** 当前生效卡片的 id；未启用或卡片已被删除时返回 null（用于给回答打快照） */
export const getActivePersonaId = (): string | null => {
  const state = usePersona.getState()
  if (!state.enabled || state.activeId === null) {
    return null
  }
  return state.cards.some((entry) => entry.id === state.activeId) ? state.activeId : null
}

/** 当前生效的卡片；未启用或没有卡片时返回 null */
export const getActiveCard = (): PersonaCard | null => {
  const state = usePersona.getState()
  if (!state.enabled) {
    return null
  }
  return state.cards.find((entry) => entry.id === state.activeId)?.card ?? null
}
