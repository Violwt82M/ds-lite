import { create } from 'zustand'
import type { EntryProgress } from './history/zipReader.js'

/**
 * 历史导入的进度。大归档（上百 MB、上万条目）在手机上要跑几十秒到几分钟，
 * 必须让用户看到进度和剩余时间，否则会以为卡死。
 */
export type ImportPhase = 'checking' | 'scanning' | 'reading' | 'committing'

export type ImportProgress = {
  fileName: string
  fileSize: number
  phase: ImportPhase
  /** 0~1，写进进度条 */
  ratio: number
  entriesDone: number
  entriesTotal: number
  /** 已处理 / 总压缩字节数，用于估算剩余时间 */
  bytesDone: number
  bytesTotal: number
  startedAt: number
}

type TransferState = { importing: ImportProgress | null }

export const useTransfer = create<TransferState>(() => ({ importing: null }))

/** 进度区间：校验 0~2%，解析目录 2~10%，读取条目 10~95%，替换本机数据 95~100% */
const CHECK_END = 0.02
const SCAN_END = 0.1
const READ_END = 0.95
/** 状态更新节流，避免每个条目都触发一次重渲染 */
const EMIT_INTERVAL = 120
let lastEmit = 0

const set = (next: ImportProgress | null, force = false) => {
  if (force) {
    lastEmit = Date.now()
  } else {
    const now = Date.now()
    if (now - lastEmit < EMIT_INTERVAL) {
      return
    }
    lastEmit = now
  }
  useTransfer.setState({ importing: next })
}

const patch = (change: Partial<ImportProgress>, force = false) => {
  const current = useTransfer.getState().importing
  if (current) {
    set({ ...current, ...change }, force)
  }
}

export const beginImport = (file: File) => {
  set(
    {
      fileName: file.name,
      fileSize: file.size,
      phase: 'checking',
      ratio: 0,
      entriesDone: 0,
      entriesTotal: 0,
      bytesDone: 0,
      bytesTotal: 0,
      startedAt: Date.now(),
    },
    true
  )
}

/** 解析中央目录（大文件的主要耗时之一），按条目回报 */
export const reportScanProgress = (done: number, total: number) => {
  const ratio = total > 0 ? CHECK_END + (SCAN_END - CHECK_END) * Math.min(1, done / total) : CHECK_END
  patch({ phase: 'scanning', entriesDone: done, entriesTotal: total, ratio })
}

/** 目录解析完成，开始逐条读取会话与图片 */
export const startReading = () =>
  patch({ phase: 'reading', ratio: SCAN_END, entriesDone: 0, bytesDone: 0 }, true)

/** readArchive 每读完一个条目回调一次；比例按字节算，估算剩余时间更准 */
export const reportImportEntries = (progress: EntryProgress) => {
  const byBytes = progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : 0
  const byCount = progress.total > 0 ? progress.done / progress.total : 0
  // 只有被跳过的条目占多数时字节比例才不动，取两者的较大值保证进度条不会倒退
  const fraction = Math.max(byBytes, byCount * 0.5)
  const ratio = SCAN_END + (READ_END - SCAN_END) * Math.min(1, fraction)
  patch({
    phase: 'reading',
    entriesDone: progress.done,
    entriesTotal: progress.total,
    bytesDone: progress.bytesDone,
    bytesTotal: progress.bytesTotal,
    ratio,
  })
}

/** 读取完毕，正在替换本机数据 */
export const startCommitting = () => patch({ phase: 'committing', ratio: READ_END }, true)

export const endImport = () => set(null, true)
