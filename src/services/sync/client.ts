/**
 * 同步客户端单例。
 *
 * 连接的生命周期不能跟同步面板的开关绑定：面板关掉后连接要继续活着，
 * 否则用户一按返回就想断开、新消息也永远推不出去。
 */
import { SyncTransport } from './transport.js'
import { SyncEngine } from './engine.js'
import { setSyncHooks } from './bridge.js'
import { refreshSessionsFromStorage, mergeRemoteSession } from '../chat/store.js'
import { acquireKeepAlive, releaseKeepAlive } from './httpServer.js'

let transport: SyncTransport | null = null
let engine: SyncEngine | null = null
let keepAliveOn = false

/** 取（必要时创建）全局唯一的传输 + 引擎 */
export function getSyncClient(): { transport: SyncTransport; engine: SyncEngine } {
  if (!transport || !engine) {
    transport = new SyncTransport()
    engine = new SyncEngine(transport)
    setSyncHooks({
      onLocalSessionSaved: (session) => engine?.notifyLocalChange(session),
      onLocalSessionsReplaced: (sessionIds) => engine?.pushSessionIds(sessionIds),
      onRemoteSessionsChanged: () => { void refreshSessionsFromStorage() },
      // 对端会话统一交给 store 合并落盘（唯一写入者），杜绝双写覆盖
      onRemoteSessionMerge: (session) => mergeRemoteSession(session),
    })
    // 连上就开保活（息屏不断连），断开就释放
    transport.on('state', (s) => {
      if (s === 'connected' && !keepAliveOn) {
        keepAliveOn = true
        void acquireKeepAlive()
      } else if ((s === 'closed' || s === 'idle' || s === 'failed') && keepAliveOn) {
        keepAliveOn = false
        void releaseKeepAlive()
      }
    })
  }
  return { transport, engine }
}

/** 当前是否已经创建过（面板重开时用来恢复状态） */
export function peekSyncClient(): { transport: SyncTransport; engine: SyncEngine } | null {
  return transport && engine ? { transport, engine } : null
}

/** 主动断开（保留 transport/engine 实例和 UI 订阅，下次配对直接复用） */
export function disconnectSync() {
  transport?.reset()
}
