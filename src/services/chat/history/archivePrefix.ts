import { INDEX_PATH, MANIFEST_PATH } from './paths.js'
import { readEntryPaths } from './zipReader.js'

/**
 * 有些用户会把导出包解压后再压缩，ZIP 里多出一层文件夹（`chat_history/manifest.json`）。
 * 这里识别这一层前缀；不是嵌套结构就返回空串。
 */
export const detectArchivePrefix = (paths: string[]): string => {
  if (paths.includes(MANIFEST_PATH)) {
    return ''
  }
  const nested = paths.find(
    (path) => path.endsWith(`/${MANIFEST_PATH}`) && path.split('/').length === 2
  )
  return nested ? nested.slice(0, nested.length - MANIFEST_PATH.length) : ''
}

/** 读 ZIP 前先找前缀，失败时给出更具体的原因 */
export const findArchivePrefix = async (file: File): Promise<string> => detectArchivePrefix(await readEntryPaths(file))

export const withPrefix = (prefix: string, path: string) => `${prefix}${path}`

/** 把条目路径还原成导出包内部的相对路径 */
export const stripPrefix = (prefix: string, path: string) =>
  prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path

export { INDEX_PATH, MANIFEST_PATH }
