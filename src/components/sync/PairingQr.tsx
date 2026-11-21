/**
 * 配对二维码：生成 + 扫描。
 *
 * 生成用 qrcode 画到 canvas；
 * 扫描用 getUserMedia 拿摄像头 + jsQR 逐帧解码（Android WebView 里
 * BarcodeDetector 不一定存在，jsQR 是纯 JS，最稳）。
 */
import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import * as jsQRModule from 'jsqr'
import { compactPairingCode } from '../../services/sync/transport.js'
import styles from './PairingQr.module.css'

/** jsqr 的 CJS/ESM 互操作：NodeNext 下 default 可能挂在命名空间上 */
const jsQR = (((jsQRModule as unknown as { default?: unknown }).default ?? jsQRModule) as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: 'dontInvert' | 'onlyInvert' | 'attemptBoth' | 'invertFirst' }
) => { data: string } | null)

/** 把一段文本画成二维码；compact 时内部先 gzip 压缩（只影响二维码，不影响复制文本） */
export function QrCodeView({
  text,
  size = 240,
  compact = false,
}: {
  text: string
  size?: number
  compact?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !text) return
    setError(null)
    let cancelled = false
    void (async () => {
      try {
        const value = compact ? await compactPairingCode(text) : text
        if (cancelled || !canvasRef.current) return
        await QRCode.toCanvas(canvas, value, {
          errorCorrectionLevel: 'L',
          margin: 1,
          // 内部按高分辨率画，屏幕上由 CSS 等比缩小
          width: 900,
          color: { dark: '#000000', light: '#ffffff' },
        })
        if (cancelled) return
        // qrcode 会写内联 style 的固定 px 宽高，max-width 只压得住宽、压不住高，
        // 结果二维码被纵向拉伸扫不出来。清掉内联样式，交给 CSS 等比控制。
        canvas.style.width = '100%'
        canvas.style.height = 'auto'
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => { cancelled = true }
  }, [text, size, compact])

  if (!text) return null
  return (
    <div
      className={`${styles.qrBox} ${zoom ? styles.zoom : ''}`}
      onClick={() => setZoom((v) => !v)}
      role="button"
      tabIndex={0}
      onKeyDown={() => setZoom((v) => !v)}
    >
      <canvas ref={canvasRef} className={styles.qrCanvas} />
      {error && <div className={styles.qrError}>二维码生成失败：{error}</div>}
      {zoom && (
        <button
          className={styles.qrClose}
          onClick={(e) => { e.stopPropagation(); setZoom(false) }}
        >
          关闭
        </button>
      )}
      {!error && <div className={styles.qrHint}>{zoom ? '点关闭按钮或空白处退出' : '点二维码可放大'}</div>}
    </div>
  )
}

/** 全屏扫码取景框；识别成功回调一次后自动关闭摄像头 */
export function QrScanner({
  hint,
  onResult,
  onClose,
}: {
  hint?: string
  onResult: (text: string) => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null
    let stream: MediaStream | null = null
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const cleanup = () => {
      cancelled = true
      if (timer) clearInterval(timer)
      if (stream) for (const track of stream.getTracks()) track.stop()
    }

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
        if (cancelled) { cleanup(); return }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()

        timer = setInterval(() => {
          if (!video.videoWidth || !ctx) return
          // 缩小到 480 宽再识别，速度快很多
          const width = 480
          const height = Math.round(video.videoHeight * (width / video.videoWidth))
          canvas.width = width
          canvas.height = height
          ctx.drawImage(video, 0, 0, width, height)
          const image = ctx.getImageData(0, 0, width, height)
          const found = jsQR(image.data, width, height, { inversionAttempts: 'dontInvert' })
          if (found?.data) {
            cleanup()
            onResultRef.current(found.data)
          }
        }, 180)
      } catch (e) {
        const message = (e as Error).message || '未知错误'
        setError(
          /Permission|NotAllowed/i.test(message)
            ? '没有摄像头权限，请在系统设置里给 DS Lite 开启相机权限'
            : '无法打开摄像头：' + message
        )
      }
    }

    void start()
    return cleanup
  }, [])

  return (
    <div className={styles.scannerOverlay}>
      <video ref={videoRef} className={styles.scannerVideo} playsInline muted />
      <div className={styles.scannerHead}>
        <div className={styles.scannerTitle}>{hint ?? '对准二维码'}</div>
        <button className={styles.scannerClose} onClick={onClose}>关闭</button>
      </div>
      <div className={styles.scannerFrame} />
      {error && <div className={styles.scannerError}>{error}</div>}
      <div className={styles.scannerTip}>把对方的二维码放进取景框内，识别后自动应用</div>
    </div>
  )
}
