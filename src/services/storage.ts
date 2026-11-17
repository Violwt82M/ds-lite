/**
 * 本机存储（IndexedDB）相关的小工具。
 * 网页版的存储归浏览器管：配额不足、无痕、系统清理都会让「把附件原件写进本机」失败，
 * 抛出来的是 Chromium 的英文原文（如 error preparing blob/file data ...），用户看不懂，也不该直接展示。
 */

/** 申请持久化存储：浏览器同意后，站点数据不会被自动清理（配额本身不变，但更不容易被回收） */
export const requestPersistentStorage = async (): Promise<boolean> => {
  try {
    if (!navigator.storage?.persist) {
      return false
    }
    if (navigator.storage.persisted && (await navigator.storage.persisted())) {
      return true
    }
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

export type StorageEstimate = { usage?: number; quota?: number }

/** 剩余可用空间（字节）；浏览器不给就返回 null */
export const getStorageFreeBytes = async (): Promise<number | null> => {
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (!estimate || typeof estimate.quota !== 'number') {
      return null
    }
    return Math.max(0, estimate.quota - (estimate.usage ?? 0))
  } catch {
    return null
  }
}

/**
 * 判断「把数据写进本机存储」失败。
 * 覆盖三种情况：配额不足（QuotaExceededError）、Chromium 把 Blob 写进 IndexedDB 失败
 * （error preparing blob/file data to be stored in object store）、以及各浏览器自带的配额文案。
 */
export const isStorageWriteError = (error: unknown): boolean => {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (name === 'QuotaExceededError') {
    return true
  }
  return /quota|blob\/file data|object store|storage (is )?(full|exceeded)|disk full/i.test(message)
}
