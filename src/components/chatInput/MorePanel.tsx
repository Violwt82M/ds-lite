import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { loadRecentImageBlob, loadRecentImages } from '../../services/chat/recentImages.js'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import {
  IconCameraOutline24,
  IconMoreCircle20,
  IconPaperclipOutline24,
  IconPhotoOutline24,
} from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import styles from './MorePanel.module.css'

export type MorePanelProps = {
  disabled?: boolean
  onCamera: () => void
  onPhoto: () => void
  onFile: () => void
  /** 点最近图片：把原图重新作为附件加入草稿 */
  onPickImage: (file: File) => void
}

/** 最近图片：id + 原图 Blob（点一下直接附加，不用再读一次库） */
type Thumb = { id: string; name: string; blob: Blob; url: string }

/**
 * 输入框的「更多」入口（对齐原版）：
 * 细线圆圈十字图标，点一下顺时针转 45° 变成圆圈叉，同时向上拉出面板——
 * 上面是最近发过的图片（原版是相册最近照片，这里读本机记录），下面是拍照 / 相册 / 文件三张卡片。
 */
export const MorePanel = ({ disabled, onCamera, onPhoto, onFile, onPickImage }: MorePanelProps) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { side: 'top', align: 'end', offset: 8 }
  )
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false))
  const [thumbs, setThumbs] = useState<Thumb[]>([])
  const close = () => setOpen(false)

  // 每次打开都重新取最近图片（可能刚发过新图）；关闭时释放 objectURL
  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    const urls: string[] = []
    void loadRecentImages(6)
      .then(async (images) => {
        const loaded: Thumb[] = []
        for (const image of images) {
          const blob = await loadRecentImageBlob(image.id)
          if (cancelled) {
            return
          }
          // 缩略图只是快捷入口：超大图不加载，避免一次解码好几张原图占满内存
          if (blob && blob.size <= 20 * 1024 * 1024) {
            const url = URL.createObjectURL(blob)
            urls.push(url)
            loaded.push({ ...image, blob, url })
          }
        }
        if (!cancelled) {
          setThumbs(loaded)
        }
      })
      .catch(() => {
        // 取不到最近图片只是少一行缩略图，面板照常可用
      })
    return () => {
      cancelled = true
      urls.forEach((url) => URL.revokeObjectURL(url))
      setThumbs([])
    }
  }, [open])

  const pickImage = (thumb: Thumb) => {
    close()
    onPickImage(
      new File([thumb.blob], thumb.name || 'image', { type: thumb.blob.type || 'image/png' })
    )
  }

  const action = (onSelect: () => void) => () => {
    close()
    onSelect()
  }

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        <IconButton
          size="m"
          tone="primary"
          tooltip={t('moreAttach')}
          disabled={disabled}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((value) => !value)}
          icon={
            <span className={clsx(styles.glyph, open && styles.glyphOpen)}>
              <IconMoreCircle20 />
            </span>
          }
        />
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.panel}
              style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
              role="dialog"
              aria-label={t('moreAttach')}
            >
              {thumbs.length > 0 ? (
                <div className={styles.recent}>
                  {thumbs.map((thumb) => (
                    <button
                      key={thumb.id}
                      type="button"
                      className={styles.recentItem}
                      aria-label={t('moreRecentImage', { name: thumb.name })}
                      onClick={() => pickImage(thumb)}
                    >
                      <img src={thumb.url} alt="" />
                    </button>
                  ))}
                </div>
              ) : null}
              <div className={styles.actions}>
                <button type="button" className={styles.action} onClick={action(onCamera)}>
                  <span className={styles.actionIcon}>
                    <IconCameraOutline24 />
                  </span>
                  {t('moreCamera')}
                </button>
                <button type="button" className={styles.action} onClick={action(onPhoto)}>
                  <span className={styles.actionIcon}>
                    <IconPhotoOutline24 />
                  </span>
                  {t('morePhoto')}
                </button>
                <button type="button" className={styles.action} onClick={action(onFile)}>
                  <span className={styles.actionIcon}>
                    <IconPaperclipOutline24 />
                  </span>
                  {t('moreFile')}
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
