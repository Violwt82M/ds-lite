import type { Session, SessionSummary } from './types.js'
import type { SessionSearchDocs } from './db.js'

export type StoredFileEntry = {
  id: string
  blob: Blob
}

/**
 * 统一的会话存储端口接口：
 * 安卓私有文件引擎（nativeDb）与网页 IndexedDB 引擎（db）共同遵循同一套契约，
 * 便于写后读校验、后续替换引擎以及自动化测试注入故障桩。
 */
export type StoragePort = {
  loadSessionSummaries: () => Promise<SessionSummary[]>
  loadSession: (id: string) => Promise<Session | undefined>
  saveSessionRecord: (session: Session) => Promise<void>
  saveSessionFiles: (files: StoredFileEntry[]) => Promise<void>
  loadFile: (id: string) => Promise<Blob | undefined>
  renameSession: (id: string, title: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  loadAllSearchDocs: () => Promise<SessionSearchDocs[]>
  saveSearchDocs: (docs: SessionSearchDocs) => Promise<void>
}

export class StorageVerifyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageVerifyError'
  }
}

/**
 * 写后读校验：每次 saveSessionRecord 成功后立刻读回同一会话，核对关键 header
 * （id / updatedAt / messages.length），防止底层静默丢写或截断而不报警。
 */
export const verifySavedSessionHeader = async (
  readBack: (id: string) => Promise<Session | undefined>,
  expected: Pick<Session, 'id' | 'updatedAt' | 'messages'>
): Promise<void> => {
  const actual = await readBack(expected.id)
  if (!actual) {
    throw new StorageVerifyError(`写后读校验失败：会话 ${expected.id} 未落盘`)
  }
  if (
    actual.id !== expected.id ||
    actual.updatedAt !== expected.updatedAt ||
    actual.messages.length !== expected.messages.length
  ) {
    throw new StorageVerifyError(
      `写后读校验不一致：会话 ${expected.id} 期望 ${expected.messages.length} 条@${expected.updatedAt}，实际 ${actual.messages.length} 条@${actual.updatedAt}`
    )
  }
}

let customPortForTest: StoragePort | null = null

/** 仅用于自动化测试替换底层存储端口 */
export const setStoragePortForTest = (port: StoragePort | null): void => {
  customPortForTest = port
}

export const getCustomStoragePort = (): StoragePort | null => customPortForTest
