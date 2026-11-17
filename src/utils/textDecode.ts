/**
 * 文本解码：下载来的中文 TXT 多为 GBK/GB18030，硬按 UTF-8 解会有约七成字节变成 U+FFFD
 * （实测：GBK 文件按 UTF-8 解出 70.5% 的替换字符），模型读到的就是一堆 �。
 * 所以先严格按 UTF-8 解，失败再按 GB18030 解，两者都不行才降级成宽松 UTF-8。
 */
export type DecodedText = {
  text: string
  encoding: 'utf-8' | 'gb18030' | 'fallback'
}

/** 前 8KB 里出现 NUL 基本可判定为二进制，不要当文本处理 */
const looksBinary = (bytes: Uint8Array): boolean => {
  const limit = Math.min(bytes.length, 8192)
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) {
      return true
    }
  }
  return false
}

export const decodeTextBytes = (bytes: Uint8Array): DecodedText => {
  if (looksBinary(bytes)) {
    return { text: '', encoding: 'fallback' }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }
  } catch {
    // 不是合法 UTF-8，继续试 GB18030
  }
  try {
    return { text: new TextDecoder('gb18030').decode(bytes), encoding: 'gb18030' }
  } catch {
    return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'fallback' }
  }
}
