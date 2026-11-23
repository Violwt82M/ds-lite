import { create } from 'zustand'
import type { LinkedMessage, TranslationMessage } from '../i18n/index.js'
import { ApiError, uploadFile } from './api/client.js'
import { classifyApiError, getUploadErrorInfo, isRetryableApiError } from './api/errors.js'
import type { FilePurpose } from './api/types.js'
import { ACCEPT_FILE_EXTS } from './uploadExts.js'
import { DOCUMENT_BUDGET_DEFAULT } from './documentBudget.js'
import { extractDocumentText, isExtractable } from './documents/extract.js'
import { usesOpenAiProtocol } from './api/protocol.js'
import { safeSlice } from '../utils/safeText.js'
import { decodeTextBytes } from '../utils/textDecode.js'
import { estimateTextTokens } from '../utils/textTokens.js'

/** 允许上传的扩展名，按扩展名白名单过滤，清单见 uploadExts.ts */
export const ACCEPTED_EXTS = ACCEPT_FILE_EXTS
/** 选择文件对话框的过滤条件 */
export const ACCEPT = ACCEPTED_EXTS.map((ext) => `.${ext}`).join(',')
/** 单文件大小上限与 Files API 一致 */
export const MAX_SIZE_MB = 64
/** 按 user_data 上传的文件（纯文本、代码、表格、电子书）原文件上限更小 */
export const MAX_USER_DATA_SIZE_MB = 32
export const MAX_COUNT = 50
/**
 * 单份文档最多占多少 token —— 服务端不会替你截（超了直接 400），
 * 所以必须本地截：截完把「模型实际读了多少」按官方口径告诉用户（仅阅读 xx%）。
 */
export {
  DOCUMENT_BUDGET_DEFAULT,
  DOCUMENT_BUDGET_MAX,
  DOCUMENT_BUDGET_MIN,
  DOCUMENT_BUDGET_STEP,
} from './documentBudget.js'
/** 默认单份文档预算；实际值跟随设置（settings.documentBudget） */
export const DOCUMENT_TOKEN_BUDGET = DOCUMENT_BUDGET_DEFAULT
/** 切点回溯窗口：在预算前这么多字符里找段落、句末 */
const CUT_WINDOW = 20_000

/**
 * 本地能读文本的附件类型（其余如 PDF/Word 要服务端解析，拆不了）。
 *
 * 0.9.35 从 32 个扩到约 190 个：以前白名单有 973 个扩展名、却只有 32 个能在本地截断，
 * 其余 900 多个都是整段上传 —— 超了就是服务端 400，这才是「有些文件传上去就失败」的真因。
 * 这里只列**能确定是纯文本**的；图片/音视频/压缩包/Office/电子书一概不列。
 * 没列到的扩展名仍可上传，只是不做本地截断（行为与 0.9.34 一致）。
 */
const TEXT_EXTS = new Set([
  // 日常文本 / 日志 / 配置
  'txt', 'text', 'log', 'csv', 'tsv', 'diff', 'patch', 'srt', 'vtt', 'lrc', 'eml',
  'ini', 'conf', 'cfg', 'config', 'prefs', 'properties', 'env', 'toml', 'lock',
  'gitignore', 'gitattributes', 'gitmodules', 'gitkeep', 'editorconfig',
  // 数据 / 结构化
  'json', 'json5', 'jsonl', 'jsonc', 'jsonld', 'ndjson', 'geojson', 'topojson',
  'yaml', 'yml', 'xml', 'plist', 'xsd', 'xsl', 'xslt', 'dtd', 'rss', 'atom', 'opml',
  'ipynb', 'graphql', 'gql', 'proto', 'thrift', 'csv', 'sql', 'plsql', 'prc', 'ddl',
  'hcl', 'tf', 'bzl', 'gradle', 'cmake', 'mk', 'mak', 'ninja', 'dockerfile',
  // 文档 / 标记
  'md', 'markdown', 'mdown', 'mkdn', 'mkd', 'mdx', 'rmd', 'org', 'rst', 'adoc',
  'asciidoc', 'textile', 'wiki', 'mediawiki', 'creole', 'tex', 'bib', 'sty',
  // 网页 / 模板
  'html', 'htm', 'xhtml', 'shtml', 'shtml5', 'vue', 'jsx', 'tsx', 'hbs',
  'handlebars', 'mustache', 'ejs', 'pug', 'jade', 'haml', 'slim', 'twig', 'liquid',
  'erb', 'jsp', 'asp', 'aspx', 'php', 'phtml', 'cshtml', 'njk', 'nunjucks',
  // 样式
  'css', 'scss', 'sass', 'less', 'styl', 'stylus',
  // 编程语言
  'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'coffee', 'litcoffee', 'py', 'pyi', 'pyw',
  'rb', 'pl', 'pm', 'lua', 'r', 'jl', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'cxx',
  'hpp', 'hh', 'hxx', 'inl', 'cs', 'java', 'kt', 'kts', 'scala', 'swift', 'm', 'mm',
  'dart', 'ex', 'exs', 'erl', 'hrl', 'hs', 'lhs', 'clj', 'cljs', 'cljc', 'edn',
  'lisp', 'lsp', 'scm', 'rkt', 'el', 'ml', 'mli', 'fs', 'fsi', 'fsx', 'vb', 'vbs',
  'pas', 'd', 'nim', 'v', 'sv', 'vh', 'svh', 'vhd', 'vhdl', 'asm', 's', 'nasm',
  'sh', 'bash', 'zsh', 'fish', 'ksh', 'bat', 'cmd', 'ps1', 'psm1', 'psd1',
  'groovy', 'gsp', 'gradle', 'tcl', 'awk', 'sed', 'coq', 'lean', 'agda', 'idr',
])

export const isTextFile = (name: string) => TEXT_EXTS.has(getFileExt(name))

export type TextTruncation = {
  /** 实际发给模型的字符数 */
  kept: number
  /** 原文字符数 */
  total: number
  /** 保留部分的估算 token */
  keptTokens: number
  /** 原文的估算 token */
  totalTokens: number
}

/** 在预算附近找一个段落/句末断点，找不到就硬切 */
const findCut = (text: string, budget: number): number => {
  const windowStart = Math.max(0, budget - CUT_WINDOW)
  const window = text.slice(windowStart, budget)
  for (const separator of ['\n\n', '\n', '。', '！', '？', '. ']) {
    const at = window.lastIndexOf(separator)
    if (at >= 0) {
      return windowStart + at + separator.length
    }
  }
  return budget
}

/**
 * 按 token 预算切分纯文本附件。
 * 判定与切点都基于字符和 token，不再拿字节数当字符数（GBK 的 1.3MB 是 65 万字，不是 1.3M 字）。
 * 解码走 decodeTextBytes：GBK 的 TXT 先按 UTF-8 严格解，失败再按 GB18030，
 * 否则切出来的全是 U+FFFD。切点用 safeSlice，避免把 emoji 切成半个（孤立代理会让服务端 400）。
 * 未超预算时原样上传（服务端自己认 GBK），只返回估算 token 供水位条使用。
 */
/**
 * 附件本地预处理的结果。
 * extracted：这个文件是 Office/电子书，本地抽成了纯文本再上传（服务端按 user_data 处理）；
 * displayName：抽取后文件名叫 xx.txt，但卡片上要显示原文件名。
 */
export type PreparedAttachment = {
  file: File
  truncated?: TextTruncation
  tokens?: number
  originalSize?: number
  extracted?: boolean
  displayName?: string
}

/** 把一段已知纯文本按预算截断成"可直接上传的文本文件" */
const sliceTextToFile = (name: string, text: string, budget: number): PreparedAttachment => {
  const totalTokens = estimateTextTokens(text)
  if (totalTokens <= budget) {
    return { file: new File([text], name, { type: 'text/plain' }), tokens: totalTokens }
  }
  const charBudget = Math.max(1, Math.floor(text.length * (budget / totalTokens)))
  const kept = safeSlice(text, 0, findCut(text, charBudget))
  const keptTokens = estimateTextTokens(kept)
  return {
    file: new File([kept], name, { type: 'text/plain' }),
    truncated: { kept: kept.length, total: text.length, keptTokens, totalTokens },
    tokens: keptTokens,
  }
}

export const truncateTextFile = async (
  file: File,
  budget: number = DOCUMENT_TOKEN_BUDGET
): Promise<PreparedAttachment> => {
  const ext = getFileExt(file.name)
  // Office / 电子书：先本地抽文本，抽不动再退回整段上传（0.9.35）
  if (isExtractable(ext)) {
    const text = await extractDocumentText(file, ext)
    if (text && text.trim() !== '') {
      const base = file.name.replace(/\.[^./\\]+$/, '')
      const prepared = sliceTextToFile(`${base}.txt`, text, budget)
      return {
        ...prepared,
        originalSize: file.size,
        extracted: true,
        displayName: file.name,
      }
    }
    return { file }
  }
  if (!isTextFile(file.name)) {
    return { file }
  }
  const { text } = decodeTextBytes(new Uint8Array(await file.arrayBuffer()))
  if (text === '') {
    return { file }
  }
  const totalTokens = estimateTextTokens(text)
  if (totalTokens <= budget) {
    return { file, tokens: totalTokens }
  }
  const charBudget = Math.max(1, Math.floor(text.length * (budget / totalTokens)))
  const kept = safeSlice(text, 0, findCut(text, charBudget))
  const keptTokens = estimateTextTokens(kept)
  return {
    file: new File([kept], file.name, { type: 'text/plain' }),
    truncated: { kept: kept.length, total: text.length, keptTokens, totalTokens },
    tokens: keptTokens,
    originalSize: file.size,
  }
}
/** 同时上传的文件数 */
const MAX_CONCURRENT = 3

/** 文件扩展名（小写，不含点）；没有扩展名时为空 */
export const getFileExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isAcceptedExt = (name: string) => ACCEPTED_EXTS.includes(getFileExt(name))

/** 需要服务端做版面解析的文档；其余非图片文件（纯文本、代码、表格、电子书）无需解析 */
const LAYOUT_RECOGNITION_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])

/** 上传时的 purpose：图片不传，PDF 与 Word、PPT 做版面解析，其余按 user_data 上传 */
export const getUploadPurpose = (name: string, isImage: boolean): FilePurpose | null => {
  if (isImage) {
    return null
  }
  return LAYOUT_RECOGNITION_EXTS.has(getFileExt(name)) ? 'rich_layout_recognition' : 'user_data'
}

/** 文件允许的最大体积（MB），按上传时的 purpose 区分 */
const getMaxSizeMB = (file: File) =>
  getUploadPurpose(file.name, isImage(resolveMimeType(file))) === 'user_data'
    ? MAX_USER_DATA_SIZE_MB
    : MAX_SIZE_MB

/** 添加前校验：格式 → 大小 → 数量，任一不满足即整批不添加 */
export const validateFiles = (files: File[], currentCount: number): TranslationMessage | null => {
  // OpenAI 兼容通道没有 Files API：附件整条链路不支持，直接说清楚，别让用户以为传上去了
  if (usesOpenAiProtocol()) {
    return { key: 'uploadNotSupportedOpenAi' }
  }
  if (files.some((file) => !isAcceptedExt(file.name))) {
    return { key: 'uploadUnsupportedFormat' }
  }
  const oversized = files.find((file) => file.size > getMaxSizeMB(file) * 1024 * 1024)
  if (oversized) {
    return { key: 'uploadMaxMBSize', params: { size: getMaxSizeMB(oversized) } }
  }
  if (currentCount + files.length > MAX_COUNT) {
    return { key: 'uploadMaxFiles', params: { count: MAX_COUNT } }
  }
  return null
}

/**
 * 上传失败在附件上显示的文案：与设计稿状态对应的用具体原因，其余统一「上传失败」。
 * 服务端原文多为英文且较长，不直接展示。
 */
/** 服务端原文摘要：只取前 60 字，方便用户把真正原因发回来 */
const shortReason = (error: unknown): string => {
  const message = error instanceof ApiError ? error.message : ''
  const text = message.replace(/\s+/g, ' ').trim()
  if (text === '') {
    return ''
  }
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

export const describeUploadError = (error: unknown): TranslationMessage => {
  const info = getUploadErrorInfo(error)
  // 配额类 400 以前会落进最后的「上传失败」，用户看不出该删文件还是等配额
  if (info?.code === 'fileCountLimit') {
    return { key: 'uploadFileCountLimit', params: { limit: info.limit ?? '' } }
  }
  if (info?.code === 'storageLimit') {
    return { key: 'uploadStorageLimit', params: { limit: info.limit ?? '' } }
  }
  if (info?.code === 'parseFailed') {
    return { key: 'uploadParseFailed' }
  }
  const condition = classifyApiError(error)
  if (condition === 'tooLarge') {
    return { key: 'uploadFileTooLarge' }
  }
  if (condition === 'unauthorized') {
    return { key: 'uploadInvalidKey' }
  }
  if (condition === 'insufficientBalance') {
    return { key: 'uploadNoBalance' }
  }
  if (condition === 'rateLimited') {
    return { key: 'uploadRateLimited' }
  }
  if (condition === 'network') {
    return { key: 'uploadNetworkFailed' }
  }
  if (condition === 'serverBusy') {
    const reason = shortReason(error)
    return reason
      ? { key: 'uploadServerBusyReason', params: { reason } }
      : { key: 'uploadServerBusy' }
  }
  return { key: 'uploadFileStatusFailed' }
}

/**
 * 不可重试的上传错误：4xx 里除超时(408)/限流(429) 之外的重试通常不会变好，
 * 尤其是配额（文件数/存储空间）、格式/解析拒绝、鉴权与参数错误。
 * 供历史附件补传做「一次性跳过/退避」，避免每次发送都重传同一批必然失败的文件。
 */
export const isNonRetryableUploadError = (error: unknown): boolean => {
  if (getUploadErrorInfo(error) !== null) {
    return true
  }
  if (!(error instanceof ApiError) || error.status === undefined) {
    return false
  }
  if (error.status === 408 || error.status === 429) {
    return false
  }
  return error.status >= 400 && error.status < 500
}

type NoticeListener = (notice: LinkedMessage) => void
const noticeListeners = new Set<NoticeListener>()

/** 订阅需要额外提示的上传失败（配额达到上限），由界面层转成 toast */
export const onUploadNotice = (listener: NoticeListener) => {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

/** 删除已上传文件的接口文档 */
const DELETE_FILE_DOCS_URL = 'https://api-docs.deepseek.com/api/delete-file'

/** 文件数或存储空间达到上限：附件上只放得下「上传失败」，原因另用 toast 说明并引导删除旧文件 */
export const describeUploadQuota = (error: unknown): LinkedMessage | undefined => {
  const info = getUploadErrorInfo(error)
  const link = { key: 'uploadDeleteFiles', href: DELETE_FILE_DOCS_URL } as const
  if (info?.code === 'fileCountLimit') {
    return { type: 'error', key: 'uploadFileCountLimit', params: { limit: info.limit ?? '' }, link }
  }
  if (info?.code === 'storageLimit') {
    return { type: 'error', key: 'uploadStorageLimit', params: { limit: info.limit ?? '' }, link }
  }
  return undefined
}

type Job = () => Promise<void>
const queue: Job[] = []
let running = 0

const next = () => {
  while (running < MAX_CONCURRENT) {
    const job = queue.shift()
    if (!job) {
      return
    }
    running++
    void job().finally(() => {
      running--
      next()
    })
  }
}

/** 排队上传，最多同时上传 MAX_CONCURRENT 个；排队期间中止的任务不会发出请求 */
const enqueueUpload = (
  apiKey: string,
  file: Blob,
  name: string,
  isImage: boolean,
  signal: AbortSignal
) =>
  new Promise<string>((resolve, reject) => {
    queue.push(async () => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      try {
        const body = file instanceof File ? file : new File([file], name, { type: file.type })
        resolve((await uploadFile(apiKey, body, getUploadPurpose(name, isImage), signal)).id)
      } catch (error) {
        reject(error)
      }
    })
    next()
  })

/**
 * 上传任务按附件的本地 id 登记：输入框选中即开始上传，全部成功后携带 serverId 发送，
 * 不会重复上传；导入的历史附件没有任务，发送前按本地原件补传。
 * 任务只在内存里，历史附件补传未完成时，刷新后会在下次请求前重新上传。
 */
export type UploadTask =
  | { status: 'uploading' }
  | { status: 'done'; serverId: string }
  | { status: 'error'; error: TranslationMessage; retryable: boolean }

type UploadState = { tasks: Record<string, UploadTask> }

export const useUploads = create<UploadState>(() => ({ tasks: {} }))

const setTask = (id: string, task: UploadTask | null) =>
  useUploads.setState((state) => ({
    tasks: task
      ? { ...state.tasks, [id]: task }
      : Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id)),
  }))

const pending = new Map<string, { promise: Promise<string>; controller: AbortController }>()

export type UploadOptions = {
  /**
   * 静默补传（用于历史/导入附件）：失败时只清掉「上传中」态，
   * 不写全局错误任务、不弹配额提示，由调用方自行决定退避或跳过。
   */
  silent?: boolean
}

/**
 * 开始（或复用进行中的）上传，返回服务端 file_id；失败时抛出原错误。
 * 默认把结果写进全局任务表（输入框/消息附件据此显示上传中/失败）；
 * `silent: true` 时失败不污染全局状态，避免历史补传把旧消息标成「上传失败」。
 */
export const uploadAttachment = (
  apiKey: string,
  id: string,
  blob: Blob,
  name: string,
  isImage: boolean,
  options: UploadOptions = {}
): Promise<string> => {
  const { silent = false } = options
  const current = pending.get(id)
  if (current) {
    return current.promise
  }
  const controller = new AbortController()
  setTask(id, { status: 'uploading' })
  const promise = enqueueUpload(apiKey, blob, name, isImage, controller.signal)
    .then((serverId) => {
      setTask(id, { status: 'done', serverId })
      return serverId
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted || silent) {
        setTask(id, null)
      } else {
        setTask(id, {
          status: 'error',
          error: describeUploadError(error),
          retryable: isRetryableApiError(error),
        })
        const notice = describeUploadQuota(error)
        if (notice) {
          for (const listener of noticeListeners) {
            listener(notice)
          }
        }
      }
      throw error
    })
    .finally(() => pending.delete(id))
  pending.set(id, { promise, controller })
  return promise
}

export const cancelUpload = (id: string) => {
  pending.get(id)?.controller.abort()
  setTask(id, null)
}

/** 各扩展名对应的 MIME：部分系统（如 Windows）给不出 file.type，按扩展名补齐 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** 取文件的 MIME：优先用浏览器给出的类型，缺失时按扩展名推断 */
export const resolveMimeType = (file: File) => file.type || MIME_BY_EXT[getFileExt(file.name)] || ''

export const isImage = (mimeType: string) => mimeType.startsWith('image/')

/** 文件扩展名（大写），用于卡片元信息 */
export const getExtension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
}

export const formatSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
