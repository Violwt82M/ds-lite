import { openDB, type IDBPDatabase } from 'idb'
import { create } from 'zustand'
import { setStatusBarIconsDark, setThemeColor } from './nativeTheme.js'

/**
 * 聊天背景：预设用 CSS 渐变（不占存储），自定义图片压缩后存 IndexedDB
 * （localStorage 只有 5MB，一张 1080p 照片 base64 就爆）。
 */
export type WallpaperPreset = 'none' | 'paper' | 'mist' | 'dusk' | 'custom'

const STORAGE_KEY = 'chat-demo:wallpaper'
const SESSION_WP_INDEX_KEY = 'ds-lite:session-wallpapers'
const PERSONA_WP_INDEX_KEY = 'ds-lite:persona-wallpapers'
const DB_NAME = 'chat-demo-wallpaper'
const STORE = 'images'
const IMAGE_KEY = 'custom'
/** 长边上限：再大对手机屏没意义，只会拖慢启动 */
const MAX_EDGE = 1600

export type WallpaperScope = 'session' | 'persona'

const scopedImageKey = (scope: WallpaperScope, id: string) => `${scope}:${id}`

const readScopeIndex = (key: string): Record<string, true> => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const out: Record<string, true> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === true && k) {
        out[k] = true
      }
    }
    return out
  } catch {
    return {}
  }
}

const writeScopeIndex = (key: string, map: Record<string, true>) => {
  try {
    localStorage.setItem(key, JSON.stringify(map))
  } catch {
    // 忽略存储限制
  }
}

const PRESETS: readonly WallpaperPreset[] = ['none', 'paper', 'mist', 'dusk', 'custom']

let database: Promise<IDBPDatabase> | null = null
const open = () =>
  (database ??= openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(STORE)
    },
  }))

/** 深色背景预设：顶栏与系统状态栏要换成浅色字 */
const DARK_PRESETS: readonly WallpaperPreset[] = ['dusk']

/** 背景够不够深：按平均亮度判断（0~255 取 110 为界），深色背景下白字才看得清 */
const measureDark = async (blob: Blob): Promise<boolean> => {
  try {
    const bitmap = await decode(new File([blob], 'wallpaper', { type: blob.type || 'image/jpeg' }))
    const canvas = document.createElement('canvas')
    canvas.width = 16
    canvas.height = 16
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      return false
    }
    context.drawImage(bitmap, 0, 0, 16, 16)
    if ('close' in bitmap) {
      bitmap.close()
    }
    const { data } = context.getImageData(0, 0, 16, 16)
    let sum = 0
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    }
    return sum / (data.length / 4) < 110
  } catch {
    return false
  }
}

export const useWallpaper = create<{
  preset: WallpaperPreset
  customUrl: string | null
  /** 当前背景是不是深色：决定顶栏和系统状态栏用浅色还是深色 */
  dark: boolean
  /** 当前激活上下文的覆盖背景（优先级：单会话 > 角色卡 > 全局） */
  overrideUrl: string | null
  overrideDark: boolean
  /** 索引：记录哪些会话 / 角色卡设置了独立背景，供 UI 同步判断 */
  sessionWallpapers: Record<string, true>
  personaWallpapers: Record<string, true>
}>(() => {
  let preset: WallpaperPreset = 'none'
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && (PRESETS as readonly string[]).includes(saved)) {
      preset = saved as WallpaperPreset
    }
  } catch {
    // 存储不可用就用默认
  }
  return {
    preset,
    customUrl: null,
    dark: DARK_PRESETS.includes(preset),
    overrideUrl: null,
    overrideDark: false,
    sessionWallpapers: readScopeIndex(SESSION_WP_INDEX_KEY),
    personaWallpapers: readScopeIndex(PERSONA_WP_INDEX_KEY),
  }
})

let objectUrl: string | null = null
let overrideObjectUrl: string | null = null
let activeContext: { sessionId: string | null; personaId: string | null } = {
  sessionId: null,
  personaId: null,
}
let overrideSeq = 0

const setObjectUrl = (blob: Blob | null) => {
  if (objectUrl !== null) {
    URL.revokeObjectURL(objectUrl)
    objectUrl = null
  }
  if (blob !== null) {
    objectUrl = URL.createObjectURL(blob)
  }
  useWallpaper.setState({ customUrl: objectUrl })
}

const setOverrideObjectUrl = (blob: Blob | null, dark: boolean) => {
  if (overrideObjectUrl !== null) {
    URL.revokeObjectURL(overrideObjectUrl)
    overrideObjectUrl = null
  }
  if (blob !== null) {
    overrideObjectUrl = URL.createObjectURL(blob)
  }
  useWallpaper.setState({ overrideUrl: overrideObjectUrl, overrideDark: blob !== null ? dark : false })
}

/** 老 WebView / iOS 14 没有 createImageBitmap，退回 <img> 解码 */
const decode = async (file: File): Promise<ImageBitmap | HTMLImageElement> => {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file)
    } catch {
      // 某些格式解不开，继续走 <img>
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('decode failed'))
    }
    image.src = url
  })
}

/** 把选中的图片缩到长边 1600px 再存，避免几 MB 的原图进库 */
const shrink = async (file: File): Promise<Blob> => {
  const bitmap = await decode(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('canvas unavailable')
  }
  context.drawImage(bitmap, 0, 0, width, height)
  if ('close' in bitmap) {
    bitmap.close()
  }
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error('encode failed')) : resolve(blob)),
      'image/jpeg',
      0.82
    )
  })
}

/** 保存已经裁好的背景图（框选对话框产出） */
export const setCustomWallpaperBlob = async (blob: Blob): Promise<void> => {
  const db = await open()
  await db.put(STORE, blob, IMAGE_KEY)
  setObjectUrl(blob)
  const dark = await measureDark(blob)
  useWallpaper.setState({ dark })
  setWallpaper('custom')
}

/** 保存自定义背景图并立即切换过去（未裁切时用，内部会等比缩放） */
export const setCustomWallpaper = async (file: File): Promise<void> => {
  const blob = await shrink(file)
  await setCustomWallpaperBlob(blob)
}

export const setWallpaper = (preset: WallpaperPreset) => {
  // 自定义图沿用测出来的深浅；预设图按预设判断
  useWallpaper.setState(
    preset === 'custom' ? { preset } : { preset, dark: DARK_PRESETS.includes(preset) }
  )
  try {
    localStorage.setItem(STORAGE_KEY, preset)
  } catch {
    // 存不下只影响下次打开
  }
}

/** 启动时读回自定义图（只有选了 custom 才需要） */
export const loadWallpaper = async (): Promise<void> => {
  const { preset } = useWallpaper.getState()
  if (preset !== 'custom') {
    return
  }
  try {
    const db = await open()
    const blob = (await db.get(STORE, IMAGE_KEY)) as Blob | undefined
    if (blob) {
      setObjectUrl(blob)
      useWallpaper.setState({ dark: await measureDark(blob) })
    } else {
      // 图丢了就退回无背景，别留一片空
      setWallpaper('none')
    }
  } catch {
    setWallpaper('none')
  }
}

/** 按优先级解析当前生效的覆盖背景：单会话 > 角色卡 > 无覆盖（回退全局） */
const resolveOverride = async (): Promise<void> => {
  const seq = (overrideSeq += 1)
  const state = useWallpaper.getState()
  const { sessionId, personaId } = activeContext
  let key: string | null = null
  if (sessionId && state.sessionWallpapers[sessionId]) {
    key = scopedImageKey('session', sessionId)
  } else if (personaId && state.personaWallpapers[personaId]) {
    key = scopedImageKey('persona', personaId)
  }
  if (key === null) {
    setOverrideObjectUrl(null, false)
    return
  }
  try {
    const db = await open()
    const blob = (await db.get(STORE, key)) as Blob | undefined
    if (seq !== overrideSeq) {
      return
    }
    if (blob) {
      const dark = await measureDark(blob)
      if (seq !== overrideSeq) {
        return
      }
      setOverrideObjectUrl(blob, dark)
    } else {
      setOverrideObjectUrl(null, false)
    }
  } catch {
    if (seq === overrideSeq) {
      setOverrideObjectUrl(null, false)
    }
  }
}

/** 切换当前激活的会话/角色卡上下文，自动刷新背景优先级（单会话 > 角色卡 > 全局） */
export const setActiveWallpaperContext = (sessionId: string | null, personaId: string | null) => {
  if (activeContext.sessionId === sessionId && activeContext.personaId === personaId) {
    return
  }
  activeContext = { sessionId, personaId }
  void resolveOverride()
}

export const hasScopedWallpaper = (scope: WallpaperScope, id: string): boolean => {
  const state = useWallpaper.getState()
  return Boolean(scope === 'session' ? state.sessionWallpapers[id] : state.personaWallpapers[id])
}

/** 保存单会话或角色卡专属背景（框选对话框产出） */
export const setScopedWallpaperBlob = async (
  scope: WallpaperScope,
  id: string,
  blob: Blob
): Promise<void> => {
  const db = await open()
  await db.put(STORE, blob, scopedImageKey(scope, id))
  if (scope === 'session') {
    const next = { ...useWallpaper.getState().sessionWallpapers, [id]: true as const }
    useWallpaper.setState({ sessionWallpapers: next })
    writeScopeIndex(SESSION_WP_INDEX_KEY, next)
  } else {
    const next = { ...useWallpaper.getState().personaWallpapers, [id]: true as const }
    useWallpaper.setState({ personaWallpapers: next })
    writeScopeIndex(PERSONA_WP_INDEX_KEY, next)
  }
  await resolveOverride()
}

/** 清除单会话或角色卡专属背景（自动回退到下一优先级） */
export const clearScopedWallpaper = async (scope: WallpaperScope, id: string): Promise<void> => {
  try {
    const db = await open()
    await db.delete(STORE, scopedImageKey(scope, id))
  } catch {
    // 忽略删除异常
  }
  if (scope === 'session') {
    const next = Object.fromEntries(
      Object.entries(useWallpaper.getState().sessionWallpapers).filter(([k]) => k !== id)
    ) as Record<string, true>
    useWallpaper.setState({ sessionWallpapers: next })
    writeScopeIndex(SESSION_WP_INDEX_KEY, next)
  } else {
    const next = Object.fromEntries(
      Object.entries(useWallpaper.getState().personaWallpapers).filter(([k]) => k !== id)
    ) as Record<string, true>
    useWallpaper.setState({ personaWallpapers: next })
    writeScopeIndex(PERSONA_WP_INDEX_KEY, next)
  }
  await resolveOverride()
}

/** 同步顶栏与系统状态栏明暗：深色主题或深色壁纸任一成立均切为深色状态栏 + 浅色图标 */
export const syncStatusBarAppearance = () => {
  const { preset, dark, overrideUrl, overrideDark } = useWallpaper.getState()
  const body = document.body
  const darkTheme = body.classList.contains('dark')
  const darkBackdrop = overrideUrl !== null ? overrideDark : preset !== 'none' && dark
  const useDarkBar = darkTheme || darkBackdrop
  body.dataset.wallpaperDark = darkBackdrop ? '1' : '0'
  setStatusBarIconsDark(useDarkBar)
  setThemeColor(useDarkBar ? '#14161c' : '#ffffff')
}

/** 把当前背景写到 body 上：优先显示单会话/角色卡覆盖背景，否则回退到全局预设或自定义图 */
const applyWallpaper = () => {
  const { preset, customUrl, overrideUrl } = useWallpaper.getState()
  const body = document.body
  if (overrideUrl !== null) {
    body.dataset.wallpaper = 'custom'
    body.style.setProperty('--ds-wallpaper-image', `url("${overrideUrl}")`)
    syncStatusBarAppearance()
    return
  }
  body.dataset.wallpaper = preset
  if (preset === 'custom' && customUrl !== null) {
    body.style.setProperty('--ds-wallpaper-image', `url("${customUrl}")`)
  } else {
    body.style.removeProperty('--ds-wallpaper-image')
  }
  syncStatusBarAppearance()
}

export const setupWallpaper = () => {
  applyWallpaper()
  useWallpaper.subscribe(applyWallpaper)
  void loadWallpaper()
}
