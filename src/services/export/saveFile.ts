import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

/** 浏览器里的普通下载；桌面网页版和 CI 预览都走这条 */
const downloadInBrowser = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 分块转 base64：一次把上百 MB 交给原生层会爆内存 */
const CHUNK_BYTES = 2 * 1024 * 1024

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const step = 0x8000
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
  }
  return btoa(binary)
}

const NATIVE_DIR = 'exports'

/**
 * 把 Blob 交给系统处理。
 * Android WebView 没有下载监听：<a download> 点了什么都不会发生，
 * 所以 APK 里改为分块写入应用缓存目录，再用系统分享面板让用户「保存到文件」或发给自己。
 */
export const saveFile = async (blob: Blob, fileName: string): Promise<void> => {
  if (!Capacitor.isNativePlatform()) {
    downloadInBrowser(blob, fileName)
    return
  }
  const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_')
  const path = `${NATIVE_DIR}/${safeName}`
  // 覆盖同名缓存文件，避免多次导出叠加
  await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {})
  let written = 0
  for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
    const data = toBase64(bytes)
    if (written === 0) {
      await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true })
    } else {
      await Filesystem.appendFile({ path, data, directory: Directory.Cache })
    }
    written += bytes.length
  }
  if (written === 0) {
    await Filesystem.writeFile({ path, data: '', directory: Directory.Cache, recursive: true })
  }
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
  await Share.share({ title: fileName, url: uri, dialogTitle: fileName })
}
