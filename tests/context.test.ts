import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AssistantMessage, UserMessage } from '../src/services/chat/types.js'
import {
  estimateFileTokens,
  estimateMessageTokens,
  getContextLevel,
  MEMORY_MIN_KEEP_ROUNDS,
  splitFoldableRounds,
} from '../src/services/memory/context.js'

const makeRound = (
  index: number,
  userText: string,
  replyText: string,
  hasFile = false
): [UserMessage, AssistantMessage] => [
  {
    id: `u${index}`,
    parentId: index === 0 ? null : `a${index - 1}`,
    role: 'user',
    content: userText,
    files: hasFile
      ? [{ id: `f${index}`, name: 'doc.txt', type: 'text/plain', size: 40_000, isImage: false, serverId: null }]
      : [],
    createdAt: index * 2,
  },
  {
    id: `a${index}`,
    parentId: `u${index}`,
    role: 'assistant',
    status: 'done',
    thinking: false,
    blocks: [{ type: 'text', text: replyText }],
    createdAt: index * 2 + 1,
  },
]

describe('memory/context.ts 上下文估算与折叠切片', () => {
  it('按类型正确估算图片与文档附件 token', () => {
    assert.equal(estimateFileTokens({ isImage: true, size: 500_000 }), 1024)
    assert.equal(estimateFileTokens({ isImage: false, size: 100 }), 2048)
    assert.equal(estimateFileTokens({ isImage: false, size: 40_000 }), 10_000)
    assert.equal(estimateFileTokens({ isImage: false, size: 40_000, tokens: 12_345 }), 12_345)
  })

  it('历史思考块不计入上下文估算', () => {
    const reply: AssistantMessage = {
      id: 'a1',
      parentId: 'u1',
      role: 'assistant',
      status: 'done',
      thinking: true,
      blocks: [
        { type: 'thinking', thinking: '超长思考过程'.repeat(1000) },
        { type: 'text', text: '简短结论' },
      ],
      createdAt: 1,
    }
    assert.ok(estimateMessageTokens(reply) < 50)
  })

  it('splitFoldableRounds 至少保留 MEMORY_MIN_KEEP_ROUNDS 轮，且非末轮附件优先折叠', () => {
    const rounds = [
      makeRound(0, '第一轮'.repeat(500), '回复零'.repeat(500)),
      makeRound(1, '第二轮'.repeat(500), '回复一'.repeat(500)),
      makeRound(2, '第三轮带附件', '回复二', true),
      makeRound(3, '第四轮', '回复三'),
      makeRound(4, '最后一轮带附件', '回复四', true),
    ]
    const { kept, foldable } = splitFoldableRounds(rounds, 100)
    // 轮 2 虽然在最后 3 轮内，但带附件且不是最后一轮，应被折叠；最后一轮带附件应保留
    assert.ok(foldable.some(([u]) => u.id === 'u2'))
    assert.ok(kept.some(([u]) => u.id === 'u4'))
    assert.equal(kept.length + foldable.length, rounds.length)
    assert.ok(MEMORY_MIN_KEEP_ROUNDS >= 3)
  })

  it('getContextLevel 水位分级准确', () => {
    assert.equal(getContextLevel(0.1), 'low')
    assert.equal(getContextLevel(0.25), 'mid')
    assert.equal(getContextLevel(0.4), 'high')
    assert.equal(getContextLevel(0.75), 'critical')
  })
})
