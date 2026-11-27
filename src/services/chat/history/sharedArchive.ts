import { Capacitor, registerPlugin } from '@capacitor/core'
import { create } from 'zustand'
import { platform } from '../../platform.js'

/**
 * 接收系统分享 / 打开方式传进来的归档文件。
 * 原生插件会把文件复制到缓存目录，这里读成 File，交给现有的导入流程。
 */
type SharedPayload = { path?: string; name?: string; size?: number }

type SharedArchivePlugin = {
  getShared(): Promise<SharedPayload>
  addListener(
    event: 'shared',
    listener: (data: SharedPayload) => void
  ): Promise<{ remove: () => Promise<void> }>
}

const SharedArchive = registerPlugin<SharedArchivePlugin>('SharedArchive')

/** 待导入的归档：设置面板挂载后取走，取走即清空 */
export const useSharedArchive = create<{ pending: File | null }>(() => ({ pending: null }))

const toFile = async (payload: SharedPayload): Promise<File | null> => {
  if (!payload.path) {
    return null
  }
  try {
    const response = await fetch(Capacitor.convertFileSrc(payload.path))
    const blob = await response.blob()
    if (blob.size === 0) {
      return null
    }
    return new File([blob], payload.name ?? 'shared-history.zip', { type: 'application/zip' })
  } catch {
    return null
  }
}

const accept = async (payload: SharedPayload) => {
  const file = await toFile(payload)
  if (file) {
    useSharedArchive.setState({ pending: file })
  }
}

/** 启动时调用一次：接住冷启动时的分享，以及运行中的新分享 */
export const initSharedArchive = async (): Promise<void> => {
  if (!platform.canReceiveSharedArchive()) {
    return
  }
  try {
    await accept(await SharedArchive.getShared())
    await SharedArchive.addListener('shared', (payload) => {
      void accept(payload)
    })
  } catch {
    // 插件不可用（网页版、旧版本）时静默跳过
  }
}

/** 取走待导入文件；没有就返回 null */
export const consumeSharedArchive = (): File | null => {
  const file = useSharedArchive.getState().pending
  if (file) {
    useSharedArchive.setState({ pending: null })
  }
  return file
}
