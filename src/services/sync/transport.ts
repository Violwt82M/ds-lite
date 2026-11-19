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
    if (this.pc) throw new Error('SyncTransport 已在运行')
    this.role = 'host'
    this.pc = new RTCPeerConnection({ iceServers: STUN_SERVERS })

    this.setupPeerEvents()
    this.dc = this.pc.createDataChannel('sync', { ordered: true })
    this.setupDC()

    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    await this.waitIceGathering()

    const code = encodePairing({
      v: 1,
      type: 'offer',
      sdp: this.pc.localDescription!.sdp,
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
    const payload = decodePairing(code)

    if (this.role === 'host') {
      if (payload.type !== 'answer') throw new Error('Host 只能接收 answer 码')
      if (!this.pc) throw new Error('Host 尚未调用 createPairingCode')
      await this.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
      this.setState('connecting')
      return null
    }

    // Guest 模式
    if (this.pc) throw new Error('SyncTransport 已在运行')
    this.role = 'guest'
    this.pc = new RTCPeerConnection({ iceServers: STUN_SERVERS })
    this.setupPeerEvents()

    // Guest 等对方的 DataChannel
    this.pc.ondatachannel = (e) => {
      this.dc = e.channel
      this.setupDC()
    }

    if (payload.type !== 'offer') throw new Error('Guest 需要 offer 码')
    await this.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
    const answer = await this.pc.createAnswer()
    await this.pc.setLocalDescription(answer)
    await this.waitIceGathering()

    const answerCode = encodePairing({
      v: 1,
      type: 'answer',
      sdp: this.pc.localDescription!.sdp,
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
    this.listeners.clear()
    if (this.dc) {
      try { this.dc.close() } catch {}
      this.dc = null
    }
    if (this.pc) {
      try { this.pc.close() } catch {}
      this.pc = null
    }
    this.role = null
    this.setState('closed')
  }

  // --- 内部 ---

  private setupPeerEvents() {
    if (!this.pc) return
    this.pc.oniceconnectionstatechange = () => {
      const s = this.pc!.iceConnectionState
      this.emit('iceState', s)
      if (s === 'connected' || s === 'completed') {
        this.setState('connected')
        this.emit('open', null)
      } else if (s === 'failed' || s === 'disconnected') {
        if (this._state !== 'closed') this.setState('failed')
      }
    }
    this.pc.onconnectionstatechange = () => {
      const s = this.pc!.connectionState
      this.emit('connState', s)
    }
  }

  private setupDC() {
    if (!this.dc) return
    this.dc.onopen = () => {
      if (this._state !== 'connected') this.setState('connected')
      this.emit('dc-open', null)
    }
    this.dc.onmessage = (e) => {
      let data: unknown = e.data
      try { data = JSON.parse(e.data) } catch { /* binary 或纯文本，原样传 */ }
      this.emit('message', data)
    }
    this.dc.onclose = () => this.emit('dc-close', null)
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

export function encodePairing(p: PairingPayload): PairingCode {
  const json = JSON.stringify(p)
  // base64 → base64url（去掉 + / =），更短更安全
  return btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodePairing(code: PairingCode): PairingPayload {
  try {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/')
    const json = decodeURIComponent(escape(atob(b64)))
    const p = JSON.parse(json) as PairingPayload
    if (!p.sdp || !p.type || !p.v) throw new Error('字段缺失')
    return p
  } catch (e) {
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
