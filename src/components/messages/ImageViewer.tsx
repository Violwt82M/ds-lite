import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import styles from './ImageViewer.module.css'

/**
 * 图片预览：铺满一屏的深色遮罩，图片按屏幕等比缩放（完整显示，不裁切）。
 * 点图片外的任意位置或按 Esc 关闭。
 */
export const ImageViewer = ({
  url,
  name,
  onClose,
}: {
  url: string
  name?: string
  onClose: () => void
}) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    // 捕获阶段拦下 Esc，避免同时关掉下层的设置弹窗
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  return createPortal(
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={onClose}
    >
      <img className={styles.image} src={url} alt={name ?? ''} />
    </div>,
    document.body
  )
}
