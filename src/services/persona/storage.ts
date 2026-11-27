import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { openDB, type IDBPDatabase } from 'idb'
import { platform } from '../platform.js'
import type { PersonaEntry } from './store.js'

const NATIVE_DIR = 'ds-lite'
const NATIVE_PATH = `${NATIVE_DIR}/personas.json`
const IDB_NAME = 'ds-lite-personas'
const IDB_STORE = 'state'
const IDB_KEY = 'cards'

export type PersonaPersistence = {
  loadCards: () => Promise<PersonaEntry[] | null>
  saveCards: (cards: PersonaEntry[]) => Promise<void>
}

let idbPromise: Promise<IDBPDatabase> | null = null

const openPersonaDb = (): Promise<IDBPDatabase> =>
  (idbPromise ??= openDB(IDB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE)
      }
    },
  }))

let nativeWriteSeq = 0

const loadNativeCards = async (): Promise<PersonaEntry[] | null> => {
  try {
    const res = await Filesystem.readFile({
      path: NATIVE_PATH,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    })
    const text = typeof res.data === 'string' ? res.data : await res.data.text()
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? (parsed as PersonaEntry[]) : null
  } catch {
    return null
  }
}

const saveNativeCards = async (cards: PersonaEntry[]): Promise<void> => {
  await Filesystem.mkdir({ path: NATIVE_DIR, directory: Directory.Data, recursive: true }).catch(() => {})
  nativeWriteSeq += 1
  const tmpPath = `${NATIVE_PATH}.${Date.now()}.${nativeWriteSeq}.tmp`
  await Filesystem.writeFile({
    path: tmpPath,
    data: JSON.stringify(cards),
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  })
  await Filesystem.rename({
    from: tmpPath,
    to: NATIVE_PATH,
    directory: Directory.Data,
    toDirectory: Directory.Data,
  })
}

const loadIdbCards = async (): Promise<PersonaEntry[] | null> => {
  if (typeof indexedDB === 'undefined') {
    return null
  }
  try {
    const db = await openPersonaDb()
    const value = (await db.get(IDB_STORE, IDB_KEY)) as unknown
    return Array.isArray(value) ? (value as PersonaEntry[]) : null
  } catch {
    return null
  }
}

const saveIdbCards = async (cards: PersonaEntry[]): Promise<void> => {
  if (typeof indexedDB === 'undefined') {
    return
  }
  const db = await openPersonaDb()
  await db.put(IDB_STORE, cards, IDB_KEY)
}

const defaultPersistence: PersonaPersistence = {
  loadCards: () => (platform.hasNativeFs() ? loadNativeCards() : loadIdbCards()),
  saveCards: (cards) => (platform.hasNativeFs() ? saveNativeCards(cards) : saveIdbCards(cards)),
}

let activePersistence: PersonaPersistence = defaultPersistence

/** 仅用于自动化测试替换持久层（运行期保持默认双端引擎） */
export const setPersonaPersistenceForTest = (custom: PersonaPersistence | null): void => {
  activePersistence = custom ?? defaultPersistence
}

export const loadPersistedPersonaCards = (): Promise<PersonaEntry[] | null> =>
  activePersistence.loadCards()

export const savePersistedPersonaCards = (cards: PersonaEntry[]): Promise<void> =>
  activePersistence.saveCards(cards)
