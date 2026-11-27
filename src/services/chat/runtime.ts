import type { StoredFile } from './db.js'

/**
 * 会话 store 的全部运行期可变状态（原散落在 store.ts 顶层的 15+ 个模块级单例）。
 * 统一收进可创建的 runtime 容器：
 * 1. 消除模块级隐藏耦合，为拆解 store.ts 铺路；
 * 2. 支持单测中通过 reset() 彻底清理状态，互不污染。
 */
export type ChatRuntime = {
  titleRequests: Set<AbortController>
  sessionAccess: Map<string, number>
  unsavedSessions: Set<string>
  pendingFiles: Map<string, StoredFile[]>
  deletingSessions: Set<string>
  deletionTasks: Set<Promise<boolean>>
  streamFlushes: Map<string, () => void>
  sessionLoads: Map<string, { promise: Promise<void> }>
  saveAttempts: Map<string, number>
  persistQueues: Map<string, Promise<void>>
  compactionTasks: Map<string, Promise<boolean>>
  memoryControllers: Map<string, AbortController>
  accessSequence: number
  historyEpoch: number
  saveAttemptSequence: number
  initTask: Promise<void> | undefined
  retryTask: Promise<boolean> | undefined
  autoRetryTimer: number | undefined
  autoRetryCount: number
  reset: () => void
}

export const createChatRuntime = (): ChatRuntime => {
  const runtime: ChatRuntime = {
    titleRequests: new Set<AbortController>(),
    sessionAccess: new Map<string, number>(),
    unsavedSessions: new Set<string>(),
    pendingFiles: new Map<string, StoredFile[]>(),
    deletingSessions: new Set<string>(),
    deletionTasks: new Set<Promise<boolean>>(),
    streamFlushes: new Map<string, () => void>(),
    sessionLoads: new Map<string, { promise: Promise<void> }>(),
    saveAttempts: new Map<string, number>(),
    persistQueues: new Map<string, Promise<void>>(),
    compactionTasks: new Map<string, Promise<boolean>>(),
    memoryControllers: new Map<string, AbortController>(),
    accessSequence: 0,
    historyEpoch: 0,
    saveAttemptSequence: 0,
    initTask: undefined,
    retryTask: undefined,
    autoRetryTimer: undefined,
    autoRetryCount: 0,
    reset() {
      for (const controller of runtime.titleRequests) {
        controller.abort()
      }
      for (const controller of runtime.memoryControllers.values()) {
        controller.abort()
      }
      runtime.titleRequests.clear()
      runtime.sessionAccess.clear()
      runtime.unsavedSessions.clear()
      runtime.pendingFiles.clear()
      runtime.deletingSessions.clear()
      runtime.deletionTasks.clear()
      runtime.streamFlushes.clear()
      runtime.sessionLoads.clear()
      runtime.saveAttempts.clear()
      runtime.persistQueues.clear()
      runtime.compactionTasks.clear()
      runtime.memoryControllers.clear()
      runtime.accessSequence = 0
      runtime.historyEpoch = 0
      runtime.saveAttemptSequence = 0
      runtime.initTask = undefined
      runtime.retryTask = undefined
      if (runtime.autoRetryTimer !== undefined) {
        clearTimeout(runtime.autoRetryTimer)
        runtime.autoRetryTimer = undefined
      }
      runtime.autoRetryCount = 0
    },
  }
  return runtime
}
