import { Inflate } from 'fflate'

/** 每条目按块读取的粒度；大文件（上百 MB）用 1MB 减少读取次数 */
const READ_CHUNK_BYTES = 1024 * 1024
// 控制每轮同步解压的工作量；输出交给调用方保存后才继续读取。
// 256KB 是折中：太小会产生大量 yield 与 Blob 碎片（大图片明显变慢），太大则单轮占用内存偏高。
const INFLATE_CHUNK_BYTES = 256 * 1024

/** ZIP 结构损坏或使用了不支持的特性 */
export class ArchiveError extends Error {
  constructor() {
    super('Invalid or unsupported history archive')
    this.name = 'ArchiveError'
  }
}

const invalid = (): never => {
  throw new ArchiveError()
}

/** 本地文件头签名 PK\x03\x04，用于在解析前区分 ZIP 与其他文件。 */
export const isZipFile = async (file: File) => {
  const bytes = new Uint8Array(await file.slice(0, 4).arrayBuffer())
  return bytes.length === 4 && bytes.every((byte, index) => byte === [0x50, 0x4b, 3, 4][index])
}

const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return crc >>> 0
})

const readBytes = async (file: File, start: number, length: number) => {
  if (start < 0 || length < 0 || start + length > file.size) {
    invalid()
  }
  const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer())
  if (bytes.length !== length) {
    invalid()
  }
  return bytes
}

/** ZIP64、分卷与加密文件不属于导出格式，一律拒绝。 */
const checkExtra = (bytes: Uint8Array) => {
  const view = viewOf(bytes)
  let offset = 0
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length || view.getUint16(offset, true) === 1) {
      invalid()
    }
    offset += 4 + view.getUint16(offset + 2, true)
    if (offset > bytes.length) {
      invalid()
    }
  }
}

const decodePath = (bytes: Uint8Array, flags: number) => {
  // 非 UTF-8 编码的 ZIP 文件名仅接受 ASCII，确保附件路径解码准确。
  if (!(flags & 0x800) && bytes.some((byte) => byte > 0x7f)) {
    invalid()
  }
  const path = new TextDecoder('utf-8', { fatal: true }).decode(bytes).normalize('NFC')
  if (!path || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) {
    invalid()
  }
  const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    invalid()
  }
  return path
}

type Entry = {
  path: string
  name: Uint8Array
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
  /** 中央目录里记录的扩展字段长度，用于一次性读本地文件头 */
  extraLength: number
}

type Directory = { entries: Entry[]; offset: number }

/**
 * 一次读出整个中央目录后在内存里解析。
 * 早期实现按条目碎片读取（每条约 3 次 file.slice），上万条目时要跑几分钟且进度一直是 0，
 * 这是大归档「导入卡住」的主要原因。
 */
const parseDirectory = async (
  file: File,
  onProgress?: (done: number, total: number) => void
): Promise<Directory> => {
  if (file.size < 22) {
    invalid()
  }
  const tailStart = Math.max(0, file.size - 22 - 0xffff)
  const tail = await readBytes(file, tailStart, file.size - tailStart)
  const tailView = viewOf(tail)
  let end = tail.length - 22
  while (
    end >= 0 &&
    (tailView.getUint32(end, true) !== 0x06054b50 ||
      end + 22 + tailView.getUint16(end + 20, true) !== tail.length)
  ) {
    end--
  }
  if (end < 0) {
    invalid()
  }
  const count = tailView.getUint16(end + 10, true)
  const size = tailView.getUint32(end + 12, true)
  const offset = tailView.getUint32(end + 16, true)
  if (
    tailView.getUint16(end + 4, true) !== 0 ||
    tailView.getUint16(end + 6, true) !== 0 ||
    tailView.getUint16(end + 8, true) !== count ||
    count === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff ||
    offset + size !== tailStart + end
  ) {
    invalid()
  }
  const directory = await readBytes(file, offset, size)
  const view = viewOf(directory)
  const entries: Entry[] = []
  const paths = new Set<string>()
  let cursor = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > size) {
      invalid()
    }
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      invalid()
    }
    const flags = view.getUint16(cursor + 8, true)
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const entrySize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const next = cursor + 46 + nameLength + extraLength + view.getUint16(cursor + 32, true)
    const entryOffset = view.getUint32(cursor + 42, true)
    // 只允许 deflate 选项、data descriptor 与 UTF-8 标志。
    if (
      flags & ~0x80e ||
      (method !== 0 && method !== 8) ||
      compressedSize === 0xffffffff ||
      entrySize === 0xffffffff ||
      (method === 0 && compressedSize !== entrySize) ||
      entryOffset >= offset ||
      view.getUint16(cursor + 34, true) !== 0 ||
      ((view.getUint32(cursor + 38, true) >>> 16) & 0xf000) === 0xa000 ||
      next > size
    ) {
      invalid()
    }
    const name = directory.slice(cursor + 46, cursor + 46 + nameLength)
    const path = decodePath(name, flags)
    // 目录和同名文件也不能互相覆盖。
    const identity = path.endsWith('/') ? path.slice(0, -1) : path
    if (paths.has(identity) || (path.endsWith('/') && entrySize !== 0)) {
      invalid()
    }
    paths.add(identity)
    checkExtra(directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength))
    entries.push({
      path,
      name,
      flags,
      method,
      crc: view.getUint32(cursor + 16, true),
      compressedSize,
      size: entrySize,
      offset: entryOffset,
      extraLength,
    })
    cursor = next
    onProgress?.(index + 1, count)
  }
  if (cursor !== size) {
    invalid()
  }
  return { entries: entries.sort((a, b) => a.offset - b.offset), offset }
}

/** 中央目录只解析一次：校验阶段和导入阶段共用（100MB 归档能省掉一整遍扫描） */
const directoryCache = new WeakMap<File, Promise<Directory>>()

const readDirectory = (file: File, onProgress?: (done: number, total: number) => void) => {
  const cached = directoryCache.get(file)
  if (cached) {
    return cached
  }
  const task = parseDirectory(file, onProgress).catch((error: unknown) => {
    directoryCache.delete(file)
    throw error
  })
  directoryCache.set(file, task)
  return task
}

/**
 * 定位条目数据的起始偏移。中央目录已经给出文件名与扩展字段长度，
 * 因此可以一次读出「本地文件头 + 文件名 + 扩展字段」并在内存里校验；
 * 只有本地扩展字段长度与中央目录不一致时才退回分步读取。
 */
const readEntryOffset = async (file: File, entry: Entry, boundary: number): Promise<number> => {
  if (entry.offset + 30 > boundary) {
    invalid()
  }
  const combined = 30 + entry.name.length + entry.extraLength
  let header: Uint8Array | null =
    entry.offset + combined <= boundary ? await readBytes(file, entry.offset, combined) : null
  if (header && viewOf(header).getUint16(28, true) !== entry.extraLength) {
    header = null
  }
  let nameLength: number
  let extraLength: number
  if (header) {
    const local = viewOf(header)
    nameLength = local.getUint16(26, true)
    extraLength = local.getUint16(28, true)
  } else {
    const local = viewOf(await readBytes(file, entry.offset, 30))
    nameLength = local.getUint16(26, true)
    extraLength = local.getUint16(28, true)
    if (entry.offset + 30 + nameLength + extraLength > boundary) {
      invalid()
    }
    header = await readBytes(file, entry.offset, 30 + nameLength + extraLength)
  }
  const view = viewOf(header)
  const start = entry.offset + 30 + nameLength + extraLength
  const end = start + entry.compressedSize
  if (
    view.getUint32(0, true) !== 0x04034b50 ||
    view.getUint16(6, true) !== entry.flags ||
    view.getUint16(8, true) !== entry.method ||
    nameLength !== entry.name.length ||
    end > boundary
  ) {
    invalid()
  }
  for (const [position, expected] of [
    [14, entry.crc],
    [18, entry.compressedSize],
    [22, entry.size],
  ]) {
    const actual = view.getUint32(position, true)
    if (actual !== expected && (!(entry.flags & 8) || actual !== 0)) {
      invalid()
    }
  }
  const metadata = header.subarray(30)
  if (entry.name.some((byte, index) => byte !== metadata[index])) {
    invalid()
  }
  checkExtra(metadata.subarray(nameLength))
  if (entry.flags & 8) {
    if (end + 12 > boundary) {
      invalid()
    }
    const descriptor = viewOf(await readBytes(file, end, Math.min(16, boundary - end)))
    const shift = descriptor.getUint32(0, true) === 0x08074b50 ? 4 : 0
    if (
      shift + 12 > descriptor.byteLength ||
      descriptor.getUint32(shift, true) !== entry.crc ||
      descriptor.getUint32(shift + 4, true) !== entry.compressedSize ||
      descriptor.getUint32(shift + 8, true) !== entry.size
    ) {
      invalid()
    }
  }
  return start
}

const EMPTY_STREAM: AsyncIterable<Uint8Array> = {
  async *[Symbol.asyncIterator]() {},
}

export type ArchiveEntry = {
  path: string
  size: number
  stream: AsyncIterable<Uint8Array>
}

export type EntryProgress = {
  /** 已处理条目数 */
  done: number
  total: number
  /** 刚处理完的条目名 */
  path: string
  /** 已处理的压缩字节数，用于估算剩余时间 */
  bytesDone: number
  bytesTotal: number
}

export type ReadArchiveOptions = {
  /** 每个条目处理完后回调，用于展示进度与估算剩余时间 */
  onEntry?: (progress: EntryProgress) => void
  /** 条目内部按已读字节回调（大图片/大附件几个 MB 时让进度条持续前进，而不是一格一格跳） */
  onEntryProgress?: (progress: EntryProgress) => void
  /** 解析中央目录时按条目回调，用于展示进度 */
  onDirectory?: (done: number, total: number) => void
  /**
   * 返回 false 的条目不读出数据（调用方也不会消费它的 stream）。
   * 用于跳过图片或未选中的会话：不必读盘、不解压、不校验 CRC，速度差一个数量级。
   */
  consume?: (path: string) => boolean
  /**
   * 返回 false 的条目不计入进度（条目总数与压缩字节总数都不算）。
   * 只导入部分会话时用它，进度条才反映真正要做的工作；
   * 否则用户会看到「正在读取 1800 项」而以为整包都在导入。
   */
  count?: (path: string) => boolean
}

/** 打开单个条目的数据流；调用方读完后 completed 才为 true。onProgress 汇报解压进度（字节） */
const openEntry = (
  file: File,
  entry: Entry,
  start: number,
  onProgress?: (read: number) => void
) => {
  let completed = false
  const stream = async function* (): AsyncGenerator<Uint8Array> {
    let written = 0
    let crc = 0xffffffff
    const pending: Uint8Array[] = []
    const append = (chunk: Uint8Array) => {
      written += chunk.length
      if (written > entry.size) {
        invalid()
      }
      for (const byte of chunk) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
      }
      if (chunk.length) {
        pending.push(chunk)
        onProgress?.(written)
      }
    }
    const inflate = entry.method === 8 ? new Inflate(append) : null
    for (let offset = 0; offset < entry.compressedSize; offset += READ_CHUNK_BYTES) {
      const chunk = await readBytes(
        file,
        start + offset,
        Math.min(READ_CHUNK_BYTES, entry.compressedSize - offset)
      )
      if (!inflate) {
        append(chunk)
        yield* pending.splice(0)
        continue
      }
      for (let cursor = 0; cursor < chunk.length; cursor += INFLATE_CHUNK_BYTES) {
        const end = Math.min(cursor + INFLATE_CHUNK_BYTES, chunk.length)
        inflate.push(chunk.subarray(cursor, end), offset + end === entry.compressedSize)
        // yield 暂停解压，等待调用方完成异步写入；不缓存整个条目。
        yield* pending.splice(0)
      }
    }
    if (inflate && entry.compressedSize === 0) {
      inflate.push(new Uint8Array(), true)
      yield* pending.splice(0)
    }
    if (written !== entry.size || (crc ^ 0xffffffff) >>> 0 !== entry.crc) {
      invalid()
    }
    completed = true
  }
  return { stream, isCompleted: () => completed }
}

/**
 * 按条目在文件中的物理顺序逐条、逐块解压，跳过目录条目。
 * 需要读数据的条目必须由调用方消费完，再请求下一个条目。
 */
export async function* readArchive(
  file: File,
  options: ReadArchiveOptions = {}
): AsyncGenerator<ArchiveEntry> {
  const { onEntry, onEntryProgress, onDirectory, consume, count } = options
  const directory = await readDirectory(file, onDirectory)
  const counted = (entry: Entry) => !entry.path.endsWith('/') && (count?.(entry.path) ?? true)
  // 只统计要处理的条目；未选中的会话与跳过的图片不算进总数
  const total = directory.entries.filter(counted).length
  const bytesTotal = directory.entries.reduce(
    (sum, entry) => sum + (counted(entry) ? entry.compressedSize : 0),
    0
  )
  let done = 0
  let bytesDone = 0
  onEntry?.({ done: 0, total, path: '', bytesDone, bytesTotal })
  for (const [index, entry] of directory.entries.entries()) {
    if (entry.path.endsWith('/')) {
      continue
    }
    const required = consume?.(entry.path) ?? true
    const counts = counted(entry)
    if (required) {
      // 只有真正要读的条目才需要定位数据起点；跳过条目不读盘，只靠中央目录的元数据
      const boundary = directory.entries[index + 1]?.offset ?? directory.offset
      const start = await readEntryOffset(file, entry, boundary)
      const { stream, isCompleted } = openEntry(file, entry, start, (read) => {
        if (!counts || !onEntryProgress) {
          return
        }
        const fraction = entry.size > 0 ? Math.min(1, read / entry.size) : 1
        onEntryProgress({
          done,
          total,
          path: entry.path,
          bytesDone: bytesDone + fraction * entry.compressedSize,
          bytesTotal,
        })
      })
      yield { path: entry.path, size: entry.size, stream: stream() }
      if (!isCompleted()) {
        invalid()
      }
    } else {
      // 跳过的条目：只给出元数据，数据一个字节都不读
      yield { path: entry.path, size: entry.size, stream: EMPTY_STREAM }
    }
    if (!counts) {
      continue
    }
    done += 1
    bytesDone += entry.compressedSize
    onEntry?.({ done, total, path: entry.path, bytesDone, bytesTotal })
  }
}

/** 读出整个条目：会话 JSON 需要完整解析，图片需要识别类型后整张保存。 */
export const readEntry = async (entry: ArchiveEntry): Promise<Blob> => {
  const parts: Blob[] = []
  for await (const chunk of entry.stream) {
    parts.push(new Blob([chunk as Uint8Array<ArrayBuffer>]))
  }
  return new Blob(parts)
}

/** 不需要的条目也要读完，以校验大小与 CRC。 */
export const skipEntry = async (entry: ArchiveEntry): Promise<void> => {
  const reader = entry.stream[Symbol.asyncIterator]()
  while (!(await reader.next()).done) {
    // 丢弃数据。
  }
}

/**
 * 按路径随机读取单个条目。会话清单（chat_session_index.json）位于归档末尾，
 * 但选择界面需要在导入前就拿到清单，所以不能只靠顺序遍历。
 */
export const readArchiveEntry = async (file: File, path: string): Promise<Blob | null> => {
  const directory = await readDirectory(file)
  const index = directory.entries.findIndex((entry) => entry.path === path)
  if (index < 0) {
    return null
  }
  const entry = directory.entries[index]!
  const boundary = directory.entries[index + 1]?.offset ?? directory.offset
  const start = await readEntryOffset(file, entry, boundary)
  const { stream, isCompleted } = openEntry(file, entry, start)
  const blob = await readEntry({ path: entry.path, size: entry.size, stream: stream() })
  if (!isCompleted()) {
    invalid()
  }
  return blob
}
