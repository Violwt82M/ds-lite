import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'

const inferFileName = (url: URL): string => {
  const segment = url.pathname.split('/').filter(Boolean).at(-1) ?? ''
  const decoded = (() => {
    try {
      return decodeURIComponent(segment)
    } catch {
      return segment
    }
  })()
  const cleaned = decoded.replace(/[\\/:*?"<>|]/g, '_').trim()
  if (cleaned && cleaned.toLowerCase().endsWith('.zip')) {
    return cleaned
  }
  return cleaned ? `${cleaned}.zip` : 'deepseek-export.zip'
}

const isZipBlob = async (blob: Blob): Promise<boolean> => {
  if (blob.size < 4) {
    return false
  }
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  // ZIP 文件头魔数：PK\x03\x04 / PK\x05\x06 / PK\x07\x08
  return head[0] === 0x50 && head[1] === 0x4b
}

/**
 * APK 端通过 DeepSeek 官方导出下载链接拉取 ZIP 压缩包并转为 File，
 * 走 Capacitor 原生下载避免 WebView CORS 跨域限制与大文件 base64 内存峰值。
 */
export const downloadArchiveFromUrl = async (rawUrl: string): Promise<File> => {
  const trimmed = rawUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('请输入有效的下载链接（以 https:// 开头）')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('仅支持 http:// 或 https:// 下载链接')
  }

  const fileName = inferFileName(parsed)
  const tempPath = `imports/url-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.zip`

  if (!Capacitor.isNativePlatform()) {
    throw new Error('链接直接导入仅支持安卓客户端使用，网页端请先下载 ZIP 到本地再上传')
  }

  try {
    const result = await Filesystem.downloadFile({
      url: parsed.toString(),
      path: tempPath,
      directory: Directory.Cache,
    })
    const uri =
      result.path ?? (await Filesystem.getUri({ path: tempPath, directory: Directory.Cache })).uri
    const response = await fetch(Capacitor.convertFileSrc(uri))
    if (!response.ok) {
      throw new Error(`读取下载文件失败（HTTP ${response.status}）`)
    }
    const blob = await response.blob()
    if (!(await isZipBlob(blob))) {
      throw new Error(
        '链接返回的内容不是有效的 ZIP 压缩包，可能链接已过期或需要登录，请先在浏览器下载到本地后再上传导入'
      )
    }
    return new File([blob], fileName, { type: 'application/zip' })
  } catch (error) {
    if (error instanceof Error && error.message) {
      throw error
    }
    throw new Error('下载失败，请检查网络或确认链接尚未过期')
  } finally {
    await Filesystem.deleteFile({ path: tempPath, directory: Directory.Cache }).catch(() => {})
  }
}
