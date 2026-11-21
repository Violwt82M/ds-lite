import { isBuiltinPersona } from '../../persona/builtin.js'
import { setSessionPersona, usePersonaScope } from '../../persona/scope.js'
import { mergeImportedPersonas, usePersona, type PersonaEntry } from '../../persona/store.js'
import type { Session, SessionMemory, SessionRecord } from '../types.js'

export const DS_LITE_EXTRAS_PATH = 'ds-lite-extras.json'

export type SessionExtraData = {
  memory?: SessionMemory
  records?: SessionRecord[]
  memoryBackup?: boolean
}

export type DsLiteArchiveExtras = {
  version: 1
  sessions: Record<string, SessionExtraData>
  personas: PersonaEntry[]
  userName?: string
  personaScope: Record<string, string>
}

export const buildArchiveExtras = (sessions: Session[]): DsLiteArchiveExtras => {
  const sessionExtras: Record<string, SessionExtraData> = {}
  const exportedIds = new Set<string>()
  for (const session of sessions) {
    exportedIds.add(session.id)
    const entry: SessionExtraData = {}
    if (session.memory) {
      entry.memory = session.memory
    }
    if (session.records && session.records.length > 0) {
      entry.records = session.records
    }
    if (session.memoryBackup) {
      entry.memoryBackup = true
    }
    if (entry.memory || entry.records || entry.memoryBackup) {
      sessionExtras[session.id] = entry
    }
  }

  const personaState = usePersona.getState()
  const personas = personaState.cards
    .filter((entry) => !entry.builtin && !isBuiltinPersona(entry.id))
    .map((entry) => ({
      id: entry.id,
      card: entry.card,
      ...(entry.avatar ? { avatar: entry.avatar } : {}),
    }))

  const scopeMap = usePersonaScope.getState().map
  const personaScope: Record<string, string> = {}
  for (const [sessionId, scope] of Object.entries(scopeMap)) {
    if (exportedIds.has(sessionId) && typeof scope === 'string' && scope) {
      personaScope[sessionId] = scope
    }
  }

  return {
    version: 1,
    sessions: sessionExtras,
    personas,
    ...(personaState.userName.trim() ? { userName: personaState.userName.trim() } : {}),
    personaScope,
  }
}

export const parseArchiveExtras = (raw: unknown): DsLiteArchiveExtras | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const obj = raw as Partial<DsLiteArchiveExtras>
  if (obj.version !== 1) {
    return null
  }
  const sessions: Record<string, SessionExtraData> = {}
  if (typeof obj.sessions === 'object' && obj.sessions !== null) {
    for (const [id, value] of Object.entries(obj.sessions)) {
      if (typeof value === 'object' && value !== null) {
        sessions[id] = value
      }
    }
  }
  const personas = Array.isArray(obj.personas) ? obj.personas : []
  const personaScope: Record<string, string> = {}
  if (typeof obj.personaScope === 'object' && obj.personaScope !== null) {
    for (const [id, scope] of Object.entries(obj.personaScope)) {
      if (typeof scope === 'string' && scope) {
        personaScope[id] = scope
      }
    }
  }
  return {
    version: 1,
    sessions,
    personas,
    ...(typeof obj.userName === 'string' ? { userName: obj.userName } : {}),
    personaScope,
  }
}

export const applySessionExtras = (session: Session, extra?: SessionExtraData): Session => {
  if (!extra) {
    return session
  }
  return {
    ...session,
    ...(extra.memory ? { memory: extra.memory } : {}),
    ...(extra.records && extra.records.length > 0 ? { records: extra.records } : {}),
    ...(extra.memoryBackup ? { memoryBackup: true } : {}),
  }
}

/** 归档提交成功后合并导入的人设卡与会话人设绑定（绝不覆盖本机已有卡片） */
export const applyArchiveExtrasPersonas = (
  extras: DsLiteArchiveExtras | null,
  idMap: ReadonlyMap<string, string>
): void => {
  if (!extras) {
    return
  }
  if (extras.personas.length > 0 || extras.userName) {
    mergeImportedPersonas(extras.personas, extras.userName)
  }
  const validCardIds = new Set(usePersona.getState().cards.map((entry) => entry.id))
  for (const [originalId, savedId] of idMap) {
    const scope = extras.personaScope[originalId]
    if (scope && (scope === 'none' || validCardIds.has(scope))) {
      setSessionPersona(savedId, scope)
    }
  }
}
