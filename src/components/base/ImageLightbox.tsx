import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import styles from './ImageLightbox.module.css'

/** 点输入框里已加的图片预览：全屏放大看大图，点任意处 / Esc 关闭 */
export const ImageLightbox = ({
  src,
  alt,
  onClose,
}: {
  src: string
  alt?: string
  onClose: () => void
}) => {
  const t = useTranslate()
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <div
      className={styles.mask}
      role="dialog"
      aria-modal="true"
      aria-label={alt || t('previewImage')}
      onClick={onClose}
    >
      <img className={styles.image} src={src} alt={alt || ''} />
    </div>,
    document.body
  )
}
