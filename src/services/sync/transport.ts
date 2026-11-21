/**
 * WebRTC 传输核心 —— 完全原生 Web API，零 Capacitor 依赖
 *
 * 用法：
 *   const t = new SyncTransport()
 *
 *   // 作为 Host：
 *   const code = await t.createPairingCode()     // 拿到 Offer SDP 压缩码
 *   await t.applyPairingCode(receivedAnswer)      // 收到对方的 Answer 码后设置
 *
 *   // 作为 Guest：
 *   await t.applyPairingCode(receivedOffer)       // 收到 Host 的 Offer 码
 *   const code = await t.createPairingCode()      // 生成自己的 Answer 码回传
 *
 *   t.on('open', () => { ... })
 *   t.on('message', (data) => { ... })
 *   t.send({ type: 'ping', ts: Date.now() })
 */

export type SyncRole = 'host' | 'guest'

export type SyncTransportState =
  | 'idle'
  | 'offer_generated'
  | 'connecting'
  | 'connected'
  | 'closed'
  | 'failed'

type SyncListener = (data: unknown) => void

const STUN_SERVERS: RTCConfiguration['iceServers'] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  // 国内可用的公共 STUN（Google 常被墙，失败时还有这些兜底）
  { urls: ['stun:stun.miwifi.com:3478'] },
  { urls: ['stun:stun.chat.bilibili.com:3478'] },
]

/** 压缩后的配对码：base64(SDP JSON)，包含必要元数据做版本校验 */
export type PairingCode = string

export interface PairingPayload {
  v: number
  type: 'offer' | 'answer'
  sdp: string
  /** 设备描述，展示给对方看 */
  device?: string
}

export class SyncTransport extends EventTarget {
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private role: SyncRole | null = null
  private _state: SyncTransportState = 'idle'
  private listeners = new Map<string, Set<SyncListener>>()
  /** true = 只用主机候选（同一局域网直连），不请求 STUN，建码更快 */
  private lanOnly: boolean

  constructor(opts: { lanOnly?: boolean } = {}) {
    super()
    this.lanOnly = opts.lanOnly ?? true
  }

  /** 切换连接模式；已有半成品连接会先丢弃，便于重新配对 */
  setLanOnly(v: boolean) {
    if (this.lanOnly === v) return
    this.lanOnly = v
    if (this.pc) this.resetPeer()
  }

  get iceMode() {
    return this.lanOnly ? 'lan-only' : 'stun'
  }

  private newPeer(): RTCPeerConnection {
    this.pc = new RTCPeerConnection({
      iceServers: this.lanOnly ? [] : STUN_SERVERS,
      iceCandidatePoolSize: 0,
    })
    return this.pc
  }

  /** 主动断开：关闭底层连接但保留事件监听，方便直接重新配对 */
  reset() {
    this.resetPeer()
  }

  get localRole(): SyncRole | null {
    return this.role
  }

  /** 丢弃当前连接但保留事件监听（用于重试配对） */
  private resetPeer() {
    if (this.dc) { try { this.dc.close() } catch {} this.dc = null }
    if (this.pc) { try { this.pc.close() } catch {} this.pc = null }
    this.role = null
    this.setState('idle')
  }

  get state() {
    return this._state
  }
  get isConnected() {
    return this._state === 'connected' && this.dc?.readyState === 'open'
  }
  get connectionId() {
    return this.pc?.connectionState ?? null
  }

  private setState(s: SyncTransportState) {
    this._state = s
    this.emit('state', s)
  }

  private emit(event: string, data: unknown) {
    const set = this.listeners.get(event)
    if (set) for (const l of set) l(data)
  }

  on(event: string, listener: SyncListener) {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return () => this.off(event, listener)
  }
  off(event: string, listener: SyncListener) {
    this.listeners.get(event)?.delete(listener)
  }

  /**
   * Host 侧：创建 Offer + DataChannel，返回可分享的配对码。
   * 内部会等待 ICE gathering 完成再返回，保证 SDP 里包含所有候选地址。
   */
  async createPairingCode(opts: { device?: string } = {}): Promise<PairingCode> {
    // 允许重试：上一次没连上时可以重新生成
    if (this.pc) this.resetPeer()
    this.role = 'host'
    const pc = this.newPeer()

    this.setupPeerEvents()
    this.dc = pc.createDataChannel('sync', { ordered: true })
    this.setupDC()

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await this.waitIceGathering()

    const code = await encodePairing({
      v: 1,
      type: 'offer',
      sdp: pc.localDescription!.sdp,
      device: opts.device ?? detectDevice(),
    })
    this.setState('offer_generated')
    return code
  }

  /**
   * 通用：收到对方的配对码后应用。
   *  - Host 收到 Answer → setRemote → 等 connected
   *  - Guest 收到 Offer → setRemote → createAnswer → 返回自己的配对码
   */
  async applyPairingCode(code: PairingCode): Promise<PairingCode | null> {
    const payload = await decodePairing(code)

    if (this.role === 'host') {
      if (payload.type !== 'answer') throw new Error('Host 只能接收 answer 码')
      if (!this.pc) throw new Error('Host 尚未调用 createPairingCode')
      await this.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
      this.setState('connecting')
      return null
    }

    // Guest 模式
    if (this.pc) this.resetPeer()
    this.role = 'guest'
    const pc = this.newPeer()
    this.setupPeerEvents()

    // Guest 等对方的 DataChannel
    pc.ondatachannel = (e) => {
      this.dc = e.channel
      this.setupDC()
    }

    if (payload.type !== 'offer') throw new Error('Guest 需要 offer 码')
    await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await this.waitIceGathering()

    const answerCode = await encodePairing({
      v: 1,
      type: 'answer',
      sdp: pc.localDescription!.sdp,
      device: detectDevice(),
    })
    this.setState('connecting')
    return answerCode
  }

  /** 发送任意 JSON-serializable 数据 */
  send(data: unknown): boolean {
    if (!this.isConnected) return false
    try {
      this.dc!.send(JSON.stringify(data))
      return true
    } catch {
      return false
    }
  }

  /** 关闭连接并清理 */
  close() {
    if (this.dc) {
      try { this.dc.close() } catch {}
      this.dc = null
    }
    if (this.pc) {
      try { this.pc.close() } catch {}
      this.pc = null
    }
    this.role = null
    // 先通知状态，再清监听——否则 GUI 收不到 closed
    this.setState('closed')
    this.listeners.clear()
  }

  // --- 内部 ---

  private setupPeerEvents() {
    if (!this.pc) return
    // 候选诊断：把候选类型打到 UI 日志里，连不上时能看出卡在哪
    this.pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.emit('candidate', {
          type: e.candidate.type ?? 'host',
          protocol: e.candidate.protocol ?? '',
          address: e.candidate.address ?? '',
        })
      } else {
        this.emit('gathering-done', null)
      }
    }
    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc!.iceConnectionState
      console.log('[SyncTransport] iceConnectionState:', s)
      this.emit('iceState', s)
      if (s === 'connected' || s === 'completed') {
        // 这里只更新状态；'open' 等 DataChannel 真正可写后再发（setupDC 的 onopen），
        // 否则握手 hello 会在通道还没就绪时被丢弃，表现为「连上了但什么都同步不过去」
        this.setState('connected')
      } else if (s === 'disconnected') {
        // 息屏 / 切后台 / WiFi 短暂休眠都会走到这里，是可恢复的中间态，
        // 不能直接判死，否则一息屏 UI 就永远显示连接失败
        if (this._state === 'connected') this.setState('connecting')
      } else if (s === 'failed') {
        // 收集一下候选对，帮诊断
        try {
          const pairs = (this.pc as any).getSctpTransports?.() ?? []
          for (const t of pairs) {
            const c = t.iceTransport?.selectedCandidatePair
            if (c) console.log('[SyncTransport] selected pair:', c)
          }
        } catch {}
        if (this._state !== 'closed') this.setState('failed')
      }
    }
    this.pc.onconnectionstatechange = () => {
      const s = this.pc!.connectionState
      console.log('[SyncTransport] connectionState:', s)
      this.emit('connState', s)
      if (this._state === 'closed') return
      // 双保险：connectionState 恢复时也把 UI 状态拉回来
      if (s === 'connected') this.setState('connected')
      else if (s === 'disconnected') {
        if (this._state === 'connected') this.setState('connecting')
      } else if (s === 'failed') {
        this.setState('failed')
      }
    }
    this.pc.onicecandidateerror = (ev) => {
      console.warn('[SyncTransport] iceCandidateError:', ev)
    }
  }

  private setupDC() {
    if (!this.dc) return
    this.dc.onopen = () => {
      console.log('[SyncTransport] dc.onopen! state was:', this._state)
      if (this._state !== 'connected') this.setState('connected')
      this.emit('open', null)
      this.emit('dc-open', null)
    }
    this.dc.onmessage = (e) => {
      let data: unknown = e.data
      try { data = JSON.parse(e.data) } catch { /* binary 或纯文本，原样传 */ }
      this.emit('message', data)
    }
    this.dc.onclose = () => {
      this.emit('dc-close', null)
      // 手动断开时状态已是 idle/closed；意外关闭则先标成连接中，等 ICE 恢复
      if (this._state === 'connected') this.setState('connecting')
    }
    this.dc.onerror = (e) => this.emit('dc-error', e)
  }

  private waitIceGathering(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve) => {
      if (!this.pc) return resolve()
      if (this.pc.iceGatheringState === 'complete') return resolve()
      const done = () => resolve()
      const timer = setTimeout(done, timeoutMs)
      this.pc.onicegatheringstatechange = () => {
        if (this.pc!.iceGatheringState === 'complete') {
          clearTimeout(timer)
          done()
        }
      }
    })
  }
}

// --- 配对码编解码 ---
//
// SDP 很长（1-2KB），直接塞二维码会密到扫不出来。
// 优先用 gzip 压缩再 base64url（WebView/Chrome 都支持 CompressionStream），
// 不支持时退回不压缩的旧格式；旧码（无前缀）仍然能解。

const COMPRESS_PREFIX = 'z1.'

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(code: string): Uint8Array {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function gzip(text: string): Promise<Uint8Array | null> {
  const CS = (globalThis as any).CompressionStream
  if (typeof CS !== 'function') return null
  try {
    const stream = new Blob([new TextEncoder().encode(text)])
      .stream()
      .pipeThrough(new CS('gzip'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return null
  }
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const DS = (globalThis as any).DecompressionStream
  if (typeof DS !== 'function') throw new Error('当前环境不支持压缩配对码')
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DS('gzip'))
  return await new Response(stream).text()
}

export async function encodePairing(p: PairingPayload): Promise<PairingCode> {
  // 默认输出未压缩格式：浏览器版 / 旧版 APK 都能解析，保证跨端互通
  return toBase64Url(new TextEncoder().encode(JSON.stringify(p)))
}

/**
 * 仅用于二维码显示：gzip 压缩后体积约减半，扫起来更稳。
 * 文本复制仍然用未压缩的 encodePairing()，避免旧客户端解不开。
 */
export async function compactPairingCode(code: PairingCode): Promise<PairingCode> {
  try {
    const payload = await decodePairing(code)
    const packed = await gzip(JSON.stringify(payload))
    if (!packed) return code
    return COMPRESS_PREFIX + toBase64Url(packed)
  } catch {
    return code
  }
}

export async function decodePairing(code: PairingCode): Promise<PairingPayload> {
  const trimmed = code.trim()
  try {
    let json: string
    if (trimmed.startsWith(COMPRESS_PREFIX)) {
      json = await gunzip(fromBase64Url(trimmed.slice(COMPRESS_PREFIX.length)))
    } else {
      const bin = atob(trimmed.replace(/-/g, '+').replace(/_/g, '/'))
      json = decodeURIComponent(escape(bin))
    }
    const p = JSON.parse(json) as PairingPayload
    if (!p.sdp || !p.type || !p.v) throw new Error('字段缺失')
    return p
  } catch {
    throw new Error('配对码解析失败，可能已损坏')
  }
}

/** 粗略检测当前设备类型，展示给对方 */
export function detectDevice(): string {
  const ua = navigator.userAgent
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) {
    if (/tablet/i.test(ua)) return 'Android 平板'
    return 'Android 手机'
  }
  if (/Mac OS X/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows PC'
  if (/Linux/i.test(ua)) return 'Linux'
  return '浏览器'
}

/**
 * 局域网 HTTP 信令适配器（Phase 1 手动版）
 *
 * 纯 JS 实现，不依赖原生插件。
 * - Host 侧：启动一个 WebSocket server（不行）→ 改为用 fetch 轮询自己开的 HTTP endpoint？
 *   浏览器不能开 server → 所以 B 入口 Phase 1 其实只能做"手动输入对方 URL / IP"
 *   但浏览器里 fetch 可以访问局域网 IP → 所以 Phase 1 B 入口可以是：
 *     Host 跑一个 Node 小脚本开端口 7321，Capacitor 端可以 fetch 到
 *     或者更简单：把 B 入口也降级成"输入对方已经跑起来的 HTTP endpoint"
 *
 * 真正要 B 自动发现，Phase 2 再写 Capacitor 原生插件开 HTTP server + mDNS。
 * 这里只做一个"客户端"：在已知 URL 上 fetch Offer/Answer。
 */

export interface LanEndpoint {
  url: string          // 如 http://192.168.1.100:7321
}

export async function fetchOfferFromLan(endpoint: LanEndpoint): Promise<PairingCode> {
  const res = await fetch(`${endpoint.url}/offer`, { method: 'POST' })
  if (!res.ok) throw new Error(`LAN HTTP ${res.status}`)
  const { code } = (await res.json()) as { code: string }
  return code
}

export async function postAnswerToLan(endpoint: LanEndpoint, answerCode: PairingCode): Promise<void> {
  const res = await fetch(`${endpoint.url}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: answerCode }),
  })
  if (!res.ok) throw new Error(`LAN HTTP ${res.status}`)
}
