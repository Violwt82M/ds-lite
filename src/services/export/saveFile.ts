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

/** 分块写入指定目录；同名文件先删掉，避免多次导出叠加 */
const writeToDirectory = async (
  blob: Blob,
  path: string,
  directory: Directory
): Promise<void> => {
  await Filesystem.deleteFile({ path, directory }).catch(() => {})
  let written = 0
  for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
    const data = toBase64(bytes)
    if (written === 0) {
      await Filesystem.writeFile({ path, data, directory, recursive: true })
    } else {
      await Filesystem.appendFile({ path, data, directory })
    }
    written += bytes.length
  }
  if (written === 0) {
    await Filesystem.writeFile({ path, data: '', directory, recursive: true })
  }
}

type HarmonyBridgeResult = {
  ok: boolean
  token?: string
  error?: string
}

const getHarmonyBridge = (): Window['DsLiteHarmony'] | undefined => {
  if (typeof window === 'undefined') {
    return undefined
  }
  if (window.__DS_LITE_PLATFORM__ !== 'harmonyos') {
    return undefined
  }
  const bridge = window.DsLiteHarmony
  if (
    !bridge ||
    typeof bridge.beginExport !== 'function' ||
    typeof bridge.appendExport !== 'function' ||
    typeof bridge.cancelExport !== 'function' ||
    typeof bridge.finishExport !== 'function'
  ) {
    return undefined
  }
  return bridge
}

const parseBridgeJson = (raw: string): HarmonyBridgeResult => {
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; token?: string; error?: string }
    return { ok: parsed.ok === true, token: parsed.token, error: parsed.error }
  } catch {
    return { ok: false, error: '原生桥返回无效' }
  }
}

const saveInHarmonyOS = async (
  blob: Blob,
  fileName: string,
  bridge: NonNullable<Window['DsLiteHarmony']>
): Promise<void> => {
  const begin = parseBridgeJson(bridge.beginExport(fileName))
  if (!begin.ok || !begin.token) {
    throw new Error(begin.error || '无法开始导出')
  }
  const token = begin.token
  try {
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer())
      const ack = parseBridgeJson(bridge.appendExport(token, toBase64(bytes)))
      if (!ack.ok) {
        throw new Error(ack.error || '写入失败')
      }
    }
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        window.__dsLiteHarmonyShareDone = undefined
        reject(new Error('等待系统分享超时'))
      }, 120_000)
      window.__dsLiteHarmonyShareDone = (result) => {
        window.clearTimeout(timer)
        window.__dsLiteHarmonyShareDone = undefined
        if (result && result.ok) {
          resolve()
          return
        }
        reject(new Error((result && result.error) || '系统分享未打开'))
      }
      bridge.finishExport(token)
    })
  } catch (error) {
    try {
      bridge.cancelExport(token)
    } catch {
      // 会话可能已结束
    }
    throw error
  }
}

/**
 * 把 Blob 交给系统处理。
 * Android WebView 没有下载监听：<a download> 点了什么都不会发生，
 * 所以 APK 里改为分块写入应用目录，再用系统分享面板让用户「保存到文件」或发给自己。
 *
 * 优先写「文档」目录：部分手机的文件管理器读不到缓存目录里的文件（会报“选择文件管理器时出错”），
 * 写不进去（权限/机型差异）再退回缓存目录。
 *
 * 鸿蒙外壳不走 Capacitor，也不伪装 isNativePlatform()。若原生桥可用，则写入应用缓存并尝试打开系统分享；
 * 分享面板未能打开时会抛出明确错误，不把失败说成成功。
 */
export const saveFile = async (blob: Blob, fileName: string): Promise<void> => {
  const harmony = getHarmonyBridge()
  if (harmony) {
    await saveInHarmonyOS(blob, fileName, harmony)
    return
  }
  if (!Capacitor.isNativePlatform()) {
    downloadInBrowser(blob, fileName)
    return
  }
  const safeName = fileName.replace(/[\\/:*?"<>|]/g, '_')
  const path = `${NATIVE_DIR}/${safeName}`
  let directory = Directory.Documents
  try {
    await writeToDirectory(blob, path, directory)
  } catch {
    directory = Directory.Cache
    await writeToDirectory(blob, path, directory)
  }
  const { uri } = await Filesystem.getUri({ path, directory })
  try {
    // files 走 FileProvider 的 content:// 投放，部分文件管理器只认这个；
    // 老版本插件/系统不支持 files 时退回 url
    await Share.share({ title: fileName, dialogTitle: fileName, files: [uri] })
  } catch {
    try {
      await Share.share({ title: fileName, dialogTitle: fileName, url: uri })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`文件已保存到 ${uri}，但系统分享没打开：${reason}`)
    }
  }
}
