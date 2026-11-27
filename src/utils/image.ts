/** 图片处理：把用户选的图片压成方形小头像（data URL），避免把几 MB 的原图塞进 localStorage */

const AVATAR_SIZE = 128

const loadImage = (url: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = url
  })

/**
 * 生成 128×128 的居中裁切头像，输出 PNG（保留透明底）。
 * 失败返回 null，调用侧按「没设置头像」处理。
 */
export const toAvatarDataUrl = async (file: File): Promise<string | null> => {
  if (!file.type.startsWith('image/')) {
    return null
  }
  const source = URL.createObjectURL(file)
  try {
    const image = await loadImage(source)
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_SIZE
    canvas.height = AVATAR_SIZE
    const context = canvas.getContext('2d')
    if (!context) {
      return null
    }
    // 居中裁成正方形，避免头像被拉扁
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    const sx = (image.naturalWidth - side) / 2
    const sy = (image.naturalHeight - side) / 2
    context.drawImage(image, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
    const dataUrl = canvas.toDataURL('image/png')
    // 极端情况下（超大画布）转出来仍然很大，超了就当没有
    return dataUrl.length > 400_000 ? null : dataUrl
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(source)
  }
}

/** 聊天发图自动压缩：限制长边与质量，把 8–12MB 手机原图压到 200–400KB，避免撞服务端 total size of image 上限 */
const CHAT_IMAGE_MAX_EDGE = 1920
const CHAT_IMAGE_SKIP_BYTES = 350 * 1024
const CHAT_IMAGE_QUALITY = 0.85

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality: number) =>
  new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality)
  })

const replaceExtWithJpg = (name: string): string => {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  return `${base || 'image'}.jpg`
}

/**
 * 聊天图片无感高清压缩：
 * - GIF 动图直接保留原样；
 * - 尺寸已在 1920px 以内且体积 ≤ 350KB 的小图不二次重编码；
 * - 其余按等比缩放到长边 ≤ 1920px 并导出 JPEG（0.85），若压缩后反而变大或解码失败则安全退回原图。
 */
export const compressChatImage = async (file: File): Promise<File> => {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') {
    return file
  }
  if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    return file
  }
  const source = URL.createObjectURL(file)
  try {
    const image = await loadImage(source)
    const { naturalWidth: width, naturalHeight: height } = image
    if (!width || !height) {
      return file
    }
    const maxSide = Math.max(width, height)
    if (maxSide <= CHAT_IMAGE_MAX_EDGE && file.size <= CHAT_IMAGE_SKIP_BYTES) {
      return file
    }
    const scale = maxSide > CHAT_IMAGE_MAX_EDGE ? CHAT_IMAGE_MAX_EDGE / maxSide : 1
    const targetWidth = Math.max(1, Math.round(width * scale))
    const targetHeight = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const context = canvas.getContext('2d')
    if (!context) {
      return file
    }
    // 透明 PNG 转 JPEG 时先铺白底，避免透明区域变黑
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, targetWidth, targetHeight)
    context.drawImage(image, 0, 0, targetWidth, targetHeight)
    const blob = await canvasToBlob(canvas, 'image/jpeg', CHAT_IMAGE_QUALITY)
    if (!blob || blob.size >= file.size) {
      return file
    }
    return new File([blob], replaceExtWithJpg(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    })
  } catch {
    return file
  } finally {
    URL.revokeObjectURL(source)
  }
}
