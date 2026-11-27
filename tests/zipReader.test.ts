import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import {
  ArchiveError,
  isZipFile,
  readArchiveEntry,
  readEntryPaths,
} from '../src/services/chat/history/zipReader.js'

describe('history/zipReader.ts 归档读取与校验', () => {
  it('识别合法 ZIP 并按路径读取条目内容', async () => {
    const bytes = zipSync({
      'manifest.json': strToU8(JSON.stringify({ version: 1 })),
      'chats/s1.json': strToU8('{"title":"你好世界"}'),
    })
    const file = new File([bytes], 'export.zip', { type: 'application/zip' })

    assert.equal(await isZipFile(file), true)
    const paths = await readEntryPaths(file)
    assert.deepEqual(paths.sort(), ['chats/s1.json', 'manifest.json'])

    const manifestBlob = await readArchiveEntry(file, 'manifest.json')
    assert.ok(manifestBlob)
    assert.equal(await manifestBlob.text(), '{"version":1}')

    const chatBlob = await readArchiveEntry(file, 'chats/s1.json')
    assert.ok(chatBlob)
    assert.equal(await chatBlob.text(), '{"title":"你好世界"}')

    assert.equal(await readArchiveEntry(file, 'not-exist.json'), null)
  })

  it('拒绝非 ZIP 文件与损坏数据', async () => {
    const fake = new File([strToU8('<html>not a zip</html>')], 'fake.zip')
    assert.equal(await isZipFile(fake), false)
    await assert.rejects(() => readEntryPaths(fake), ArchiveError)
  })
})
