import clsx from 'clsx'
import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  BUBBLE_PRESETS,
  setBubbleColor,
  setUserAvatar,
  useAppearance,
} from '../../services/appearance.js'
import { HIDDEN_FILE_INPUT_STYLE } from '../../utils/hiddenFileInput.js'
import { toAvatarDataUrl } from '../../utils/image.js'
import { Button } from '../base/Button.js'
import { IconCheckOutline16 } from '../base/icons.js'
import { ImageCropDialog } from '../base/ImageCropDialog.js'
import { showToast } from '../base/toastState.js'
import settingsStyles from './Settings.module.css'

/** 没设头像时的占位：简单人形，配色跟主题走，不抢眼 */
const AvatarPlaceholder = () => (
  <svg viewBox="0 0 40 40" fill="none" aria-hidden>
    <circle cx="20" cy="14.5" r="6.5" fill="currentColor" opacity="0.5" />
    <path
      d="M7 34c1.6-6.4 6.7-10 13-10s11.4 3.6 13 10"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      opacity="0.5"
    />
  </svg>
)

/** 调色盘色块里的小图标，提示这里能自己取色 */
const PaletteIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M8 1.6a6.4 6.4 0 1 0 0 12.8c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1a1.4 1.4 0 0 1 1.1-2.3h1.2c2 0 3.1-1.4 3.1-3.1C14.5 3.3 11.6 1.6 8 1.6Z"
      stroke="currentColor"
      strokeWidth="1.2"
    />
    <circle cx="5.2" cy="5.4" r="0.9" fill="currentColor" />
    <circle cx="9.2" cy="4.3" r="0.9" fill="currentColor" />
    <circle cx="4.5" cy="9.2" r="0.9" fill="currentColor" />
  </svg>
)

/** 和设置弹窗里其它行同一套排版（SettingCell 在 SettingsDialog 内部，这里不引它免得循环依赖） */
const Row = ({
  label,
  description,
  action,
  className,
}: {
  label: string
  description: string
  action: React.ReactNode
  className?: string
}) => (
  <div
    className={clsx(
      settingsStyles.cell,
      settingsStyles.row,
      settingsStyles.appearanceCell,
      className
    )}
  >
    <div className={settingsStyles.text}>
      <div className={settingsStyles.label}>{label}</div>
      <div className={settingsStyles.description}>{description}</div>
    </div>
    {action}
  </div>
)

/** 设置 - 通用：我的头像、气泡颜色。改完立即生效，存在本机 */
export const AppearanceSetting = () => {
  const t = useTranslate()
  const userAvatar = useAppearance((state) => state.userAvatar)
  const bubbleColor = useAppearance((state) => state.bubbleColor)
  const fileRef = useRef<HTMLInputElement>(null)
  const [cropFile, setCropFile] = useState<File | null>(null)
  // 取色器里挑过、且不属于预设色的颜色：只有它需要把色块染成当前色
  const customColor =
    bubbleColor !== null && !BUBBLE_PRESETS.some((preset) => preset.color === bubbleColor)

  /** 裁好的方图再压成 128px 的 data URL 存本机；失败给提示，不静默当没选 */
  const applyCrop = async (blob: Blob) => {
    try {
      const avatar = await toAvatarDataUrl(new File([blob], 'avatar.png', { type: 'image/png' }))
      if (avatar === null) {
        showToast({ key: 'userAvatarFailed', type: 'error' })
        return
      }
      setUserAvatar(avatar)
    } catch {
      showToast({ key: 'userAvatarFailed', type: 'error' })
    }
  }

  return (
    <>
      <Row
        label={t('settingsUserAvatar')}
        description={t('userAvatarHint')}
        action={
          <div className={settingsStyles.avatarActions}>
            <span className={settingsStyles.avatarPreview}>
              {userAvatar !== null ? <img src={userAvatar} alt="" /> : <AvatarPlaceholder />}
            </span>
            <Button
              variant="outlined"
              size="m"
              className={settingsStyles.cellButton}
              onClick={() => fileRef.current?.click()}
            >
              {t('userAvatarPick')}
            </Button>
            {userAvatar !== null ? (
              <Button
                variant="outlined"
                size="m"
                className={settingsStyles.cellButton}
                onClick={() => setUserAvatar(null)}
              >
                {t('userAvatarRemove')}
              </Button>
            ) : null}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={HIDDEN_FILE_INPUT_STYLE}
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) {
                  setCropFile(file)
                }
              }}
            />
          </div>
        }
      />
      <Row
        label={t('settingsBubbleColor')}
        description={t('bubbleColorHint')}
        className={settingsStyles.bubbleCell}
        action={
          <div className={settingsStyles.bubbleActions}>
            <div
              role="group"
              aria-label={t('settingsBubbleColor')}
              className={settingsStyles.bubbleSwatches}
            >
              <button
                type="button"
                className={clsx(
                  settingsStyles.bubbleSwatch,
                  settingsStyles.bubbleSwatchTheme,
                  bubbleColor === null && settingsStyles.bubbleSwatchSelected
                )}
                aria-label={t('bubbleColorDefault')}
                aria-pressed={bubbleColor === null}
                onClick={() => setBubbleColor(null)}
              >
                {bubbleColor === null ? <IconCheckOutline16 /> : null}
              </button>
              {BUBBLE_PRESETS.map((preset) => {
                const selected = bubbleColor === preset.color
                return (
                  <button
                    key={preset.id}
                    type="button"
                    className={clsx(
                      settingsStyles.bubbleSwatch,
                      selected && settingsStyles.bubbleSwatchSelected
                    )}
                    style={{ backgroundColor: preset.color }}
                    aria-label={t(preset.labelKey)}
                    aria-pressed={selected}
                    onClick={() => setBubbleColor(preset.color)}
                  >
                    {selected ? <IconCheckOutline16 /> : null}
                  </button>
                )
              })}
              <span
                className={clsx(
                  settingsStyles.bubbleSwatch,
                  settingsStyles.bubbleCustom,
                  customColor && settingsStyles.bubbleSwatchSelected
                )}
                style={
                  customColor && bubbleColor !== null
                    ? { background: bubbleColor }
                    : undefined
                }
              >
                <PaletteIcon />
                <input
                  type="color"
                  className={settingsStyles.bubbleColorInput}
                  aria-label={t('bubbleColorCustom')}
                  value={bubbleColor ?? '#dbefff'}
                  onChange={(event) => setBubbleColor(event.currentTarget.value)}
                />
              </span>
            </div>
            <Button
              variant="outlined"
              size="m"
              className={settingsStyles.cellButton}
              disabled={bubbleColor === null}
              onClick={() => setBubbleColor(null)}
            >
              {t('bubbleColorReset')}
            </Button>
          </div>
        }
      />
      {cropFile !== null ? (
        <ImageCropDialog
          file={cropFile}
          aspect="square"
          onCancel={() => setCropFile(null)}
          onConfirm={(blob) => {
            setCropFile(null)
            void applyCrop(blob)
          }}
        />
      ) : null}
    </>
  )
}
