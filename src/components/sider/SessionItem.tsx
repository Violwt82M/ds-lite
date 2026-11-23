import clsx from 'clsx'
import { memo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCopyOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconPinOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import {
  duplicateSession,
  pinSession,
  renameSession,
  selectSession,
  unpinSession,
} from '../../services/chat/store.js'
import {
  clearScopedWallpaper,
  setScopedWallpaperBlob,
  useWallpaper,
} from '../../services/wallpaper.js'
import { HIDDEN_FILE_INPUT_STYLE } from '../../utils/hiddenFileInput.js'
import { showToast } from '../base/toastState.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { ImageCropDialog } from '../base/ImageCropDialog.js'
import { Menu } from '../base/Menu.js'
import { ExportTxtDialog } from './ExportTxtDialog.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  pinned,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  /** 已置顶：列表里靠「置顶」分组体现，菜单里多一个「取消置顶」（列表不再画图钉） */
  pinned: boolean
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [exportTxtOpen, setExportTxtOpen] = useState(false)
  const [bgCropFile, setBgCropFile] = useState<File | null>(null)
  const bgInputRef = useRef<HTMLInputElement>(null)
  const hasSessionBg = useWallpaper((state) => Boolean(state.sessionWallpapers[session.id]))
  const displayTitle = session.title || t('untitledChat')

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <>
      <div
        className={clsx(styles.item, active && styles.active)}
        onClick={() => {
          selectSession(session.id)
          closeMobileSider()
        }}
      >
      <div className={styles.title}>
        {session.memoryBackup ? (
          <span className={styles.backupBadge}>{t('sessionBackupBadge')}</span>
        ) : null}
        {displayTitle}
      </div>
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'pin',
              label: t(pinned ? 'sessionItemMenuPinTop' : 'sessionItemMenuPin'),
              icon: <IconPinOutline16 />,
              onSelect: () => pinSession(session.id),
            },
            ...(pinned
              ? [
                  {
                    key: 'unpin',
                    label: t('sessionItemMenuUnpin'),
                    icon: <IconPinOutline16 />,
                    onSelect: () => unpinSession(session.id),
                  },
                ]
              : []),
            {
              key: 'duplicate',
              label: t('sessionItemMenuDuplicate'),
              icon: <IconCopyOutline16 />,
              onSelect: () => {
                void duplicateSession(session.id).then((id) => {
                  if (id) {
                    showToast({ key: 'sessionDuplicatedToast' })
                    closeMobileSider()
                  }
                })
              },
            },
            {
              key: 'exportTxt',
              label: '导出当前对话（txt）',
              icon: <IconDownloadOutline16 />,
              onSelect: () => setExportTxtOpen(true),
            },
            {
              key: 'sessionWallpaper',
              label: hasSessionBg ? '更换会话聊天背景' : '设置会话聊天背景',
              icon: <IconEditOutline16 />,
              onSelect: () => bgInputRef.current?.click(),
            },
            ...(hasSessionBg
              ? [
                  {
                    key: 'clearSessionWallpaper',
                    label: '清除会话聊天背景',
                    icon: <IconTrashOutline16 />,
                    onSelect: () => {
                      void clearScopedWallpaper('session', session.id)
                    },
                  },
                ]
              : []),
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
      </div>
      {exportTxtOpen ? (
        <ExportTxtDialog
          sessionId={session.id}
          sessionTitle={displayTitle}
          onClose={() => setExportTxtOpen(false)}
        />
      ) : null}
      <input
        ref={bgInputRef}
        type="file"
        accept="image/*"
        style={HIDDEN_FILE_INPUT_STYLE}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) {
            setBgCropFile(file)
          }
        }}
      />
      {bgCropFile !== null ? (
        <ImageCropDialog
          file={bgCropFile}
          aspect="screen"
          onCancel={() => setBgCropFile(null)}
          onConfirm={(blob) => {
            setBgCropFile(null)
            void setScopedWallpaperBlob('session', session.id, blob)
          }}
        />
      ) : null}
    </>
  )
})
