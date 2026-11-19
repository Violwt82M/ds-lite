import clsx from 'clsx'
import { useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  AI_BUBBLE_PRESETS,
  BUBBLE_PRESETS,
  setAiBubbleColor,
  setBubbleColor,
  setUserAvatar,
  useAppearance,
  type BubblePreset,
} from '../../services/appearance.js'
import { HIDDEN_FILE_INPUT_STYLE } from '../../utils/hiddenFileInput.js'
import { toAvatarDataUrl } from '../../utils/image.js'
import { setAiBubble, setBubbleSkin, useSettings } from '../../services/settings.js'
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

/**
 * 一行气泡色选择：默认色 + 预设色板 + 调色盘 + 恢复默认。
 * 用户气泡和 AI 气泡只差文案、色板和「默认」那格的预览色，抽出来共用一套；
 * 取色器里挑过、且不属于预设色的颜色，只有它需要把色块染成当前色。
 */
const BubbleColorRow = ({
  label,
  description,
  presets,
  color,
  themeSwatchClassName,
  fallbackColor,
  onChange,
}: {
  label: string
  description: string
  presets: readonly BubblePreset[]
  color: string | null
  themeSwatchClassName: string
  fallbackColor: string
  onChange: (color: string | null) => void
}) => {
  const t = useTranslate()
  const customColor = color !== null && !presets.some((preset) => preset.color === color)

  return (
    <Row
      label={label}
      description={description}
      className={settingsStyles.bubbleCell}
      action={
        <div className={settingsStyles.bubbleActions}>
          <div role="group" aria-label={label} className={settingsStyles.bubbleSwatches}>
            <button
              type="button"
              className={clsx(
                settingsStyles.bubbleSwatch,
                themeSwatchClassName,
                color === null && settingsStyles.bubbleSwatchSelected
              )}
              aria-label={t('bubbleColorDefault')}
              aria-pressed={color === null}
              onClick={() => onChange(null)}
            >
              {color === null ? <IconCheckOutline16 /> : null}
            </button>
            {presets.map((preset) => {
              const selected = color === preset.color
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
                  onClick={() => onChange(preset.color)}
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
              style={customColor && color !== null ? { background: color } : undefined}
            >
              <PaletteIcon />
              <input
                type="color"
                className={settingsStyles.bubbleColorInput}
                aria-label={t('bubbleColorCustom')}
                value={color ?? fallbackColor}
                onChange={(event) => onChange(event.currentTarget.value)}
              />
            </span>
          </div>
          <Button
            variant="outlined"
            size="m"
            className={settingsStyles.cellButton}
            disabled={color === null}
            onClick={() => onChange(null)}
          >
            {t('bubbleColorReset')}
          </Button>
        </div>
      }
    />
  )
}

/** 设置 - 通用：我的头像、用户/AI 气泡颜色、消息气泡开关。改完立即生效，存在本机 */
export const AppearanceSetting = () => {
  const t = useTranslate()
  const userAvatar = useAppearance((state) => state.userAvatar)
  const bubbleColor = useAppearance((state) => state.bubbleColor)
  const aiBubbleColor = useAppearance((state) => state.aiBubbleColor)
  const bubbleSkin = useSettings((state) => state.bubbleSkin)
  const aiBubble = useSettings((state) => state.aiBubble)
  const fileRef = useRef<HTMLInputElement>(null)
  const [cropFile, setCropFile] = useState<File | null>(null)

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
      <BubbleColorRow
        label={t('settingsBubbleColor')}
        description={t('bubbleColorHint')}
        presets={BUBBLE_PRESETS}
        color={bubbleColor}
        themeSwatchClassName={settingsStyles.bubbleSwatchTheme}
        fallbackColor="#dbefff"
        onChange={setBubbleColor}
      />
      <BubbleColorRow
        label={t('settingsAiBubbleColor')}
        description={t('aiBubbleHint')}
        presets={AI_BUBBLE_PRESETS}
        color={aiBubbleColor}
        themeSwatchClassName={settingsStyles.bubbleSwatchAi}
        fallbackColor="#ffffff"
        onChange={setAiBubbleColor}
      />
      <Row
        label={t('settingsBubbleSkin')}
        description={t('bubbleSkinHint')}
        action={
          <Button
            variant={bubbleSkin ? 'primary' : 'outlined'}
            size="m"
            className={settingsStyles.cellButton}
            onClick={() => setBubbleSkin(!bubbleSkin)}
          >
            {t(bubbleSkin ? 'bubbleSkinOn' : 'bubbleSkinOff')}
          </Button>
        }
      />
      <Row
        label={t('settingsAiBubble')}
        description={t('aiOutputBubbleHint')}
        action={
          <Button
            variant={aiBubble ? 'primary' : 'outlined'}
            size="m"
            className={settingsStyles.cellButton}
            onClick={() => setAiBubble(!aiBubble)}
          >
            {t(aiBubble ? 'bubbleSkinOn' : 'bubbleSkinOff')}
          </Button>
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
