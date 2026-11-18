import { create } from 'zustand'
import type { TranslationKey } from '../i18n/index.js'

/**
 * 头像与气泡色：纯本机外观偏好。
 * 存 localStorage 而不是 IndexedDB —— 数据只有几 KB，启动时要同步读回来，
 * 否则首帧会先闪一下默认气泡再变色。
 */
const AVATAR_KEY = 'chat-demo:user-avatar'
const BUBBLE_KEY = 'chat-demo:user-bubble'

const AVATAR_PREFIX = 'data:image/'
const HEX_COLOR = /^#[0-9a-f]{6}$/i

/** 只认本站生成的 data URL：外面的字符串塞进来消息列表会渲染不出来 */
const isAvatar = (value: string): boolean => value.startsWith(AVATAR_PREFIX)

const isBubbleColor = (value: string): boolean => HEX_COLOR.test(value)

export type BubblePreset = {
  id: string
  /** 不透明底色 #rrggbb；UI 只画色块，名字留给读屏 */
  color: string
  labelKey: TranslationKey
}

/**
 * 预设气泡色：冷/暖/中性各来一点，最后一个深色会触发白字。
 * 浅蓝放在第一个，和主题默认气泡接近，方便用户对照「原来是什么样」。
 */
export const BUBBLE_PRESETS: readonly BubblePreset[] = [
  { id: 'blue', color: '#dbefff', labelKey: 'bubbleColorBlue' },
  { id: 'gray', color: '#e9eaec', labelKey: 'bubbleColorGray' },
  { id: 'pink', color: '#ffdde8', labelKey: 'bubbleColorPink' },
  { id: 'purple', color: '#e8ddff', labelKey: 'bubbleColorPurple' },
  { id: 'green', color: '#dbf2e1', labelKey: 'bubbleColorGreen' },
  { id: 'yellow', color: '#fff2cc', labelKey: 'bubbleColorYellow' },
  { id: 'orange', color: '#ffe2c7', labelKey: 'bubbleColorOrange' },
  { id: 'red', color: '#ffdcdc', labelKey: 'bubbleColorRed' },
  { id: 'cyan', color: '#d5f1f3', labelKey: 'bubbleColorCyan' },
  { id: 'deep', color: '#2c2c2e', labelKey: 'bubbleColorDeep' },
]

export type AppearanceState = {
  /** 128px PNG data URL；null = 不显示头像 */
  userAvatar: string | null
  /** #rrggbb；null = 跟随主题默认气泡色 */
  bubbleColor: string | null
}

/** 坏数据一律按没设置处理：外观设置坏了不能阻塞启动 */
const readSaved = (key: string, isValid: (value: string) => boolean): string | null => {
  try {
    const saved = localStorage.getItem(key)
    return saved !== null && isValid(saved) ? saved : null
  } catch {
    return null
  }
}

export const useAppearance = create<AppearanceState>(() => ({
  userAvatar: readSaved(AVATAR_KEY, isAvatar),
  bubbleColor: readSaved(BUBBLE_KEY, isBubbleColor),
}))

const parseRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

/**
 * 气泡上的字色：底色深就用白字，浅色用固定的深色字。
 * 这里不能用 --dsw-alias-label-primary：深色主题下它是浅色，落在浅色气泡上
 * 会变成白字浅底看不清。static 色板不随主题变，深色主题配浅色气泡也能读。
 * 亮度按人眼加权算，和 wallpaper.ts 判断背景深浅是同一套思路。
 */
const textColorFor = (hex: string): string => {
  const [r, g, b] = parseRgb(hex)
  return (r * 299 + g * 587 + b * 114) / 1000 < 140
    ? '#ffffff'
    : 'var(--dsw-static-neutral-bluish-1000)'
}

/** 把外观写到 body 上：CSS 只认 data 属性和变量，气泡组件不用重复算颜色 */
const applyAppearance = () => {
  const { bubbleColor } = useAppearance.getState()
  const body = document.body
  body.dataset.userBubble = bubbleColor === null ? '0' : '1'
  if (bubbleColor === null) {
    body.style.removeProperty('--ds-user-bubble-bg')
    body.style.removeProperty('--ds-user-bubble-bg-soft')
    body.style.removeProperty('--ds-user-bubble-text')
    return
  }
  const [r, g, b] = parseRgb(bubbleColor)
  body.style.setProperty('--ds-user-bubble-bg', bubbleColor)
  // 有背景图时气泡要透一点，底下的模糊才看得见；0.82 和现有默认气泡的透明度对齐
  body.style.setProperty('--ds-user-bubble-bg-soft', `rgba(${r}, ${g}, ${b}, 0.82)`)
  body.style.setProperty('--ds-user-bubble-text', textColorFor(bubbleColor))
}

export const setupAppearance = () => {
  applyAppearance()
  useAppearance.subscribe(applyAppearance)
}

/** 写入失败只在内存里生效，和 settings.ts / persona store 的处理保持一致 */
const persist = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存不下只影响下次打开
  }
}

export const setUserAvatar = (avatar: string | null) => {
  // 调用侧可能传裁剪失败的空值，统一在这里挡住
  const next = avatar !== null && isAvatar(avatar) ? avatar : null
  useAppearance.setState({ userAvatar: next })
  persist(AVATAR_KEY, next)
}

export const setBubbleColor = (color: string | null) => {
  // 统一小写：预设色和取色器返回的大小写不稳定，比较时会漏掉
  const next = color !== null && isBubbleColor(color) ? color.toLowerCase() : null
  useAppearance.setState({ bubbleColor: next })
  persist(BUBBLE_KEY, next)
}
