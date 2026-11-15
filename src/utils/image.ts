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
