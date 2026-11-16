/**
 * 老内核兼容垫片。
 *
 * 打包目标已降到 Chromium 87 / iOS 15，这两个环境缺下面几个后来才加入的标准方法，
 * 在这里补齐，避免低版本 WebView 一进页面就抛错白屏。
 */

const define = (target: object, name: string, value: unknown) => {
  if (name in target) {
    return
  }
  Object.defineProperty(target, name, { value, configurable: true, writable: true })
}

const relativeIndex = (length: number, index: number) => {
  const offset = Math.trunc(index) || 0
  return offset < 0 ? length + offset : offset
}

define(Object, 'hasOwn', (object: object, key: PropertyKey) =>
  Object.prototype.hasOwnProperty.call(object, key)
)

define(Array.prototype, 'at', function at(this: unknown[], index: number) {
  const position = relativeIndex(this.length, index)
  return position < 0 || position >= this.length ? undefined : this[position]
})

define(String.prototype, 'at', function at(this: string, index: number) {
  const text = String(this)
  const position = relativeIndex(text.length, index)
  return position < 0 || position >= text.length ? undefined : text[position]
})

/** Chromium 110 才有；老内核里调用会直接 TypeError（曾表现为「上传失败」） */
define(Array.prototype, 'toReversed', function toReversed(this: unknown[]) {
  return this.slice().reverse()
})

/** Chromium 73 才有：把键值对数组转成对象 */
define(Object, 'fromEntries', (entries: Iterable<readonly [PropertyKey, unknown]>) => {
  const result: Record<PropertyKey, unknown> = {}
  for (const pair of entries as Iterable<[PropertyKey, unknown]>) {
    result[pair[0]] = pair[1]
  }
  return result
})

/** Chromium 76 才有 */
if (typeof Promise.allSettled !== 'function') {
  define(Promise, 'allSettled', (items: Iterable<unknown>) =>
    Promise.all(
      Array.from(items, (item) =>
        Promise.resolve(item).then(
          (value) => ({ status: 'fulfilled', value }),
          (reason) => ({ status: 'rejected', reason })
        )
      )
    )
  )
}

export {}
