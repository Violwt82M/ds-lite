import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { getBuiltinHelperEntry, isBuiltinPersona } from './builtin.js'
import type { PersonaCard } from './card.js'
import { loadPersistedPersonaCards, savePersistedPersonaCards } from './storage.js'

/** 角色库条目：id 只用于本地标识，卡片内容随条目一起保存；avatar 是本机设置的头像（data URL）；builtin 为官方内置只读卡 */
export type PersonaEntry = { id: string; card: PersonaCard; avatar?: string; builtin?: boolean }

const withBuiltins = (cards: PersonaEntry[]): PersonaEntry[] => [
  getBuiltinHelperEntry(),
  ...cards.filter((entry) => !entry.builtin && !isBuiltinPersona(entry.id)),
]

const stripBuiltins = (cards: PersonaEntry[]): PersonaEntry[] =>
  cards.filter((entry) => !entry.builtin && !isBuiltinPersona(entry.id))

/** 本机角色扮演状态：轻量偏好存 localStorage，角色卡与头像存 IndexedDB / 安卓私有目录 */
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

/** 轻量偏好（不含大体积角色卡与头像，避免挤爆 localStorage 5MB 上限） */
type PersonaPrefs = Pick<PersonaState, 'enabled' | 'userName' | 'activeId' | 'showAvatar'>

const LEGACY_STORAGE_KEY = 'ds-lite:persona'
const PREFS_STORAGE_KEY = 'ds-lite:persona-prefs'

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

const readLegacyPayload = (): { prefs: Partial<PersonaPrefs>; cards: PersonaEntry[] } | null => {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<PersonaState>
    const userCards = Array.isArray(parsed.cards) ? parsed.cards.filter(isEntry) : []
    return {
      prefs: {
        enabled: parsed.enabled === true,
        userName: typeof parsed.userName === 'string' ? parsed.userName : '',
        activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
        showAvatar: parsed.showAvatar === true,
      },
      cards: stripBuiltins(userCards),
    }
  } catch {
    return null
  }
}

const readPrefs = (): Partial<PersonaPrefs> => {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Partial<PersonaPrefs>
    return {
      enabled: parsed.enabled === true,
      userName: typeof parsed.userName === 'string' ? parsed.userName : '',
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
      showAvatar: parsed.showAvatar === true,
    }
  } catch {
    return {}
  }
}

const writePrefs = (state: PersonaState): void => {
  try {
    const prefs: PersonaPrefs = {
      enabled: state.enabled,
      userName: state.userName,
      activeId: state.activeId,
      showAvatar: state.showAvatar,
    }
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 存储不可用时不阻断使用
  }
}

/** 同步读取首帧状态：优先读轻量偏好，若尚有旧版 localStorage 角色卡则先兜底展示，随后异步迁入大仓库 */
const readInitialState = (): PersonaState => {
  const legacy = readLegacyPayload()
  const prefs = readPrefs()
  const hasNewPrefs = localStorage.getItem(PREFS_STORAGE_KEY) !== null
  const sourcePrefs = hasNewPrefs ? prefs : (legacy?.prefs ?? prefs)
  const cards = withBuiltins(legacy?.cards ?? [])
  const preferredActiveId = sourcePrefs.activeId ?? null
  const activeId =
    preferredActiveId && cards.some((entry) => entry.id === preferredActiveId)
      ? preferredActiveId
      : preferredActiveId
  return {
    enabled: sourcePrefs.enabled === true && activeId !== null,
    userName: typeof sourcePrefs.userName === 'string' ? sourcePrefs.userName : '',
    cards,
    activeId,
    showAvatar: sourcePrefs.showAvatar === true,
  }
}

export const usePersona = create<PersonaState>(() => readInitialState())

let writeChain: Promise<void> = Promise.resolve()
let localMutated = false
let hydrationPromise: Promise<void> | null = null

const enqueueCardsSave = (cards: PersonaEntry[]): Promise<void> => {
  const clean = stripBuiltins(cards)
  writeChain = writeChain
    .catch(() => {})
    .then(() => savePersistedPersonaCards(clean))
    .catch(() => {
      // 持久层暂不可用时不阻断内存交互
    })
  return writeChain
}

/**
 * 异步从 IndexedDB / 安卓私有目录加载角色库，并幂等迁移旧 localStorage 数据：
 * - 若大仓库已有数据：合并回内存并清理旧 localStorage 大对象，彻底释放 5MB 配额；
 * - 若大仓库为空且旧 localStorage 有角色卡：迁入大仓库并瘦身旧 key。
 */
export const initPersonaStore = (): Promise<void> => {
  if (hydrationPromise) {
    return hydrationPromise
  }
  hydrationPromise = (async () => {
    const persisted = await loadPersistedPersonaCards()
    const legacy = readLegacyPayload()
    const persistedValid = Array.isArray(persisted) ? stripBuiltins(persisted.filter(isEntry)) : null

    if (persistedValid !== null) {
      // 若加载期间用户已新增/修改过卡片，以内存为准合并，绝不回滚用户刚做的修改
      const current = usePersona.getState()
      const mergedUserCards = localMutated
        ? [
            ...stripBuiltins(current.cards),
            ...persistedValid.filter((p) => !current.cards.some((c) => c.id === p.id)),
          ]
        : persistedValid
      const cards = withBuiltins(mergedUserCards)
      const activeId = cards.some((entry) => entry.id === current.activeId) ? current.activeId : null
      const next: PersonaState = {
        ...current,
        cards,
        activeId,
        enabled: current.enabled && activeId !== null,
      }
      usePersona.setState(next)
      writePrefs(next)
      if (localMutated) {
        await enqueueCardsSave(next.cards)
      }
      // 迁移完成后移除旧大体积 key，释放 localStorage 配额
      if (legacy) {
        try {
          localStorage.removeItem(LEGACY_STORAGE_KEY)
        } catch {
          // 忽略清理异常
        }
      }
      return
    }

    // 大仓库尚无数据：若旧 localStorage 有自定义角色卡，自动迁移落盘
    if (legacy && legacy.cards.length > 0) {
      const current = usePersona.getState()
      const cardsToSave = localMutated ? current.cards : withBuiltins(legacy.cards)
      await savePersistedPersonaCards(stripBuiltins(cardsToSave))
      writePrefs(current)
      try {
        localStorage.removeItem(LEGACY_STORAGE_KEY)
      } catch {
        // 忽略清理异常
      }
    } else {
      // 校准初始 activeId（防止指向已删除卡片）
      const current = usePersona.getState()
      const activeId = current.cards.some((entry) => entry.id === current.activeId)
        ? current.activeId
        : null
      if (activeId !== current.activeId) {
        const next = { ...current, activeId, enabled: current.enabled && activeId !== null }
        usePersona.setState(next)
        writePrefs(next)
      }
    }
  })()
  return hydrationPromise
}

/** 仅供测试重置内部状态 */
export const resetPersonaStoreForTest = (): void => {
  hydrationPromise = null
  localMutated = false
  writeChain = Promise.resolve()
  usePersona.setState(readInitialState())
}

/** 等待当前挂起的角色库异步写盘完成（供测试与退出前收口） */
export const flushPersonaWrites = (): Promise<void> => writeChain

/** 写入偏好到 localStorage，角色卡数组异步串行写入 IndexedDB / 安卓私有目录 */
const commit = (patch: Partial<PersonaState>) => {
  localMutated = true
  const next = { ...usePersona.getState(), ...patch }
  usePersona.setState(patch)
  writePrefs(next)
  if ('cards' in patch) {
    void enqueueCardsSave(next.cards)
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
  if (isBuiltinPersona(id)) {
    return
  }
  const state = usePersona.getState()
  const cards = state.cards.filter((entry) => entry.id !== id)
  const activeId = state.activeId === id ? (cards.find((entry) => !entry.builtin)?.id ?? null) : state.activeId
  commit({ cards, activeId, enabled: activeId !== null ? state.enabled : false })
}

export const setActivePersona = (id: string) => {
  if (usePersona.getState().cards.some((entry) => entry.id === id)) {
    commit({ activeId: id })
  }
}

/** 新建（id 为 null）或覆盖保存一张卡；新建的卡自动成为当前角色并启用 */
export const savePersonaCard = (id: string | null, card: PersonaCard): string => {
  if (id !== null && isBuiltinPersona(id)) {
    return id
  }
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
  if (isBuiltinPersona(id)) {
    return
  }
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

/**
 * 合并来自备份包 / 快传包的自定义人设卡：
 * 只追加本机没有的 id（绝不覆盖本机已有的角色卡），若本机未设置称呼则补填称呼。
 */
export const mergeImportedPersonas = (incoming: unknown[], userName?: string): number => {
  const state = usePersona.getState()
  const existingIds = new Set(state.cards.map((entry) => entry.id))
  const toAdd: PersonaEntry[] = []
  for (const item of incoming) {
    if (!isEntry(item) || item.builtin || isBuiltinPersona(item.id) || existingIds.has(item.id)) {
      continue
    }
    existingIds.add(item.id)
    toAdd.push({
      id: item.id,
      card: item.card,
      ...(item.avatar ? { avatar: item.avatar } : {}),
    })
  }
  const nextUserName =
    !state.userName.trim() && typeof userName === 'string' && userName.trim()
      ? userName.trim()
      : state.userName
  if (toAdd.length === 0 && nextUserName === state.userName) {
    return 0
  }
  commit({
    cards: [...state.cards, ...toAdd],
    userName: nextUserName,
  })
  return toAdd.length
}
