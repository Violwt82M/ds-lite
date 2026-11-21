import { useTranslate } from '../../i18n/index.js'
import { IconCameraOutline24, IconPaperclipOutline24, IconPhotoOutline24 } from '../base/icons.js'
import styles from './AttachmentPanel.module.css'

export type AttachmentPanelProps = {
  onCamera: () => void
  onPhoto: () => void
  onFile: () => void
}

/**
 * 「更多」展开后的附件面板（对齐原版）：点开按钮后输入区整体上移，
 * 输入框下方出现拍照 / 相册 / 文件三张卡片，选完自动收起。
 *
 * 注意：官方这里还有一排「系统相册最近照片」缩略图；网页 / WebView 读不到系统相册，
 * 自己做一份「本机最近图片」又要多占存储，所以这里只保留三个入口。
 */
export const AttachmentPanel = ({ onCamera, onPhoto, onFile }: AttachmentPanelProps) => {
  const t = useTranslate()
  return (
    <div className={styles.panel}>
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
