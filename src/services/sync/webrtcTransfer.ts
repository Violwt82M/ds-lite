import { deflateSync, inflateSync } from 'fflate'

const CODE_PREFIX = 'DSL1:'
const CHUNK_SIZE = 32 * 1024
const HIGH_WATERMARK = 512 * 1024
const LOW_WATERMARK = 128 * 1024

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.miwifi.com:3478'] },
  { urls: ['stun:stun.chat.bilibili.com:3478'] },
  { urls: ['stun:stun.l.google.com:19302'] },
]

type SignalPayload = {
  v: 1
  type: 'offer' | 'answer'
  sdp: string
}

type ChannelControl =
  | { type: 'meta'; name: string; size: number }
  | { type: 'done' }
  | { type: 'ack' }

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (input: string): Uint8Array => {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

const encodeSignal = (payload: SignalPayload): string => {
  const raw = new TextEncoder().encode(JSON.stringify(payload))
  const compressed = deflateSync(raw, { level: 9 })
  return `${CODE_PREFIX}${toBase64Url(compressed)}`
}

const decodeSignal = (code: string, expected: 'offer' | 'answer'): SignalPayload => {
  const trimmed = code.trim().replace(/\s+/g, '')
  if (!trimmed.startsWith(CODE_PREFIX)) {
    throw new Error('口令格式不正确，请确认完整复制了以 DSL1: 开头的配对口令')
  }
  try {
    const bytes = fromBase64Url(trimmed.slice(CODE_PREFIX.length))
    const text = new TextDecoder().decode(inflateSync(bytes))
    const parsed = JSON.parse(text) as Partial<SignalPayload>
    if (parsed.v !== 1 || parsed.type !== expected || typeof parsed.sdp !== 'string') {
      throw new Error(expected === 'offer' ? '请粘贴发送方生成的「发送口令」' : '请粘贴接收方生成的「回执口令」')
    }
    return { v: 1, type: expected, sdp: parsed.sdp }
  } catch (error) {
    if (error instanceof Error && (error.message.includes('口令') || error.message.includes('粘贴'))) {
      throw error
    }
    throw new Error('口令解析失败，可能复制不完整，请重新复制')
  }
}

/** 等待 ICE 候选收集完成（或最多等 3.5 秒，避免个别 STUN 超时卡住） */
const waitForIceGathering = (pc: RTCPeerConnection): Promise<void> =>
  new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve()
      return
    }
    let finished = false
    let settleTimer = 0
    const finish = () => {
      if (finished) {
        return
      }
      finished = true
      window.clearTimeout(hardTimer)
      window.clearTimeout(settleTimer)
      pc.removeEventListener('icegatheringstatechange', onState)
      pc.removeEventListener('icecandidate', onCandidate)
      resolve()
    }
    const onState = () => {
      if (pc.iceGatheringState === 'complete') {
        finish()
      }
    }
    const onCandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) {
        finish()
        return
      }
      // 收集到候选后，若 1.2 秒内没有新候选就提前结束，速度更快
      window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(finish, 1200)
    }
    const hardTimer = window.setTimeout(finish, 3500)
    pc.addEventListener('icegatheringstatechange', onState)
    pc.addEventListener('icecandidate', onCandidate)
  })

export type TransferProgress = {
  done: number
  total: number
}

export type WebRtcSenderHandle = {
  offerCode: string
  acceptAnswer: (answerCode: string) => Promise<void>
  close: () => void
}

export type WebRtcReceiverHandle = {
  answerCode: string
  close: () => void
}

const createPeer = (): RTCPeerConnection => {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new Error('当前浏览器不支持 WebRTC 点对点传输')
  }
  return new RTCPeerConnection({ iceServers: ICE_SERVERS })
}

const waitForBufferDrain = (channel: RTCDataChannel): Promise<void> =>
  new Promise((resolve, reject) => {
    if (channel.readyState !== 'open') {
      reject(new Error('传输连接已中断'))
      return
    }
    if (channel.bufferedAmount <= LOW_WATERMARK) {
      resolve()
      return
    }
    const onLow = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      reject(new Error('传输连接已关闭'))
    }
    const cleanup = () => {
      channel.removeEventListener('bufferedamountlow', onLow)
      channel.removeEventListener('close', onClose)
    }
    channel.bufferedAmountLowThreshold = LOW_WATERMARK
    channel.addEventListener('bufferedamountlow', onLow, { once: true })
    channel.addEventListener('close', onClose, { once: true })
  })

/** 作为发送方：创建 WebRTC Offer 口令，收到回执口令后直连分块发送 ZIP */
export const startWebRtcSender = async (options: {
  fileName: string
  blob: Blob
  onState: (state: 'connecting' | 'sending' | 'done' | 'error', message?: string) => void
  onProgress: (progress: TransferProgress) => void
}): Promise<WebRtcSenderHandle> => {
  const { fileName, blob, onState, onProgress } = options
  const pc = createPeer()
  const channel = pc.createDataChannel('ds-lite-transfer', { ordered: true })
  channel.binaryType = 'arraybuffer'
  let closed = false

  const close = () => {
    if (closed) {
      return
    }
    closed = true
    try {
      channel.close()
    } catch {
      // ignore
    }
    try {
      pc.close()
    } catch {
      // ignore
    }
  }

  let finished = false
  pc.addEventListener('connectionstatechange', () => {
    if (finished || closed) {
      return
    }
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      onState('error', '点对点连接失败，请确认网络畅通或改用局域网快传')
    }
  })

  channel.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data) as ChannelControl
        if (msg.type === 'ack') {
          finished = true
          onState('done')
          window.setTimeout(close, 300)
        }
      } catch {
        // ignore
      }
    }
  })

  channel.addEventListener('open', () => {
    void (async () => {
      try {
        onState('sending')
        channel.send(JSON.stringify({ type: 'meta', name: fileName, size: blob.size } satisfies ChannelControl))
        let sent = 0
        onProgress({ done: 0, total: blob.size })
        for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
          if (closed || channel.readyState !== 'open') {
            throw new Error('传输已中断')
          }
          if (channel.bufferedAmount > HIGH_WATERMARK) {
            await waitForBufferDrain(channel)
          }
          const chunk = await blob.slice(offset, offset + CHUNK_SIZE).arrayBuffer()
          channel.send(chunk)
          sent += chunk.byteLength
          onProgress({ done: sent, total: blob.size })
        }
        channel.send(JSON.stringify({ type: 'done' } satisfies ChannelControl))
      } catch (error) {
        if (!closed && !finished) {
          onState('error', error instanceof Error ? error.message : String(error))
        }
      }
    })()
  })

  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await waitForIceGathering(pc)
  const local = pc.localDescription
  if (!local?.sdp) {
    close()
    throw new Error('无法生成发送口令')
  }
  const offerCode = encodeSignal({ v: 1, type: 'offer', sdp: local.sdp })

  const acceptAnswer = async (answerCode: string) => {
    const parsed = decodeSignal(answerCode, 'answer')
    onState('connecting')
    await pc.setRemoteDescription({ type: 'answer', sdp: parsed.sdp })
  }

  return { offerCode, acceptAnswer, close }
}

/** 作为接收方：粘贴发送方口令后生成回执口令，建立直连后接收 ZIP 并回调 File */
export const startWebRtcReceiver = async (options: {
  offerCode: string
  onState: (state: 'waiting' | 'receiving' | 'done' | 'error', message?: string) => void
  onProgress: (progress: TransferProgress) => void
  onReceived: (file: File) => void
}): Promise<WebRtcReceiverHandle> => {
  const { offerCode, onState, onProgress, onReceived } = options
  const parsed = decodeSignal(offerCode, 'offer')
  const pc = createPeer()
  let closed = false
  let finished = false

  const close = () => {
    if (closed) {
      return
    }
    closed = true
    try {
      pc.close()
    } catch {
      // ignore
    }
  }

  pc.addEventListener('connectionstatechange', () => {
    if (finished || closed) {
      return
    }
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      onState('error', '点对点连接断开，请重试或改用局域网快传')
    }
  })

  pc.addEventListener('datachannel', (event) => {
    const channel = event.channel
    channel.binaryType = 'arraybuffer'
    let fileName = 'deepseek_data-sync.zip'
    let totalSize = 0
    let receivedSize = 0
    const chunks: BlobPart[] = []

    channel.addEventListener('message', (msgEvent) => {
      if (closed || finished) {
        return
      }
      if (typeof msgEvent.data === 'string') {
        try {
          const ctrl = JSON.parse(msgEvent.data) as ChannelControl
          if (ctrl.type === 'meta') {
            fileName = ctrl.name || fileName
            totalSize = ctrl.size || 0
            onState('receiving')
            onProgress({ done: 0, total: totalSize })
          } else if (ctrl.type === 'done') {
            finished = true
            const file = new File(chunks, fileName, { type: 'application/zip' })
            try {
              channel.send(JSON.stringify({ type: 'ack' } satisfies ChannelControl))
            } catch {
              // ignore
            }
            onState('done')
            onReceived(file)
            window.setTimeout(close, 300)
          }
        } catch {
          // ignore
        }
      } else if (msgEvent.data instanceof ArrayBuffer) {
        chunks.push(msgEvent.data)
        receivedSize += msgEvent.data.byteLength
        onProgress({ done: receivedSize, total: totalSize || receivedSize })
      }
    })
  })

  await pc.setRemoteDescription({ type: 'offer', sdp: parsed.sdp })
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  await waitForIceGathering(pc)
  const local = pc.localDescription
  if (!local?.sdp) {
    close()
    throw new Error('无法生成回执口令')
  }
  const answerCode = encodeSignal({ v: 1, type: 'answer', sdp: local.sdp })
  onState('waiting')

  return { answerCode, close }
}
