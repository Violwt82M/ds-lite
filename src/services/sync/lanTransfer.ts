import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'

export type LanServerInfo = {
  ip: string
  port: number
  pin: string
  url: string
}

type LanReceivedPayload = {
  path: string
  name: string
  size: number
}

interface LanTransferPluginInterface {
  startServer(options: { filePath: string; fileName: string; port?: number }): Promise<LanServerInfo>
  stopServer(): Promise<{ stopped: boolean }>
  pullFromLan(options: { address: string; pin: string }): Promise<LanReceivedPayload>
  addListener(
    eventName: 'fileReceived',
    listenerFunc: (payload: LanReceivedPayload) => void
  ): Promise<PluginListenerHandle>
}

const LanTransfer = registerPlugin<LanTransferPluginInterface>('LanTransfer')

const CHUNK_BYTES = 2 * 1024 * 1024
const LAN_CACHE_PATH = 'lan-transfer/outgoing.zip'

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const step = 0x8000
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
  }
  return btoa(binary)
}

const writeCacheBlob = async (blob: Blob, path: string): Promise<string> => {
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
  return uri
}

const readNativeFileAsFile = async (absolutePath: string, name: string): Promise<File> => {
  const fileUri = absolutePath.startsWith('file://') ? absolutePath : `file://${absolutePath}`
  const response = await fetch(Capacitor.convertFileSrc(fileUri))
  if (!response.ok) {
    throw new Error(`读取局域网接收的文件失败（HTTP ${response.status}）`)
  }
  const blob = await response.blob()
  return new File([blob], name || 'deepseek_data-lan.zip', { type: 'application/zip' })
}

export const isLanServerSupported = (): boolean => Capacitor.isNativePlatform()

/** 在安卓端写入待共享 ZIP 并开启局域网临时网页服务 */
export const startLanTransferServer = async (
  blob: Blob,
  fileName: string
): Promise<LanServerInfo> => {
  if (!isLanServerSupported()) {
    throw new Error('局域网服务仅支持在安卓客户端开启')
  }
  const uri = await writeCacheBlob(blob, LAN_CACHE_PATH)
  return LanTransfer.startServer({ filePath: uri, fileName })
}

export const stopLanTransferServer = async (): Promise<void> => {
  if (!isLanServerSupported()) {
    return
  }
  await LanTransfer.stopServer().catch(() => {})
  await Filesystem.deleteFile({ path: LAN_CACHE_PATH, directory: Directory.Cache }).catch(() => {})
}

/** 监听从电脑/其他设备通过局域网网页上传过来的 ZIP 文件 */
export const onLanFileReceived = (
  callback: (file: File) => void,
  onError?: (error: Error) => void
): Promise<PluginListenerHandle> | null => {
  if (!isLanServerSupported()) {
    return null
  }
  return LanTransfer.addListener('fileReceived', (payload) => {
    void readNativeFileAsFile(payload.path, payload.name)
      .then((file) => callback(file))
      .catch((error: unknown) => {
        onError?.(error instanceof Error ? error : new Error(String(error)))
      })
  })
}

/** 安卓端直接从另一台安卓手机的局域网地址 + 6 位口令拉取 ZIP */
export const pullLanArchive = async (address: string, pin: string): Promise<File> => {
  if (!isLanServerSupported()) {
    throw new Error('请在电脑浏览器中直接打开手机上显示的局域网网址下载')
  }
  const res = await LanTransfer.pullFromLan({ address, pin })
  return readNativeFileAsFile(res.path, res.name)
}
