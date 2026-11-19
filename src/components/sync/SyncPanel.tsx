import { useEffect, useRef, useState } from 'react'
import { Modal } from '../base/Modal.js'
import { SyncTransport, decodePairing } from '../../services/sync/transport.js'
import { SyncEngine } from '../../services/sync/engine.js'
import type { SyncMessage } from '../../services/sync/protocol.js'
import { closeSyncPanel, useSyncPanel } from './syncPanelState.js'
import styles from './SyncPanel.module.css'

type Tab = 'code' | 'lan'
type Role = null | 'host' | 'guest'
type TransportState = 'idle' | 'offer_generated' | 'connecting' | 'connected' | 'closed' | 'failed'

interface LogEntry { time: string; text: string; cls?: string }

interface EnvCheck {
  webRTC: 'ok' | 'no' | 'unknown'
  secureContext: 'ok' | 'no' | 'unknown'
  details: string
}

export function SyncPanel() {
  const [tab, setTab] = useState<Tab>('code')
  const [role, setRole] = useState<Role>(null)
  const [state, setState] = useState<TransportState>('idle')
  const [localCode, setLocalCode] = useState('')
  const [remoteCode, setRemoteCode] = useState('')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [pongMs, setPongMs] = useState<number | null>(null)
  const [errorBanner, setErrorBanner] = useState<string | null>(null)
  const [env, setEnv] = useState<EnvCheck>({ webRTC: 'unknown', secureContext: 'unknown', details: '' })

  // 环境预检（挂载时跑一次）
  useEffect(() => {
    const hasRTCPeer = typeof window.RTCPeerConnection !== 'undefined' || typeof window.webkitRTCPeerConnection !== 'undefined'
    const secure = window.isSecureContext
    const ua = navigator.userAgent
    setEnv({
      webRTC: hasRTCPeer ? 'ok' : 'no',
      secureContext: secure ? 'ok' : 'no',
      details: `WebRTC=${hasRTCPeer ? '✅' : '❌'}, SecureContext=${secure ? '✅' : '❌'}, UA=${ua.slice(0, 60)}`,
    })
    if (!hasRTCPeer) setErrorBanner('当前浏览器不支持 WebRTC，请换 Chrome / Edge / Safari')
    else if (!secure) setErrorBanner('⚠️ 当前页面不是安全上下文（非 HTTPS / 非 localhost），部分浏览器会拦截 WebRTC')
  }, [])

  // LAN 模式
  const [lanUrl, setLanUrl] = useState('http://192.168.1.100:7321')
  const [offerInput, setOfferInput] = useState('')
  const [answerInput, setAnswerInput] = useState('')

  const transportRef = useRef<SyncTransport | null>(null)
  const engineRef = useRef<SyncEngine | null>(null)

  function log(text: string, cls?: string) {
    const time = new Date().toLocaleTimeString()
    setLogs((prev) => [...prev, { time, text, cls }].slice(-100))
  }

  function ensureTransport(): SyncTransport {
    if (transportRef.current) return transportRef.current
    const t = new SyncTransport()
    const e = new SyncEngine(t)
    transportRef.current = t
    engineRef.current = e

    t.on('state', (s) => setState(s as TransportState))
    t.on('open', () => { log('✅ DataChannel 已打开！', 'ok') })
    t.on('message', (raw) => {
      const msg = raw as SyncMessage
      if (msg?.type === 'hello') {
        log(`👋 对方是 ${msg.device} (${msg.deviceId?.slice(0, 8)}...)`, 'info')
        // 自动推送所有会话
        void engineRef.current?.pushAll()
      } else if (msg?.type === 'ping') {
        // engine 已经处理
      }
    })

    e.on('session-written', ({ sessionId, isNew }) => {
      log(`📥 ${isNew ? '新增' : '更新'}会话 ${sessionId.slice(0, 12)}...`, 'ok')
    })
    e.on('session-sent', (id) => {
      log(`📤 推送会话 ${id.slice(0, 12)}...`, 'info')
    })
    e.on('skipped', ({ reason }) => {
      log(`⏭️ 跳过：${reason}`, 'info')
    })
    e.on('pong', (ms) => setPongMs(ms as number))
    e.on('error', (m) => log('❌ ' + m, 'err'))
    e.on('peer-error', (m) => log('对方报错: ' + m, 'err'))

    return t
  }

  async function copyText(text: string) {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      log('已复制到剪贴板', 'info')
    } catch {
      log('复制失败，请手动长按选中', 'err')
    }
  }

  // ============ Tab A: 配对码 ============

  async function createOffer() {
    try {
      setErrorBanner(null)
      if (env.webRTC !== 'ok') throw new Error('浏览器不支持 WebRTC')
      const t = ensureTransport()
      setRole('host')
      const code = await t.createPairingCode()
      setLocalCode(code)
      log('✅ Offer 已生成，把上面的码发给对方', 'ok')
    } catch (e) {
      const msg = '❌ 创建 Offer 失败: ' + (e as Error).message
      setErrorBanner(msg)
      log(msg, 'err')
    }
  }

  async function applyRemoteOffer() {
    try {
      const t = ensureTransport()
      setRole('guest')
      const answer = await t.applyPairingCode(remoteCode.trim())
      if (answer) {
        setLocalCode(answer)
        log('✅ Answer 已生成，把码发回给 Host', 'ok')
      }
    } catch (e) {
      log('❌ 应用 Offer 失败: ' + (e as Error).message, 'err')
    }
  }

  async function applyRemoteAnswer() {
    try {
      const t = transportRef.current!
      if (!t) throw new Error('请先点「生成 Offer」')
      await t.applyPairingCode(localCode ? '' + remoteCode.trim() : remoteCode.trim())
      log('✅ Answer 已设置，等待连接...', 'ok')
    } catch (e) {
      log('❌ 设置 Answer 失败: ' + (e as Error).message, 'err')
    }
  }

  // ============ Tab B: 局域网 HTTP ============
  // Phase 1 简化：LAN HTTP 适配器的 fetch/post 函数已经在 transport.ts 里导出，
  // 这里让用户手动输入对方的局域网 URL。Phase 2 再接 Capacitor 原生 server 自动发现。

  // ============ 通用 ============

  async function pushSessionNow() {
    if (!engineRef.current) { log('还没连接', 'err'); return }
    // 简单：推全部
    await engineRef.current.pushAll()
    log('📤 已触发全量推送', 'info')
  }

  function disconnect() {
    transportRef.current?.close()
    transportRef.current = null
    engineRef.current = null
    setRole(null); setState('idle'); setLocalCode(''); setRemoteCode('')
    log('🔌 已断开', 'info')
  }

  useEffect(() => () => disconnect(), [])

  const stateText: Record<TransportState, string> = {
    idle: '未连接',
    offer_generated: '等待对方回应',
    connecting: '连接中...',
    connected: '✅ 已连接',
    closed: '已关闭',
    failed: '❌ 连接失败',
  }
  const stateCls: Record<TransportState, string> = {
    idle: '', offer_generated: 'wait', connecting: 'wait',
    connected: 'ok', closed: '', failed: 'err',
  }

  return (
    <div className={styles['sync-panel']}>
      <div>
        <h2>📡 DS Lite 局域网同步</h2>
        <div className={styles['sync-status']}>
          <span className={`${styles['sync-dot']} ${styles[stateCls[state]]}`}></span>
          {stateText[state]} {role && `（${role === 'host' ? '房主' : '加入者'}）`}
          {pongMs !== null && ` · RTT ${pongMs}ms`}
        </div>
      </div>

      {/* 环境预检 —— 挂载时立刻显示 */}
      <div className={styles['sync-section']}>
        <h3>🔍 环境检测</h3>
        <div className={styles['sync-info']}>
          WebRTC: <b>{env.webRTC === 'ok' ? '✅ 支持' : env.webRTC === 'no' ? '❌ 不支持' : '...'}</b> &nbsp;
          安全上下文: <b>{env.secureContext === 'ok' ? '✅' : env.secureContext === 'no' ? '⚠️ 非安全（http://IP）' : '...'}</b>
        </div>
        {env.secureContext === 'no' && (
          <div className={styles['sync-info']} style={{ color: '#ff4d4f', marginTop: 6, fontSize: 11 }}>
            ⚠️ 手机浏览器（Chrome/Safari）在 <code>http://IP地址:端口</code> 下会把 WebRTC 部分 API 标成实验性。
            如果创建 Offer 报错，尝试：① 电脑上用 localhost 测试 ② 或给 dev server 配 HTTPS
          </div>
        )}
      </div>

      {/* 显眼的红色错误条 */}
      {errorBanner && (
        <div style={{ background: '#fff2f0', border: '1px solid #ffccc7', color: '#cf1322', padding: '10px 12px', borderRadius: 8, fontSize: 13, fontWeight: 500 }}>
          {errorBanner}
        </div>
      )}

      <div className={styles['sync-tab']}>
        <button
          className={tab === 'code' ? styles.active : ''}
          onClick={() => setTab('code')}
        >A · 配对码</button>
        <button
          className={tab === 'lan' ? styles.active : ''}
          onClick={() => setTab('lan')}
        >B · 局域网 URL</button>
      </div>

      {/* ============ Tab A ============ */}
      {tab === 'code' && (
        <>
          {role === null && (
            <div className={styles['sync-section']}>
              <h3>你是哪一方？</h3>
              <div className={styles['sync-row']}>
                <button className={`${styles['sync-btn']} ${styles.primary}`} onClick={createOffer}>
                  我是房主，生成配对码
                </button>
                <button
                  className={styles['sync-btn']}
                  onClick={() => { setRole('guest'); log('请在下面粘贴房主发来的码，然后点「应用 Offer」', 'info') }}
                >
                  我是加入者，粘贴对方的码
                </button>
              </div>
            </div>
          )}

          {role === 'host' && (
            <>
              <div className={styles['sync-section']}>
                <h3>① 本地 Offer（发给加入者）</h3>
                <textarea readOnly value={localCode} placeholder="自动生成..." rows={4} />
                <div className={styles['sync-row']}>
                  <button className={styles['sync-btn']} onClick={() => copyText(localCode)} disabled={!localCode}>
                    复制
                  </button>
                  <button
                    className={styles['sync-btn']}
                    onClick={() => {
                      if (localStorage.getItem('ds-sync-code')) {
                        localStorage.setItem('ds-sync-code', localCode)
                        log('✅ 已存到 localStorage', 'info')
                      }
                    }}
                    disabled={!localCode}
                  >
                    存到本地
                  </button>
                </div>
              </div>

              <div className={styles['sync-section']}>
                <h3>② 加入者的 Answer</h3>
                <textarea
                  value={remoteCode}
                  onChange={(e) => setRemoteCode(e.target.value)}
                  placeholder="粘贴对方发回的 Answer 码..."
                  rows={4}
                />
                <div className={styles['sync-row']}>
                  <button
                    className={`${styles['sync-btn']} ${styles.primary}`}
                    onClick={applyRemoteAnswer}
                    disabled={!remoteCode.trim() || state === 'connected'}
                  >
                    设置 Answer → 连接！
                  </button>
                </div>
              </div>
            </>
          )}

          {role === 'guest' && (
            <>
              <div className={styles['sync-section']}>
                <h3>① 房主的 Offer</h3>
                <textarea
                  value={remoteCode}
                  onChange={(e) => setRemoteCode(e.target.value)}
                  placeholder="粘贴房主发来的码..."
                  rows={4}
                />
                <button
                  className={`${styles['sync-btn']} ${styles.primary}`}
                  onClick={applyRemoteOffer}
                  disabled={!remoteCode.trim() || state === 'connected'}
                >
                  应用 Offer → 生成 Answer
                </button>
              </div>

              <div className={styles['sync-section']}>
                <h3>② 本地 Answer（发回给房主）</h3>
                <textarea readOnly value={localCode} placeholder="自动生成..." rows={4} />
                <div className={styles['sync-row']}>
                  <button className={styles['sync-btn']} onClick={() => copyText(localCode)} disabled={!localCode}>
                    复制
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ============ Tab B ============ */}
      {tab === 'lan' && (
        <>
          <div className={styles['sync-section']}>
            <h3>局域网自动发现</h3>
            <div className={styles['sync-info']} style={{ marginBottom: 8 }}>
              ⚠️ <b>Phase 2 功能，暂不可用</b>。<br/>
              现在请切换到 Tab A「配对码」，手动交换一次 SDP 即可连通。<br/>
              Phase 2 会加 Capacitor 原生 HTTP server 插件 + WiFi Direct 自动发现。
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className={styles['sync-input']}
                value={lanUrl}
                onChange={(e) => setLanUrl(e.target.value)}
                placeholder="（Phase 2 启用）对方 HTTP URL"
                disabled
              />
              <button
                className={styles['sync-btn']}
                disabled
                title="Phase 2 实现"
              >
                连接（不可用）
              </button>
            </div>
          </div>
        </>
      )}

      {/* ============ 连接后操作 ============ */}
      {state === 'connected' && (
        <div className={styles['sync-section']}>
          <h3>已连接 · 可以同步了</h3>
          <div className={styles['sync-row']}>
            <button className={`${styles['sync-btn']} ${styles.primary}`} onClick={pushSessionNow}>
              推送全部会话 → 对方
            </button>
            <button className={styles['sync-btn']} onClick={disconnect}>
              断开连接
            </button>
          </div>
          <div className={styles['sync-info']} style={{ marginTop: 8 }}>
            新会话和修改会通过 DataChannel 自动推送（当前版本是 Session 全量同步）。
          </div>
        </div>
      )}

      {/* 日志 */}
      <div className={styles['sync-section']}>
        <h3>连接日志</h3>
        <div className={styles['sync-log']}>
          {logs.length === 0 && <span style={{ color: '#666' }}>暂无日志...</span>}
          {logs.map((l, i) => (
            <div key={i} className={styles[l.cls ?? 'info']}>[{l.time}] {l.text}</div>
          ))}
        </div>
      </div>

      {/* 通用断开 */}
      {state !== 'closed' && state !== 'idle' && (
        <button className={`${styles['sync-btn']} ${styles.danger}`} onClick={disconnect}>
          🔌 断开连接
        </button>
      )}
    </div>
  )
}

/** 同步面板对话框 —— 类似 SettingsDialog：open 时挂载 Modal，关闭时 unmount */
export const SyncDialog = () => {
  const open = useSyncPanel((s) => s.open)
  if (!open) return null
  return (
    <Modal title="📡 局域网同步" closable onClose={closeSyncPanel}>
      <SyncPanel />
    </Modal>
  )
}
