import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePersonaJson, parsePersonaPng } from '../src/services/persona/card.js'

/** 构造一个带 tEXt 块的最小合法 PNG（仅用于单测校验解析器） */
const buildPngWithTextChunk = (keyword: string, text: string): Uint8Array => {
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const enc = new TextEncoder()
  const makeChunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length, false)
    out.set(enc.encode(type), 4)
    out.set(data, 8)
    // CRC 校验位填 0（parsePersonaPng 只读 chunk 结构与内容）
    view.setUint32(8 + data.length, 0, false)
    return out
  }
  const kwBytes = enc.encode(keyword)
  const valBytes = enc.encode(text)
  const textData = new Uint8Array(kwBytes.length + 1 + valBytes.length)
  textData.set(kwBytes, 0)
  textData[kwBytes.length] = 0
  textData.set(valBytes, kwBytes.length + 1)

  const ihdr = makeChunk('IHDR', new Uint8Array(13))
  const textChunk = makeChunk('tEXt', textData)
  const iend = makeChunk('IEND', new Uint8Array(0))

  const total = new Uint8Array(sig.length + ihdr.length + textChunk.length + iend.length)
  let offset = 0
  for (const part of [sig, ihdr, textChunk, iend]) {
    total.set(part, offset)
    offset += part.length
  }
  return total
}

describe('persona/card.ts 角色卡解析', () => {
  it('解析 v1 顶层扁平 JSON 角色卡', () => {
    const res = parsePersonaJson(
      JSON.stringify({
        name: '林小雪',
        description: '图书馆管理员',
        first_mes: '欢迎光临',
        mes_example: ['<START>\n你好', '再见'],
      })
    )
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.equal(res.card.name, '林小雪')
      assert.equal(res.card.firstMessage, '欢迎光临')
      assert.equal(res.card.messageExamples, '<START>\n你好\n\n再见')
    }
  })

  it('解析 v2/v3 data 嵌套 JSON 角色卡，且缺失 name 时返回错误', () => {
    const res = parsePersonaJson(
      JSON.stringify({
        spec: 'chara_card_v2',
        data: { name: '学姐', personality: '温和', system_prompt: '保持人设' },
      })
    )
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.equal(res.card.name, '学姐')
      assert.equal(res.card.systemPrompt, '保持人设')
    }

    const bad = parsePersonaJson(JSON.stringify({ data: { description: '没有名字' } }))
    assert.equal(bad.ok, false)
    assert.equal(parsePersonaJson('{not-json').ok, false)
  })

  it('解析 PNG tEXt chara base64 角色卡', () => {
    const payload = Buffer.from(
      JSON.stringify({ spec: 'chara_card_v2', data: { name: '海星', description: '测试PNG卡' } }),
      'utf8'
    ).toString('base64')
    const png = buildPngWithTextChunk('chara', payload)
    const res = parsePersonaPng(png)
    assert.equal(res.ok, true)
    if (res.ok) {
      assert.equal(res.card.name, '海星')
      assert.equal(res.card.source, 'png')
    }
  })
})
