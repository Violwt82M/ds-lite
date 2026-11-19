import { useEffect, useRef, useState } from 'react'
import { Modal } from '../base/Modal.js'
import { SyncTransport, decodePairing } from '../../services/sync/transport.js'
import { SyncEngine } from '../../services/sync/engine.js'
import {
  isCapacitor, startServer, stopServer, getLocalIp,
} from '../../services/sync/httpServer.js'
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

  // 同步选项（持久化到 localStorage）
  const [syncSettings, setSyncSettings] = useState<boolean>(() => readBool('ds-sync:settings', true))
  const [syncPersona, setSyncPersona] = useState<boolean>(() => readBool('ds-sync:persona', true))
  const [syncAppearance, setSyncAppearance] = useState<boolean>(() => readBool('ds-sync:appearance', true))
  const [syncApiKey, setSyncApiKey] = useState<boolean>(() => readBool('ds-sync:apikey', false))

  // 局域网 Tab B 专用
  const [lanInfo, setLanInfo] = useState<null | { url: string; ip: string; port: number; alreadyRunning: boolean }>(null)
  const [lanUrl, setLanUrl] = useState('')

  function readBool(key: string, fallback: boolean): boolean {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v === 'true' } catch { return fallback }
  }
  function writeBool(key: string, v: boolean) { try { localStorage.setItem(key, String(v)) } catch {} }

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
    // 把 UI 开关的选项灌进 engine
    e.syncSettings = syncSettings
    e.syncPersona = syncPersona
    e.syncAppearance = syncAppearance
    e.syncApiKey = syncApiKey
    transportRef.current = t
    engineRef.current = e

    t.on('state', (s) => setState(s as TransportState))
    t.on('open', () => { log('✅ DataChannel 已打开！', 'ok') })
    t.on('message', (raw) => {
      const msg = raw as SyncMessage
      if (msg?.type === 'hello') {
        log(`👋 对方是 ${msg.device} (${msg.deviceId?.slice(0, 8)}...)`, 'info')
        log('🔄 正在自动协商同步范围...', 'info')
      } else if (msg?.type === 'ping') {
        // engine 已经处理
      }
    })

    e.on('session-written', ({ sessionId, isNew }) => {
      log(`📥 ${isNew ? '新增' : '更新'}会话 ${sessionId.slice(0, 12)}...`, 'ok')
    })
    e.on('session-diff-applied', ({ sessionId, isNew, added, updated }) => {
      const parts: string[] = []
      if (added) parts.push(`+${added}条`)
      if (updated) parts.push(`~${updated}条`)
      log(`📥 ${isNew ? '新增' : '更新'}会话 ${sessionId.slice(0, 12)}... (${parts.join(' ')})`, 'ok')
    })
    e.on('session-sent', (id) => {
      log(`📤 推送全量 ${id.slice(0, 12)}...`, 'info')
    })
    e.on('session-sent-diff', ({ sessionId, added, updated }) => {
      const parts: string[] = []
      if (added) parts.push(`+${added}条`)
      if (updated) parts.push(`~${updated}条`)
      log(`📤 推送增量 ${sessionId.slice(0, 12)}... (${parts.join(' ')})`, 'info')
    })
    e.on('settings-applied', ({ keys, from }) => {
      log(`⚙️ 收到设置 (${keys} 项, 来自 ${from})`, 'ok')
    })
    e.on('persona-applied', ({ from }) => {
      log(`🎭 收到 Persona (来自 ${from})`, 'ok')
    })
    e.on('appearance-applied', ({ from }) => {
      log(`🎨 收到外观 (来自 ${from})`, 'ok')
    })
    e.on('settings-sent', ({ keys }) => {
      log(`⚙️ 已推送设置 (${keys} 项)`, 'info')
    })
    e.on('persona-sent', () => {
      log(`🎭 已推送 Persona`, 'info')
    })
    e.on('appearance-sent', () => {
      log(`🎨 已推送外观`, 'info')
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

      {/* ============ Tab B · 局域网自动发现 ============ */}
      {tab === 'lan' && (
        <>
          {isCapacitor() ? (
            <>
              {/* APK 原生可用：启动/停止 server + 扫同 WiFi 设备 */}
              <div className={styles['sync-section']}>
                <h3>📡 本机热点</h3>
                {lanInfo ? (
                  <>
                    <div className={styles['sync-info']}>
                      本机 HTTP server 已启动：<br/>
                      <code style={{ background: '#f0f0f0', padding: '2px 6px', borderRadius: 3 }}>
                        {lanInfo.url}
                      </code>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button
                        className={styles['sync-btn']}
                        onClick={async () => {
                          try {
                            await stopServer()
                            setLanInfo(null)
                            log('🔌 本机 HTTP server 已关闭', 'info')
                          } catch (e) {
                            log('关闭失败: ' + (e as Error).message, 'err')
                          }
                        }}
                      >
                        停止热点
                      </button>
                      <button
                        className={styles['sync-btn']}
                        onClick={async () => {
                          try {
                            const r = await getLocalIp()
                            setLanInfo({ url: `http://${r.ip}:7321`, ip: r.ip, port: 7321, alreadyRunning: false })
                            log('🔄 已刷新本机 IP: ' + r.ip, 'info')
                          } catch (e) {
                            log('刷新失败: ' + (e as Error).message, 'err')
                          }
                        }}
                      >
                        刷新 IP
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className={styles['sync-info']}>
                      启动本机 HTTP server，让同 WiFi 下的其他设备能扫到你。
                    </div>
                    <button
                      className={`${styles['sync-btn']} ${styles.primary}`}
                      onClick={async () => {
                        try {
                          const r = await startServer(7321)
                          setLanInfo(r)
                          log(`✅ 本机热点已启动: ${r.url}`, 'ok')
                        } catch (e) {
                          log('启动失败: ' + (e as Error).message, 'err')
                        }
                      }}
                    >
                      启动本机热点（自动发现）
                    </button>
                  </>
                )}
              </div>

              {/* 手动输入 URL 兜底 */}
              <div className={styles['sync-section']}>
                <h3>🔗 直接连接对方</h3>
                <div className={styles['sync-info']} style={{ marginBottom: 8 }}>
                  在对方设备的同步面板里点「启动本机热点」，把它显示的 URL 粘到这里。
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className={styles['sync-input']}
                    value={lanUrl}
                    onChange={(e) => setLanUrl(e.target.value)}
                    placeholder="例如 http://192.168.49.1:7321"
                  />
                  <button
                    className={styles['sync-btn']}
                    disabled={!lanUrl || state === 'connected'}
                    onClick={async () => {
                      try {
                        log(`🔎 正在连接 ${lanUrl}...`, 'info')
                        // 简化：直接 ping 对方 /ping 端点
                        const resp = await fetch(`${lanUrl}/ping`, { method: 'GET' })
                        if (!resp.ok) throw new Error('HTTP ' + resp.status)
                        const data = await resp.json()
                        log(`✅ 发现设备: ${(data as { app?: string; deviceId?: string }).app || '未知'}`, 'ok')
                        // TODO: Phase 2A 完整版：通过这个 HTTP 交换 SDP → WebRTC 连接
                        log('（Phase 2A 完整版：还需要把 SDP 也通过这个 HTTP 交换）', 'info')
                      } catch (e) {
                        log('连接失败: ' + (e as Error).message, 'err')
                      }
                    }}
                  >
                    扫描并连接
                  </button>
                </div>
              </div>
            </>
          ) : (
            // 浏览器降级（dev server / PC 浏览器）
            <div className={styles['sync-section']}>
              <h3>⚠️ 浏览器降级模式</h3>
              <div className={styles['sync-info']} style={{ marginBottom: 12 }}>
                当前是 <b>浏览器环境</b>（不是 Android APK），Capacitor HTTP server 插件不可用。<br/>
                自动发现需要原生 Android 能力，<b>请切换到 Tab A「配对码」</b>手动交换 SDP。
              </div>
              <div className={styles['sync-info']}>
                APK 里这个 tab 会变成：<br/>
                ① 本机点「启动热点」→ 自动显示局域网 IP<br/>
                ② 同 WiFi 下另一台设备 → 直接扫到你并配对
              </div>
            </div>
          )}
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
            新会话和修改会通过 DataChannel 自动推送。
          </div>
        </div>
      )}

      {/* ============ 同步配置开关（始终可见） ============ */}
      <div className={styles['sync-section']}>
        <h3>同步内容</h3>
        <label className={styles['sync-toggle']}>
          <input
            type="checkbox"
            checked={syncSettings}
            onChange={(e) => {
              setSyncSettings(e.target.checked)
              writeBool('ds-sync:settings', e.target.checked)
              if (engineRef.current) engineRef.current.syncSettings = e.target.checked
            }}
          />
          <span>⚙️ 设置（模型 / 主题 / 语言 / 思考强度 等）</span>
        </label>
        <label className={styles['sync-toggle']}>
          <input
            type="checkbox"
            checked={syncPersona}
            onChange={(e) => {
              setSyncPersona(e.target.checked)
              writeBool('ds-sync:persona', e.target.checked)
              if (engineRef.current) engineRef.current.syncPersona = e.target.checked
            }}
          />
          <span>🎭 Persona 角色卡</span>
        </label>
        <label className={styles['sync-toggle']}>
          <input
            type="checkbox"
            checked={syncAppearance}
            onChange={(e) => {
              setSyncAppearance(e.target.checked)
              writeBool('ds-sync:appearance', e.target.checked)
              if (engineRef.current) engineRef.current.syncAppearance = e.target.checked
            }}
          />
          <span>🎨 外观（头像 / 气泡色）</span>
        </label>
        <label className={styles['sync-toggle']}>
          <input
            type="checkbox"
            checked={syncApiKey}
            onChange={(e) => {
              setSyncApiKey(e.target.checked)
              writeBool('ds-sync:apikey', e.target.checked)
              if (engineRef.current) engineRef.current.syncApiKey = e.target.checked
            }}
          />
          <span>🔑 API Key <em style={{ opacity: 0.6 }}>（谨慎开，会覆盖对方 API Key）</em></span>
        </label>
        {state === 'connected' && engineRef.current && (
          <button
            className={`${styles['sync-btn']} ${styles.primary}`}
            style={{ marginTop: 8 }}
            onClick={() => { void engineRef.current?.sendAllConfig() }}
          >
            立即重推一次配置
          </button>
        )}
      </div>

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
