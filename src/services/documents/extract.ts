/**
 * 本地把 Office / 电子书抽成纯文本（0.9.35）。
 *
 * 动机：docx/pptx/xlsx/epub 以前是整段上传给服务端做版面解析 ——
 * 既不能本地截断、也没法告诉用户「模型仅阅读了 xx%」，超大文件直接 400。
 * 这些格式本质都是 ZIP + XML，而 fflate 早就在依赖里（历史导入的 ZIP 用它），
 * 所以这条路是零新依赖的。
 *
 * 取舍：抽出来的是纯文本，会丢排版、公式、图片和表格合并信息。
 * 抽不动（加密、损坏、非标准结构）时返回 null，调用方退回原来的整段上传。
 */

/** 这些扩展名先本地抽文本，再按 token 预算截断 */
const EXTRACTABLE_EXTS = new Set(['docx', 'pptx', 'xlsx', 'epub', 'rtf'])

export const isExtractable = (ext: string) => EXTRACTABLE_EXTS.has(ext)

/** 抽取结果的硬上限：再大也只是占内存，反正后面还要按预算截断 */
const MAX_EXTRACT_CHARS = 2_000_000
/** 表格最多读这么多行：xlsx 动辄十万行，全展开既慢又没意义 */
const MAX_SHEET_ROWS = 5_000

type ZipFiles = Record<string, Uint8Array>

const decodeUtf8 = (bytes: Uint8Array) => new TextDecoder('utf-8').decode(bytes)

const parseXml = (text: string) => new DOMParser().parseFromString(text, 'application/xml')

/** 按文档顺序取出所有 localName 命中元素的**直接文本**（不递归拼接，避免重复） */
const directText = (el: Element, localName: string): string => {
  const kids = el.getElementsByTagName('*')
  let out = ''
  for (let i = 0; i < kids.length; i += 1) {
    const kid = kids[i]
    if (kid.localName === localName) {
      out += kid.textContent ?? ''
    }
  }
  return out
}

/**
 * 段落文本：docx 是 w:p + w:t，pptx 是 a:p + a:t —— localName 都是 p / t，
 * 所以一个函数覆盖两种格式。
 */
const paragraphTexts = (doc: Document): string[] => {
  const all = doc.getElementsByTagName('*')
  const lines: string[] = []
  for (let i = 0; i < all.length; i += 1) {
    const el = all[i]
    if (el.localName !== 'p') {
      continue
    }
    const line = directText(el, 't')
    if (line.trim() !== '') {
      lines.push(line)
    }
  }
  return lines
}

const docx = (files: ZipFiles): string | null => {
  const bytes = files['word/document.xml']
  if (!bytes) {
    return null
  }
  const lines = paragraphTexts(parseXml(decodeUtf8(bytes)))
  return lines.length > 0 ? lines.join('\n') : null
}

const slideNumber = (path: string) => Number(/slide(\d+)\.xml$/.exec(path)?.[1] ?? 0)

const pptx = (files: ZipFiles): string | null => {
  const slides = Object.keys(files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
  const parts: string[] = []
  slides.forEach((path, index) => {
    const lines = paragraphTexts(parseXml(decodeUtf8(files[path])))
    if (lines.length > 0) {
      parts.push(`【第 ${index + 1} 页】\n${lines.join('\n')}`)
    }
  })
  return parts.length > 0 ? parts.join('\n\n') : null
}

/** xlsx 的共享字符串表：<si> 里可能由多个 <r><t> 拼成 */
const sharedStrings = (xml: string): string[] => {
  const doc = parseXml(xml)
  const all = doc.getElementsByTagName('*')
  const out: string[] = []
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].localName !== 'si') {
      continue
    }
    out.push(directText(all[i], 't'))
  }
  return out
}

const sheetNumber = (path: string) => Number(/sheet(\d+)\.xml$/.exec(path)?.[1] ?? 0)

const xlsx = (files: ZipFiles): string | null => {
  const shared = files['xl/sharedStrings.xml']
    ? sharedStrings(decodeUtf8(files['xl/sharedStrings.xml']))
    : []
  const sheets = Object.keys(files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b))
  const parts: string[] = []
  sheets.forEach((path, index) => {
    const doc = parseXml(decodeUtf8(files[path]))
    const all = doc.getElementsByTagName('*')
    const lines: string[] = []
    let rows = 0
    for (let i = 0; i < all.length && rows < MAX_SHEET_ROWS; i += 1) {
      const row = all[i]
      if (row.localName !== 'row') {
        continue
      }
      rows += 1
      const cells = row.getElementsByTagName('*')
      const values: string[] = []
      for (let j = 0; j < cells.length; j += 1) {
        const cell = cells[j]
        if (cell.localName !== 'c') {
          continue
        }
        const type = cell.getAttribute('t')
        const kids = cell.getElementsByTagName('*')
        let raw = ''
        let inline = ''
        for (let k = 0; k < kids.length; k += 1) {
          const kid = kids[k]
          if (kid.localName === 'v') {
            raw = kid.textContent ?? ''
          } else if (kid.localName === 't') {
            inline += kid.textContent ?? ''
          }
        }
        if (type === 's') {
          values.push(shared[Number(raw)] ?? '')
        } else if (type === 'inlineStr') {
          values.push(inline)
        } else {
          values.push(raw)
        }
      }
      if (values.some((value) => value.trim() !== '')) {
        lines.push(values.join('\t'))
      }
    }
    if (lines.length > 0) {
      parts.push(`【工作表 ${index + 1}】\n${lines.join('\n')}`)
    }
  })
  return parts.length > 0 ? parts.join('\n\n') : null
}

/** HTML / XHTML 抽正文：去掉 script / style，压掉多余空行 */
const htmlToText = (text: string): string => {
  const doc = new DOMParser().parseFromString(text, 'text/html')
  for (const tag of ['script', 'style', 'noscript']) {
    for (const node of doc.querySelectorAll(tag)) {
      node.remove()
    }
  }
  const body = doc.body?.textContent ?? ''
  return body
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
}

const epub = (files: ZipFiles): string | null => {
  const container = files['META-INF/container.xml']
  if (!container) {
    return null
  }
  const cdoc = parseXml(decodeUtf8(container))
  const rootfile = [...cdoc.getElementsByTagName('*')].find((el) => el.localName === 'rootfile')
  const opfPath = rootfile?.getAttribute('full-path')
  if (!opfPath) {
    return null
  }
  const opfBytes = files[opfPath]
  if (!opfBytes) {
    return null
  }
  const odoc = parseXml(decodeUtf8(opfBytes))
  const dir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : ''
  const manifest = new Map<string, string>()
  for (const el of odoc.getElementsByTagName('*')) {
    if (el.localName !== 'item') {
      continue
    }
    const id = el.getAttribute('id')
    const href = el.getAttribute('href')
    if (id && href) {
      manifest.set(id, href)
    }
  }
  const ordered: string[] = []
  for (const el of odoc.getElementsByTagName('*')) {
    if (el.localName !== 'itemref') {
      continue
    }
    const idref = el.getAttribute('idref')
    const href = idref ? manifest.get(idref) : undefined
    if (href) {
      ordered.push(dir + href)
    }
  }
  const parts: string[] = []
  let total = 0
  for (const path of ordered) {
    const bytes = files[path] ?? files[decodeURIComponent(path)]
    if (!bytes) {
      continue
    }
    const text = htmlToText(decodeUtf8(bytes))
    if (text === '') {
      continue
    }
    parts.push(text)
    total += text.length
    if (total > MAX_EXTRACT_CHARS) {
      break
    }
  }
  return parts.length > 0 ? parts.join('\n\n') : null
}

/**
 * RTF 只做「控制字剥离」这一层：够读文字，不保证保住样式和表格。
 * \'hh 按单字节转字符、\uNNNN 按 Unicode 码位转，\par 变换行。
 */
const rtf = (file: File): Promise<string | null> =>
  file
    .arrayBuffer()
    .then((buffer) => {
      const bytes = new Uint8Array(buffer)
      // 用 latin1 解：\'hh 是原始字节，用 UTF-8 解会把它们变成 U+FFFD
      let text = new TextDecoder('iso-8859-1').decode(bytes)
      text = text
        .replace(/\\'([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\u(-?\d+)\s?\??/g, (_, code: string) =>
          String.fromCharCode(((Number(code) + 65536) % 65536) || 32)
        )
        .replace(/\\par[d]?\b/g, '\n')
        .replace(/\\[a-z]+-?\d* ?/gi, '')
        .replace(/\\[*{}]/g, '')
        .replace(/[{}]/g, '')
      return text
        .split('\n')
        .map((line) => line.replace(/[ \t]+/g, ' ').trim())
        .filter((line) => line !== '')
        .join('\n')
    })
    .catch(() => null)

/** 按扩展名抽取纯文本；抽不出来返回 null，调用方退回整段上传 */
export const extractDocumentText = async (file: File, ext: string): Promise<string | null> => {
  try {
    if (ext === 'rtf') {
      return await rtf(file)
    }
    const { unzipSync } = await import('fflate')
    const files = unzipSync(new Uint8Array(await file.arrayBuffer())) as ZipFiles
    const text =
      ext === 'docx' ? docx(files) : ext === 'pptx' ? pptx(files) : ext === 'xlsx' ? xlsx(files) : epub(files)
    if (!text) {
      return null
    }
    return text.length > MAX_EXTRACT_CHARS ? text.slice(0, MAX_EXTRACT_CHARS) : text
  } catch {
    // 加密、损坏、结构不认识：一律当作抽不出来，交给原来的上传路径
    return null
  }
}
