import { loadFile, loadSession, loadSessionSummaries } from './db.js'

/**
 * 「更多」面板顶部的最近图片。
 *
 * 原版这里是系统相册的最近照片；网页 / WebView 读不到相册，
 * 所以改成「最近发过的图片」——从最近的会话里按消息倒序找图片附件，
 * 原件本来就在本机 files 表里（发消息时已经落盘），不额外占空间。
 */
export type RecentImage = {
  /** 附件本地 id，也是 files 表的 key */
  id: string
  /** 原始文件名（重新附加时用） */
  name: string
}

/** 最多翻多少个会话：每个会话都要从 IndexedDB 读整条，长会话不便宜 */
const MAX_SESSIONS = 6

/** 最近用过的图片附件，最多 limit 张；找不到返回空数组 */
export const loadRecentImages = async (limit = 8): Promise<RecentImage[]> => {
  if (limit <= 0) {
    return []
  }
  let summaries
  try {
    summaries = await loadSessionSummaries()
  } catch {
    return []
  }
  // 会话列表按最近更新排序；先翻最近聊过的，通常第一屏就够
  summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  const found: RecentImage[] = []
  const seen = new Set<string>()
  for (const summary of summaries.slice(0, MAX_SESSIONS)) {
    if (found.length >= limit) {
      break
    }
    let session
    try {
      session = await loadSession(summary.id)
    } catch {
      continue
    }
    if (!session) {
      continue
    }
    // 消息按时间正序存，从最后一条往前找
    for (let index = session.messages.length - 1; index >= 0 && found.length < limit; index--) {
      const message = session.messages[index]
      if (message.role !== 'user' || !Array.isArray(message.files)) {
        continue
      }
      for (let fileIndex = message.files.length - 1; fileIndex >= 0; fileIndex--) {
        const file = message.files[fileIndex]
        if (!file.isImage || seen.has(file.id)) {
          continue
        }
        seen.add(file.id)
        found.push({ id: file.id, name: file.name })
        if (found.length >= limit) {
          break
        }
      }
    }
  }
  return found
}

/** 读取最近图片的原件；已被清理时返回 undefined，调用方跳过这一张 */
export const loadRecentImageBlob = async (id: string): Promise<Blob | undefined> => {
  try {
    return await loadFile(id)
  } catch {
    return undefined
  }
}
