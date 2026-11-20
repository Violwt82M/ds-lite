import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { loadRecentImageBlob, loadRecentImages } from '../../services/chat/recentImages.js'
import { IconCameraOutline24, IconPaperclipOutline24, IconPhotoOutline24 } from '../base/icons.js'
import styles from './AttachmentPanel.module.css'

export type AttachmentPanelProps = {
  onCamera: () => void
  onPhoto: () => void
  onFile: () => void
  /** 点最近图片：把原图作为附件加进草稿（面板不关，可以接着多选） */
  onPickImage: (file: File) => void
}

/** 最近图片：id + 原图 Blob（点一下直接附加，不用再读一次库） */
type Thumb = { id: string; name: string; blob: Blob; url: string }

/**
 * 「更多」展开后的附件面板（对齐原版）：点开按钮后输入框上面这一整块上拉出来——
 * 上面是最近发过的图片（原版是相册最近照片，这里读本机记录），
 * 下面是拍照 / 相册 / 文件三张卡片。面板在输入框下方、随界面一起上移，不遮挡聊天。
 */
export const AttachmentPanel = ({ onCamera, onPhoto, onFile, onPickImage }: AttachmentPanelProps) => {
  const t = useTranslate()
  const [thumbs, setThumbs] = useState<Thumb[]>([])

  // 面板挂载时取一次最近图片；卸载时释放 objectURL
  useEffect(() => {
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
          // 缩略图只是快捷入口：超大图不加载，避免一次解码好几张原图占内存
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
    }
  }, [])

  return (
    <div className={styles.panel}>
      {thumbs.length > 0 ? (
        <div className={styles.thumbs}>
          {thumbs.map((thumb) => (
            <button
              key={thumb.id}
              type="button"
              className={styles.thumb}
              aria-label={t('moreRecentImage', { name: thumb.name })}
              onClick={() =>
                onPickImage(
                  new File([thumb.blob], thumb.name || 'image', {
                    type: thumb.blob.type || 'image/png',
                  })
                )
              }
            >
              <img src={thumb.url} alt="" />
            </button>
          ))}
        </div>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={styles.action} onClick={onCamera}>
          <span className={styles.actionIcon}>
            <IconCameraOutline24 />
          </span>
          {t('moreCamera')}
        </button>
        <button type="button" className={styles.action} onClick={onPhoto}>
          <span className={styles.actionIcon}>
            <IconPhotoOutline24 />
          </span>
          {t('morePhoto')}
        </button>
        <button type="button" className={styles.action} onClick={onFile}>
          <span className={styles.actionIcon}>
            <IconPaperclipOutline24 />
          </span>
          {t('moreFile')}
        </button>
      </div>
    </div>
  )
}
