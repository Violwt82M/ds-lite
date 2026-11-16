import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './ImageCropDialog.module.css'

/**
 * 图片框选：拖动平移 + 滑杆缩放，确认时按可视区域裁切。
 * 头像要方图、背景要整屏比例，用户不用先自己修图。
 */
export type CropAspect = 'square' | 'screen'

/** 屏幕比例（竖屏），限制在 1.4~2.3 之间，避免超长条 */
const screenAspect = (): number => {
  const ratio = window.innerHeight / Math.max(1, window.innerWidth)
  return Math.min(2.3, Math.max(1.4, ratio))
}

/** 取景框：头像是方形；背景按手机竖屏比例，高度不超过 360 */
const viewportOf = (aspect: CropAspect): { width: number; height: number } => {
  if (aspect === 'square') {
    return { width: 260, height: 260 }
  }
  const ratio = screenAspect()
  const height = Math.min(360, Math.round(200 * ratio))
  return { width: Math.round(height / ratio), height }
}

/** 输出：头像 256 方图；背景长边 1600，按取景框比例 */
const outputOf = (aspect: CropAspect, viewport: { width: number; height: number }) => {
  if (aspect === 'square') {
    return { width: 256, height: 256 }
  }
  const longEdge = 1600
  return viewport.height >= viewport.width
    ? { width: Math.round((longEdge * viewport.width) / viewport.height), height: longEdge }
    : { width: longEdge, height: Math.round((longEdge * viewport.height) / viewport.width) }
}

export const ImageCropDialog = ({
  file,
  aspect,
  onCancel,
  onConfirm,
}: {
  file: File
  aspect: CropAspect
  onCancel: () => void
  onConfirm: (blob: Blob) => void
}) => {
  const t = useTranslate()
  const viewport = viewportOf(aspect)
  const [url, setUrl] = useState<string | null>(null)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragging = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  useEffect(() => {
    const next = URL.createObjectURL(file)
    setUrl(next)
    return () => URL.revokeObjectURL(next)
  }, [file])

  useEffect(() => {
    if (url === null) {
      return
    }
    let alive = true
    const image = new Image()
    image.onload = () => {
      if (alive) {
        setNatural({ width: image.naturalWidth, height: image.naturalHeight })
      }
    }
    image.src = url
    return () => {
      alive = false
    }
  }, [url])

  // 基础缩放：让图片刚好盖满可视框，再乘用户缩放
  const base = natural === null ? 1 : Math.max(viewport.width / natural.width, viewport.height / natural.height)
  const scale = base * zoom

  // 边界：图必须始终盖满可视框，避免露出空白
  const clamp = (next: { x: number; y: number }, currentScale: number) => {
    if (natural === null) {
      return next
    }
    const maxX = Math.max(0, (natural.width * currentScale - viewport.width) / 2)
    const maxY = Math.max(0, (natural.height * currentScale - viewport.height) / 2)
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    }
  }

  useEffect(() => {
    setOffset((current) => clamp(current, scale))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, natural])

  const confirm = async () => {
    if (natural === null || url === null) {
      return
    }
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('decode failed'))
      element.src = url
    })
    // 可视区域左上角在图片坐标系里的位置
    const left = (viewport.width - natural.width * scale) / 2 + offset.x
    const top = (viewport.height - natural.height * scale) / 2 + offset.y
    const sx = -left / scale
    const sy = -top / scale
    const sw = viewport.width / scale
    const sh = viewport.height / scale
    const { width, height } = outputOf(aspect, viewport)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      return
    }
    context.drawImage(image, sx, sy, sw, sh, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, aspect === 'square' ? 'image/png' : 'image/jpeg', 0.9)
    )
    if (blob) {
      onConfirm(blob)
    }
  }

  return (
    <Modal
      title={t('cropTitle')}
      closable
      className={styles.dialog}
      onClose={onCancel}
      footer={
        <div className={styles.footer}>
          <Button size="m" variant="outlined" onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button size="m" variant="primary" disabled={natural === null} onClick={() => void confirm()}>
            {t('cropConfirm')}
          </Button>
        </div>
      }
    >
      <div className={styles.body}>
        <div
          className={styles.viewport}
          style={{ width: viewport.width, height: viewport.height }}
          onPointerDown={(event) => {
            dragging.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const start = dragging.current
            if (start === null) {
              return
            }
            setOffset(
              clamp(
                { x: start.ox + (event.clientX - start.x), y: start.oy + (event.clientY - start.y) },
                scale
              )
            )
          }}
          onPointerUp={() => {
            dragging.current = null
          }}
          onPointerCancel={() => {
            dragging.current = null
          }}
        >
          {url !== null ? (
            <img
              className={styles.image}
              src={url}
              alt=""
              draggable={false}
              style={{
                width: natural === null ? '100%' : natural.width * scale,
                height: natural === null ? '100%' : natural.height * scale,
                transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
              }}
            />
          ) : null}
          <div className={styles.mask} />
        </div>
        <div className={styles.controls}>
          <span className={styles.hint}>{t('cropHint')}</span>
          <input
            className={styles.slider}
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            aria-label={t('cropZoom')}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
        </div>
      </div>
    </Modal>
  )
}
