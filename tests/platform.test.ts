import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { platform } from '../src/services/platform.js'

const collectFiles = (dir: string): string[] => {
  const result: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      result.push(...collectFiles(full))
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      result.push(full)
    }
  }
  return result
}

describe('platform.ts 能力清单与架构守卫', () => {
  it('正确识别网页与鸿蒙外壳标记', () => {
    const prev = (window as { __DS_LITE_PLATFORM__?: string }).__DS_LITE_PLATFORM__
    try {
      delete (window as { __DS_LITE_PLATFORM__?: string }).__DS_LITE_PLATFORM__
      assert.equal(platform.isHarmonyApp(), false)

      ;(window as { __DS_LITE_PLATFORM__?: string }).__DS_LITE_PLATFORM__ = 'harmonyos'
      assert.equal(platform.isHarmonyApp(), true)
      assert.equal(platform.isShellApp(), true)
    } finally {
      if (prev === undefined) {
        delete (window as { __DS_LITE_PLATFORM__?: string }).__DS_LITE_PLATFORM__
      } else {
        ;(window as { __DS_LITE_PLATFORM__?: string }).__DS_LITE_PLATFORM__ = prev
      }
    }
  })

  it('UI 层（src/app 与 src/components）0 处直接调用 isNativePlatform', () => {
    const root = process.cwd()
    const uiFiles = [
      ...collectFiles(join(root, 'src/app')),
      ...collectFiles(join(root, 'src/components')),
    ]
    const offenders = uiFiles.filter((file) =>
      readFileSync(file, 'utf8').includes('isNativePlatform')
    )
    assert.deepEqual(offenders, [])
  })
})
