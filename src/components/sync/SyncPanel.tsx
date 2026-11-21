import { useEffect, useRef, useState } from 'react'
import { Modal } from '../base/Modal.js'
import { SyncTransport } from '../../services/sync/transport.js'
import { SyncEngine } from '../../services/sync/engine.js'
import { getSyncClient, disconnectSync } from '../../services/sync/client.js'
import {
  isCapacitor, startServer, stopServer, getLocalIp,
  publishPairingOffer, clearPairingOffer, onLanAnswer,
} from '../../services/sync/httpServer.js'
import type { SyncMessage } from '../../services/sync/protocol.js'
import { closeSyncPanel, useSyncPanel } from './syncPanelState.js'
import { QrCodeView, QrScanner } from './PairingQr.js'
import styles from './SyncPanel.module.css'

type Tab = 'code' | 'lan'
type Role = null | 'host' | 'guest'
type TransportState = 'idle' | 'offer_generated' | 'connecting' | 'connected' | 'closed' | 'failed'

interface LogEntry { time: string; text: string; cls?: string }

interface EnvCheck {
  webRTC: 'ok' | 'no' | 'unknown'
  secureContext: 'ok' | 'no' | 'unknown'
  camera: boolean
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
  const [env, setEnv] = useState<EnvCheck>({ webRTC: 'unknown', secureContext: 'unknown', camera: false, details: '' })

  // 同步选项：除 API Key 外全部同步，只保留 API Key 的安全开关
  const [syncApiKey, setSyncApiKey] = useState<boolean>(() => readBool('ds-sync:apikey', false))
  /** 通用信息（设置 / 人物设定 / 外观）同步开关；会话消息始终同步 */
  const [syncGeneral, setSyncGeneral] = useState<boolean>(() => readBool('ds-sync:general', true))
  /** 仅局域网直连：不请求 STUN（国内 STUN 常被墙，会导致建码/连接失败） */
  const [lanOnly, setLanOnly] = useState<boolean>(() => readBool('ds-sync:lanonly', true))

  // 局域网 Tab B 专用
  const [lanInfo, setLanInfo] = useState<null | { url: string; ip: string; port: number; alreadyRunning: boolean }>(null)
  const [lanUrl, setLanUrl] = useState('')
  /** 当前扫码要接收的是哪一步：offer=加入者扫房主，answer=房主扫加入者 */
  const [scanTarget, setScanTarget] = useState<null | 'offer' | 'answer'>(null)
  /** 「推送全部」进度 */
  const [pushProgress, setPushProgress] = useState<null | { done: number; total: number }>(null)

  function readBool(key: string, fallback: boolean): boolean {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v === 'true' } catch { return fallback }
  }
  function writeBool(key: string, v: boolean) { try { localStorage.setItem(key, String(v)) } catch {} }

  // 环境预检（挂载时跑一次）
  useEffect(() => {
    const hasRTCPeer = typeof window.RTCPeerConnection !== 'undefined' || typeof (window as any).webkitRTCPeerConnection !== 'undefined'
    const secure = window.isSecureContext
    const canCamera = secure && typeof navigator.mediaDevices?.getUserMedia === 'function'
    const ua = navigator.userAgent
    setEnv({
      webRTC: hasRTCPeer ? 'ok' : 'no',
      secureContext: secure ? 'ok' : 'no',
      camera: canCamera,
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
    const { transport: t, engine: e } = getSyncClient()
    e.syncApiKey = syncApiKey
    e.syncSettings = syncGeneral
    e.syncPersona = syncGeneral
    e.syncAppearance = syncGeneral
    t.setLanOnly(lanOnly)
    transportRef.current = t
    engineRef.current = e
    return t
  }

  // 面板挂载时接上已有连接的事件；卸载只摘监听，不断连接
  useEffect(() => {
    const { transport: t, engine: e } = getSyncClient()
    transportRef.current = t
    engineRef.current = e
    e.syncApiKey = syncApiKey
    e.syncSettings = syncGeneral
    e.syncPersona = syncGeneral
    e.syncAppearance = syncGeneral
    t.setLanOnly(lanOnly)

    const offs: Array<() => void> = []
    offs.push(t.on('state', (s) => setState(s as TransportState)))
    offs.push(t.on('open', () => { log('✅ DataChannel 已打开！', 'ok') }))
    offs.push(t.on('candidate', (data) => {
      const c = data as { type: string; protocol: string }
      log(`📡 网络候选：${c.type}/${c.protocol}`, 'info')
    }))
    offs.push(t.on('gathering-done', () => { log('📡 网络候选收集完成', 'info') }))
    offs.push(t.on('iceState', (s) => { log(`🔗 ICE 状态：${String(s)}`, s === 'failed' ? 'err' : 'info') }))
    offs.push(t.on('connState', (s) => { log(`🔗 连接状态：${String(s)}`, 'info') }))
    offs.push(t.on('dc-open', () => { log('✅ 数据通道已就绪', 'ok') }))
    offs.push(t.on('dc-close', () => { log('⚠️ 数据通道已关闭', 'err') }))
    offs.push(t.on('dc-error', () => { log('❌ 数据通道出错', 'err') }))
    offs.push(t.on('message', (raw) => {
      const msg = raw as SyncMessage
      if (msg?.type === 'hello') {
        log(`👋 对方是 ${msg.device} (${msg.deviceId?.slice(0, 8)}...)`, 'info')
        log('🔄 正在自动协商同步范围...', 'info')
      }
    }))
    offs.push(e.on('session-written', (data) => {
      const { sessionId, isNew } = data as { sessionId: string; isNew: boolean }
      log(`📥 ${isNew ? '新增' : '更新'}会话 ${sessionId.slice(0, 12)}...`, 'ok')
    }))
    offs.push(e.on('session-diff-applied', (data) => {
      const { sessionId, isNew, added, updated } = data as { sessionId: string; isNew: boolean; added: number; updated?: number }
      const parts: string[] = []
      if (added) parts.push(`+${added}条`)
      if (updated) parts.push(`~${updated}条`)
      log(`📥 ${isNew ? '新增' : '更新'}会话 ${sessionId.slice(0, 12)}... (${parts.join(' ')})`, 'ok')
    }))
    offs.push(e.on('session-sent', (id) => {
      log(`📤 推送全量 ${String(id).slice(0, 12)}...`, 'info')
    }))
    offs.push(e.on('session-sent-diff', (data) => {
      const { sessionId, added, updated } = data as { sessionId: string; added: number; updated?: number }
      const parts: string[] = []
      if (added) parts.push(`+${added}条`)
      if (updated) parts.push(`~${updated}条`)
      log(`📤 推送增量 ${sessionId.slice(0, 12)}... (${parts.join(' ')})`, 'info')
    }))
    offs.push(e.on('settings-applied', (data) => {
      const { keys } = data as { keys: number }
      log(`⚙️ 收到设置 (${keys} 项)`, 'ok')
    }))
    offs.push(e.on('persona-applied', () => { log('🎭 收到 Persona', 'ok') }))
    offs.push(e.on('appearance-applied', () => { log('🎨 收到外观', 'ok') }))
    offs.push(e.on('settings-sent', (data) => {
      const { keys } = data as { keys: number }
      log(`⚙️ 已推送设置 (${keys} 项)`, 'info')
    }))
    offs.push(e.on('persona-sent', () => { log('🎭 已推送 Persona', 'info') }))
    offs.push(e.on('appearance-sent', () => { log('🎨 已推送外观', 'info') }))
    offs.push(e.on('skipped', (data) => {
      const { reason } = data as { reason: string }
      log(`⏭️ 跳过：${reason}`, 'info')
    }))
    offs.push(e.on('pong', (ms) => setPongMs(ms as number)))
    offs.push(e.on('push-progress', (data) => {
      setPushProgress((data as { done: number; total: number } | null) ?? null)
    }))
    offs.push(e.on('error', (m) => log('❌ ' + m, 'err')))

    setState(t.state as TransportState)
    if (t.localRole) setRole(t.localRole)
    // APK：监听浏览器通过 HTTP POST 回来的 Answer，自动完成连接
    let offLanAnswer: (() => void) | null = null
    if (isCapacitor()) {
      void onLanAnswer((code) => {
        log('🌐 收到局域网 Answer，正在应用...', 'info')
        void applyRemoteAnswer(code)
      }).then((off) => { offLanAnswer = off })
    }
    return () => { for (const off of offs) off(); offLanAnswer?.() }
    // 只在挂载时绑定一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function copyText(text: string) {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      log('已复制到剪贴板', 'info')
      return
    } catch {}
    // Android WebView 可能没有 clipboard API 权限，退回 execCommand
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      log(ok ? '已复制到剪贴板' : '复制失败，请手动长按选中', ok ? 'info' : 'err')
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
      t.setLanOnly(lanOnly)
      setRole('host')
      log(`⏳ 正在收集网络候选（${lanOnly ? '仅局域网' : 'STUN'}，最多 8 秒）...`, 'info')
      const code = await t.createPairingCode()
      setLocalCode(code)
      log('✅ Offer 已生成，把上面的码发给对方', 'ok')
    } catch (e) {
      const msg = '❌ 创建 Offer 失败: ' + (e as Error).message
      setErrorBanner(msg)
      log(msg, 'err')
    }
  }

  async function applyRemoteOffer(codeOverride?: string) {
    const code = (codeOverride ?? remoteCode).trim()
    setRemoteCode(code)
    try {
      setErrorBanner(null)
      const t = ensureTransport()
      t.setLanOnly(lanOnly)
      setRole('guest')
      log(`⏳ 正在应用 Offer（${lanOnly ? '仅局域网' : 'STUN'}）...`, 'info')
      const answer = await t.applyPairingCode(code)
      if (answer) {
        setLocalCode(answer)
        log('✅ Answer 已生成，把二维码给对方扫，或复制发回', 'ok')
      }
    } catch (e) {
      const msg = '❌ 应用 Offer 失败: ' + (e as Error).message
      setErrorBanner(msg)
      log(msg, 'err')
    }
  }

  async function applyRemoteAnswer(codeOverride?: string) {
    const code = (codeOverride ?? remoteCode).trim()
    setRemoteCode(code)
    try {
      setErrorBanner(null)
      const t = transportRef.current
      if (!t) throw new Error('请先点「生成 Offer」')
      log('⏳ 正在应用 Answer...', 'info')
      await t.applyPairingCode(code)
      log('✅ Answer 已设置，等待连接...', 'ok')
    } catch (e) {
      const msg = '❌ 设置 Answer 失败: ' + (e as Error).message
      setErrorBanner(msg)
      log(msg, 'err')
    }
  }

  // ============ Tab B: 局域网 HTTP 自动配对 ============
  // 一方开热点（APK）发布 Offer，另一方（浏览器或 APK）拉取并回传 Answer。

  async function connectViaLan() {
    const base = lanUrl.trim().replace(/\/+$/, '')
    if (!base) return
    try {
      setErrorBanner(null)
      log(`🔎 正在拉取 ${base}/offer ...`, 'info')
      const resp = await fetch(`${base}/offer`)
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}${resp.status === 404 ? '（对方还没启动热点）' : ''}`)
      }
      const data = (await resp.json()) as { code?: string }
      if (!data.code) throw new Error('对方没有发布 Offer')

      const t = ensureTransport()
      t.setLanOnly(lanOnly)
      setRole('guest')
      log('⏳ 已拿到 Offer，正在生成 Answer...', 'info')
      const answer = await t.applyPairingCode(data.code)
      if (!answer) throw new Error('生成 Answer 失败')
      setLocalCode(answer)

      const post = await fetch(`${base}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: answer }),
      })
      if (!post.ok) throw new Error('回传 Answer 失败 HTTP ' + post.status)
      log('🌐 局域网 HTTP 配对完成，等待连接...', 'ok')
    } catch (e) {
      const msg = '❌ 局域网配对失败: ' + (e as Error).message
      setErrorBanner(msg)
      log(msg, 'err')
      log('提示：如果当前页面是 HTTPS、对方热点是 http://，浏览器会按混合内容拦截，请改用 Tab A 配对码。', 'err')
    }
  }

  // ============ 通用 ============

  async function pushSessionNow() {
    if (!engineRef.current) { log('还没连接', 'err'); return }
    // 会话 + 设置 + Persona + 外观一起推，进度通过 push-progress 事件回报
    await engineRef.current.pushAllWithConfig()
    log('📤 开始推送（会话 + 设置 + 人物设定 + 外观）', 'info')
  }

  function disconnect() {
    // 只重置底层连接，保留 transport/engine 与 UI 订阅，下次配对可直接重用
    disconnectSync()
    setRole(null); setState('idle'); setLocalCode(''); setRemoteCode('')
    setPushProgress(null)
    log('🔌 已断开', 'info')
  }

  /** 回到「房主 / 加入者」选择，并清掉半成品连接 */
  function backToRoleSelect(nextTab?: Tab) {
    disconnect()
    setErrorBanner(null)
    if (nextTab) setTab(nextTab)
  }

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
        <div className={styles['sync-status']}>
          <span className={`${styles['sync-dot']} ${styles[stateCls[state]]}`}></span>
          {stateText[state]} {role && `（${role === 'host' ? '房主' : '加入者'}）`}
          {pongMs !== null && pongMs > 0 && ` · RTT ${pongMs}ms`}
        </div>
      </div>

      {/* 已连接操作条 —— 与标题/状态同级，不用滚动就能看到 */}
      {state === 'connected' && (
        <div className={styles['sync-connected']}>
          <div>✅ 已连接 · 息屏保活已开启，新消息自动同步</div>
          <div className={styles['sync-row']}>
            <button
              className={`${styles['sync-btn']} ${styles.primary}`}
              onClick={pushSessionNow}
              disabled={pushProgress !== null}
            >
              {pushProgress ? '同步中...' : '同步全部（会话 + 设定）'}
            </button>
            <button className={styles['sync-btn']} onClick={disconnect}>
              断开连接
            </button>
          </div>
          {pushProgress && pushProgress.total > 0 && (
            <div className={styles['sync-progress']}>
              <div className={styles['sync-progress-track']}>
                <div
                  className={styles['sync-progress-fill']}
                  style={{ width: `${Math.round((pushProgress.done / pushProgress.total) * 100)}%` }}
                />
              </div>
              <span>{pushProgress.done}/{pushProgress.total}</span>
            </div>
          )}
        </div>
      )}

      {/* 环境预检 —— 挂载时立刻显示 */}
      <div className={styles['sync-section']}>
        <h3>🔍 环境检测</h3>
        <div className={styles['sync-info']}>
          WebRTC: <b>{env.webRTC === 'ok' ? '✅ 支持' : env.webRTC === 'no' ? '❌ 不支持' : '...'}</b> &nbsp;
          安全上下文: <b>{env.secureContext === 'ok' ? '✅' : env.secureContext === 'no' ? '⚠️ 非安全（http://IP）' : '...'}</b> &nbsp;
          摄像头: <b>{env.camera ? '✅' : '❌ 不可用'}</b>
        </div>
        {!env.camera && (
          <div className={styles['sync-info']} style={{ marginTop: 6 }}>
            当前环境不能扫码（浏览器需 HTTPS 并允许摄像头），请改用复制 / 粘贴配对码。
          </div>
        )}
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
                <button className={styles['sync-btn']} onClick={createOffer}>
                  我是房主，生成配对码
                </button>
                <button
                  className={styles['sync-btn']}
                  onClick={() => { setRole('guest'); log('请在下面粘贴房主发来的码，然后点「应用 Offer」', 'info') }}
                >
                  我是加入者，粘贴对方的码
                </button>
              </div>
              <label className={styles['sync-toggle']} style={{ marginTop: 8 }}>
                <input
                  type="checkbox"
                  checked={lanOnly}
                  onChange={(e) => {
                    setLanOnly(e.target.checked)
                    writeBool('ds-sync:lanonly', e.target.checked)
                    transportRef.current?.setLanOnly(e.target.checked)
                  }}
                />
                <span>📶 仅局域网直连<em style={{ opacity: 0.6 }}>（跳过 STUN，两台设备需在同一 WiFi）</em></span>
              </label>
            </div>
          )}

          {role === 'host' && (
            <>
              <div className={styles['sync-row']}>
                <button className={styles['sync-btn']} onClick={() => backToRoleSelect()}>
                  ← 返回重新选择
                </button>
                <button className={styles['sync-btn']} onClick={() => backToRoleSelect('lan')}>
                  改用局域网 URL
                </button>
              </div>
              <div className={styles['sync-section']}>
                <h3>① 本地 Offer（发给加入者）</h3>
                <textarea readOnly value={localCode} placeholder="自动生成..." rows={4} onFocus={(e) => e.currentTarget.select()} />
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
                {localCode && (
                  <>
                    <QrCodeView text={localCode} compact />
                    <div className={styles['sync-info']} style={{ textAlign: 'center' }}>
                      让加入者用「📷 扫码」直接扫这块二维码
                    </div>
                  </>
                )}
              </div>

              <div className={styles['sync-section']}>
                <h3>② 加入者的 Answer</h3>
                <textarea
                  value={remoteCode}
                  onChange={(e) => setRemoteCode(e.target.value)}
                  placeholder="粘贴对方发回的 Answer 码..."
                  rows={4}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <div className={styles['sync-row']}>
                  {env.camera && (
                    <button className={styles['sync-btn']} onClick={() => setScanTarget('answer')}>
                      📷 扫码
                    </button>
                  )}
                  <button
                    className={`${styles['sync-btn']} ${styles.primary}`}
                    onClick={() => void applyRemoteAnswer()}
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
              <div className={styles['sync-row']}>
                <button className={styles['sync-btn']} onClick={() => backToRoleSelect()}>
                  ← 返回重新选择
                </button>
                <button className={styles['sync-btn']} onClick={() => backToRoleSelect('lan')}>
                  改用局域网 URL
                </button>
              </div>
              <div className={styles['sync-section']}>
                <h3>① 房主的 Offer</h3>
                <textarea
                  value={remoteCode}
                  onChange={(e) => setRemoteCode(e.target.value)}
                  placeholder="粘贴房主发来的码..."
                  rows={4}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <div className={styles['sync-row']}>
                  {env.camera && (
                    <button className={styles['sync-btn']} onClick={() => setScanTarget('offer')}>
                      📷 扫码
                    </button>
                  )}
                  <button
                    className={`${styles['sync-btn']} ${styles.primary}`}
                    onClick={() => void applyRemoteOffer()}
                    disabled={!remoteCode.trim() || state === 'connected'}
                  >
                    应用 Offer → 生成 Answer
                  </button>
                </div>
              </div>

              <div className={styles['sync-section']}>
                <h3>② 本地 Answer（发回给房主）</h3>
                <textarea readOnly value={localCode} placeholder="自动生成..." rows={4} onFocus={(e) => e.currentTarget.select()} />
                <div className={styles['sync-row']}>
                  <button className={styles['sync-btn']} onClick={() => copyText(localCode)} disabled={!localCode}>
                    复制
                  </button>
                </div>
                {localCode && (
                  <>
                    <QrCodeView text={localCode} compact />
                    <div className={styles['sync-info']} style={{ textAlign: 'center' }}>
                      让房主用「📷 扫码」扫这块二维码，无需传文本
                    </div>
                  </>
                )}
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
                            await clearPairingOffer()
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
                    <div className={styles['sync-info']} style={{ marginBottom: 8 }}>
                      启动后会发布本机 Offer，浏览器或另一台 APK 填这个地址就能自动配对。
                    </div>
                    <button
                      className={`${styles['sync-btn']} ${styles.primary}`}
                      onClick={async () => {
                        try {
                          const r = await startServer(7321)
                          setLanInfo(r)
                          log(`✅ 本机热点已启动: ${r.url}`, 'ok')
                          // 生成并发布 Offer，供浏览器/其他设备通过 /offer 拉取
                          const t = ensureTransport()
                          t.setLanOnly(lanOnly)
                          setRole('host')
                          const code = await t.createPairingCode()
                          setLocalCode(code)
                          await publishPairingOffer(code)
                          log('🌐 已发布 Offer：浏览器打开上面的地址 → B Tab → 自动配对', 'info')
                        } catch (e) {
                          log('启动失败: ' + (e as Error).message, 'err')
                        }
                      }}
                    >
                      启动本机热点（自动配对）
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
                    onClick={connectViaLan}
                  >
                    自动配对连接
                  </button>
                </div>
              </div>
            </>
          ) : (
            // 浏览器：连接 APK 的热点，通过 HTTP 自动交换 SDP
            <div className={styles['sync-section']}>
              <h3>🔗 连接 APK 热点</h3>
              <div className={styles['sync-info']} style={{ marginBottom: 10 }}>
                在 Android APK 的同步面板 → B Tab → 「启动本机热点」，把它显示的地址填到这里，
                浏览器会自动拉取 Offer 并完成配对。
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className={styles['sync-input']}
                  value={lanUrl}
                  onChange={(e) => setLanUrl(e.target.value)}
                  placeholder="例如 http://192.168.1.23:7321"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                <button
                  className={`${styles['sync-btn']} ${styles.primary}`}
                  disabled={!lanUrl || state === 'connected'}
                  onClick={connectViaLan}
                >
                  自动配对
                </button>
              </div>
              <div className={styles['sync-info']} style={{ marginTop: 10 }}>
                如果当前页面是 HTTPS、而热点是 http://，浏览器会拦截混合内容；
                这种情况请用 Tab A 的配对码或二维码。
              </div>
            </div>
          )}
        </>
      )}

      {/* ============ 同步内容 ============ */}
      <div className={styles['sync-section']}>
        <h3>同步内容</h3>
        <div className={styles['sync-info']} style={{ marginBottom: 6 }}>
          会话消息始终同步（并集合并：有的覆盖、没有的补充，不会删对方数据）。
        </div>
        <label className={styles['sync-toggle']}>
          <input
            type="checkbox"
            checked={syncGeneral}
            onChange={(e) => {
              setSyncGeneral(e.target.checked)
              writeBool('ds-sync:general', e.target.checked)
              if (engineRef.current) {
                engineRef.current.syncSettings = e.target.checked
                engineRef.current.syncPersona = e.target.checked
                engineRef.current.syncAppearance = e.target.checked
              }
            }}
          />
          <span>📦 通用信息同步 <em style={{ opacity: 0.6 }}>（设置、人物设定、外观）</em></span>
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
          <span>🔑 连 API Key 也同步 <em style={{ opacity: 0.6 }}>（谨慎开，会覆盖对方 API Key）</em></span>
        </label>
        {state === 'connected' && engineRef.current && (
          <button
            className={`${styles['sync-btn']} ${styles.primary}`}
            style={{ marginTop: 8 }}
            onClick={() => { void engineRef.current?.sendAllConfig() }}
          >
            立即同步一次配置
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

      {/* 通用断开（未连接但在配对中时使用；已连接时用顶部操作条） */}
      {state !== 'closed' && state !== 'idle' && state !== 'connected' && (
        <button className={`${styles['sync-btn']} ${styles.danger}`} onClick={disconnect}>
          🔌 断开连接
        </button>
      )}

      {/* 扫码取景框（全屏覆盖） */}
      {scanTarget && (
        <QrScanner
          hint={scanTarget === 'offer' ? '扫描房主的 Offer 二维码' : '扫描加入者的 Answer 二维码'}
          onClose={() => setScanTarget(null)}
          onResult={(text) => {
            const target = scanTarget
            setScanTarget(null)
            log('📷 已识别二维码，正在应用...', 'ok')
            if (target === 'offer') void applyRemoteOffer(text)
            else void applyRemoteAnswer(text)
          }}
        />
      )}
    </div>
  )
}

/** 同步面板对话框 —— 类似 SettingsDialog：open 时挂载 Modal，关闭时 unmount */
export const SyncDialog = () => {
  const open = useSyncPanel((s) => s.open)
  if (!open) return null
  return (
    <Modal
      title="📡 局域网同步"
      closable
      onClose={closeSyncPanel}
      scrollable
      className={styles.dialog}
    >
      <SyncPanel />
    </Modal>
  )
}
