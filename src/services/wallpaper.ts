import { openDB, type IDBPDatabase } from 'idb'
import { create } from 'zustand'

/**
 * 聊天背景：预设用 CSS 渐变（不占存储），自定义图片压缩后存 IndexedDB
 * （localStorage 只有 5MB，一张 1080p 照片 base64 就爆）。
 */
export type WallpaperPreset = 'none' | 'paper' | 'mist' | 'dusk' | 'custom'

const STORAGE_KEY = 'chat-demo:wallpaper'
const DB_NAME = 'chat-demo-wallpaper'
const STORE = 'images'
const IMAGE_KEY = 'custom'
/** 长边上限：再大对手机屏没意义，只会拖慢启动 */
const MAX_EDGE = 1600

const PRESETS: readonly WallpaperPreset[] = ['none', 'paper', 'mist', 'dusk', 'custom']

let database: Promise<IDBPDatabase> | null = null
const open = () =>
  (database ??= openDB(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore(STORE)
    },
  }))

export const useWallpaper = create<{ preset: WallpaperPreset; customUrl: string | null }>(() => {
  let preset: WallpaperPreset = 'none'
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && (PRESETS as readonly string[]).includes(saved)) {
      preset = saved as WallpaperPreset
    }
  } catch {
    // 存储不可用就用默认
  }
  return { preset, customUrl: null }
})

let objectUrl: string | null = null

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
  setWallpaper('custom')
}

/** 保存自定义背景图并立即切换过去（未裁切时用，内部会等比缩放） */
export const setCustomWallpaper = async (file: File): Promise<void> => {
  const blob = await shrink(file)
  await setCustomWallpaperBlob(blob)
}

export const setWallpaper = (preset: WallpaperPreset) => {
  useWallpaper.setState({ preset })
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
    } else {
      // 图丢了就退回无背景，别留一片空
      setWallpaper('none')
    }
  } catch {
    setWallpaper('none')
  }
}

/** 把当前背景写到 body 上：预设走 CSS 选择器，自定义图注入 CSS 变量 */
const applyWallpaper = () => {
  const { preset, customUrl } = useWallpaper.getState()
  const body = document.body
  body.dataset.wallpaper = preset
  if (preset === 'custom' && customUrl !== null) {
    body.style.setProperty('--ds-wallpaper-image', `url("${customUrl}")`)
  } else {
    body.style.removeProperty('--ds-wallpaper-image')
  }
}

export const setupWallpaper = () => {
  applyWallpaper()
  useWallpaper.subscribe(applyWallpaper)
  void loadWallpaper()
}
