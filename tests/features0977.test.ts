import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  clearAllMessageEditing,
  startMessageEditing,
  stopMessageEditing,
  useMessageEditing,
} from '../src/components/messages/editingState.js'
import type { MessageParam } from '../src/services/api/types.js'
import {
  appendUserTailNotes,
  formatTurnLengthHint,
  MAX_REQUEST_IMAGE_BYTES,
  toRequestMessages,
} from '../src/services/chat/reply.js'
import {
  setAutoReadAloud,
  setHeaderStatusCollapsed,
  setReadAloudEnabled,
  setRegenerateOptions,
  setShowBalance,
  shouldAutoReadAloud,
  useSettings,
} from '../src/services/settings.js'

describe('0.9.77 新增功能逻辑（朗读总开关 / 顶栏折叠 / 单轮篇幅微调）', () => {
  afterEach(() => {
    setReadAloudEnabled(false)
    setAutoReadAloud(false)
    setHeaderStatusCollapsed(false)
    setRegenerateOptions(true)
    setShowBalance(true)
    clearAllMessageEditing()
  })

  it('编辑历史消息状态机正确追踪进入、退出与切换会话清空', () => {
    assert.equal(Object.keys(useMessageEditing.getState().ids).length, 0)
    startMessageEditing('msg-u1')
    assert.equal(Object.keys(useMessageEditing.getState().ids).length, 1)
    startMessageEditing('msg-a1')
    assert.equal(Object.keys(useMessageEditing.getState().ids).length, 2)
    stopMessageEditing('msg-u1')
    assert.equal(Object.keys(useMessageEditing.getState().ids).length, 1)
    clearAllMessageEditing()
    assert.equal(Object.keys(useMessageEditing.getState().ids).length, 0)
  })

  it('消息朗读总开关默认关闭，且自动朗读必须同时开启总开关才生效', () => {
    assert.equal(useSettings.getState().readAloudEnabled, false)
    assert.equal(shouldAutoReadAloud({ readAloudEnabled: false, autoReadAloud: false }), false)
    assert.equal(shouldAutoReadAloud({ readAloudEnabled: false, autoReadAloud: true }), false)
    assert.equal(shouldAutoReadAloud({ readAloudEnabled: true, autoReadAloud: false }), false)
    assert.equal(shouldAutoReadAloud({ readAloudEnabled: true, autoReadAloud: true }), true)

    setAutoReadAloud(true)
    assert.equal(shouldAutoReadAloud(useSettings.getState()), false)

    setReadAloudEnabled(true)
    assert.equal(shouldAutoReadAloud(useSettings.getState()), true)
    assert.equal(localStorage.getItem('chat-demo:read-aloud-enabled'), 'true')

    setReadAloudEnabled(false)
    assert.equal(shouldAutoReadAloud(useSettings.getState()), false)
  })

  it('顶栏状态折叠默认展开，与余额显示开关完全独立互不冲突', () => {
    assert.equal(useSettings.getState().headerStatusCollapsed, false)
    setShowBalance(false)
    assert.equal(useSettings.getState().headerStatusCollapsed, false)

    setHeaderStatusCollapsed(true)
    assert.equal(useSettings.getState().headerStatusCollapsed, true)
    assert.equal(useSettings.getState().showBalance, false)
    assert.equal(localStorage.getItem('chat-demo:header-status-collapsed'), 'true')
  })

  it('重新生成额外选项默认开启，关闭后持久化并可恢复', () => {
    assert.equal(useSettings.getState().regenerateOptions, true)
    setRegenerateOptions(false)
    assert.equal(useSettings.getState().regenerateOptions, false)
    assert.equal(localStorage.getItem('chat-demo:regenerate-options'), 'false')
    setRegenerateOptions(true)
    assert.equal(useSettings.getState().regenerateOptions, true)
    assert.equal(localStorage.getItem('chat-demo:regenerate-options'), 'true')
  })

  it('单条回复「这一次」篇幅提示仅附在最后一条 user 消息尾部，不修改原消息', () => {
    const detailedZh = formatTurnLengthHint('detailed', 'zh-CN')
    const conciseZh = formatTurnLengthHint('concise', 'zh-CN')
    assert.ok(detailedZh.includes('详尽'))
    assert.ok(conciseZh.includes('精简'))

    const original: MessageParam[] = [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '第一答' },
      { role: 'user', content: '第二句' },
    ]
    const next = appendUserTailNotes(original, ['[环境时钟: 16:20]', detailedZh])
    // 原数组与前序消息未被污染
    assert.equal(original[2].content, '第二句')
    assert.equal(next[0].content, '第一句')
    assert.equal(
      next[2].content,
      `第二句\n\n[环境时钟: 16:20]\n${detailedZh}`
    )

    // 多模态块数组形式也能正确追加文本块
    const multimodal: MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: '看图说话' }] },
    ]
    const nextMulti = appendUserTailNotes(multimodal, [conciseZh])
    assert.ok(Array.isArray(nextMulti[0].content))
    assert.equal(nextMulti[0].content.length, 2)
    assert.equal(
      nextMulti[0].content[1].type === 'text' ? nextMulti[0].content[1].text : '',
      `\n\n${conciseZh}`
    )
  })

  it('超过 200MB 图片预算时自动略去较早历史图片块，优先保留本轮与较新轮次的图片', () => {
    const MB = 1024 * 1024
    assert.equal(MAX_REQUEST_IMAGE_BYTES, 200 * MB)
    const history = [
      {
        id: 'u1',
        parentId: null,
        role: 'user' as const,
        content: '最早的图',
        files: [
          {
            id: 'img-old',
            name: 'old.jpg',
            mimeType: 'image/jpeg',
            size: 120 * MB,
            isImage: true,
            serverId: 'file-api-old',
          },
        ],
        createdAt: 1,
      },
      {
        id: 'a1',
        parentId: 'u1',
        role: 'assistant' as const,
        status: 'done' as const,
        thinking: false,
        blocks: [{ type: 'text' as const, text: '看到了老图' }],
        createdAt: 2,
      },
      {
        id: 'u2',
        parentId: 'a1',
        role: 'user' as const,
        content: '较新的图',
        files: [
          {
            id: 'img-recent',
            name: 'recent.jpg',
            mimeType: 'image/jpeg',
            size: 110 * MB,
            isImage: true,
            serverId: 'file-api-recent',
          },
        ],
        createdAt: 3,
      },
      {
        id: 'a2',
        parentId: 'u2',
        role: 'assistant' as const,
        status: 'done' as const,
        thinking: false,
        blocks: [{ type: 'text' as const, text: '看到了新图' }],
        createdAt: 4,
      },
    ]
    const question = {
      id: 'u3',
      parentId: 'a2',
      role: 'user' as const,
      content: '本轮新图',
      files: [
        {
          id: 'img-now',
          name: 'now.jpg',
          mimeType: 'image/jpeg',
          size: 50 * MB,
          isImage: true,
          serverId: 'file-api-now',
        },
      ],
      createdAt: 5,
    }

    // 50MB(本轮) + 110MB(u2) = 160MB <= 200MB，保留；再加 120MB(u1) 超 200MB，自动略去 img-old
    const msgs = toRequestMessages(history, question, undefined, false, undefined, undefined, false, false, 200 * MB)
    const sentFileIds = msgs.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b) => b.type === 'image').map((b) => b.source.file_id)
        : []
    )
    assert.deepEqual(sentFileIds, ['file-api-recent', 'file-api-now'])

    // 预算为 0（400 降级重发模式）：略去全部历史老图，仅保留本轮图
    const fallbackMsgs = toRequestMessages(history, question, undefined, false, undefined, undefined, false, false, 0)
    const fallbackIds = fallbackMsgs.flatMap((m) =>
      Array.isArray(m.content)
        ? m.content.filter((b) => b.type === 'image').map((b) => b.source.file_id)
        : []
    )
    assert.deepEqual(fallbackIds, ['file-api-now'])
  })
})
