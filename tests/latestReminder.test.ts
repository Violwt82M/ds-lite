import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cleanSessionText } from '../src/services/chat/clean.js'
import {
  extractClockTime,
  normalizeLatestReminder,
  stripClockTime,
} from '../src/services/chat/latestReminder.js'
import { toRequestMessages } from '../src/services/chat/reply.js'
import type { Session, UserMessage } from '../src/services/chat/types.js'

describe('latestReminder 规范化与会话清洗', () => {
  it('把旧版带时分的 5 段快照规范化为纯日期', () => {
    assert.equal(
      normalizeLatestReminder('2026-11-21 22:19,星期六,北京,Web,简体中文'),
      '2026-11-21,星期六,北京,Web,简体中文'
    )
    assert.equal(
      normalizeLatestReminder('2026-11-21 08:05,Saturday,,Web,English'),
      '2026-11-21,Saturday,,Web,English'
    )
  })

  it('保留合法 5 段纯日期快照，丢弃畸形日期与缺段快照', () => {
    assert.equal(
      normalizeLatestReminder('2026-11-24,星期二,上海,Web,简体中文'),
      '2026-11-24,星期二,上海,Web,简体中文'
    )
    assert.equal(normalizeLatestReminder('2026-02-31,星期二,上海,Web,简体中文'), undefined)
    assert.equal(normalizeLatestReminder('2026-13-01,星期二,上海,Web,简体中文'), undefined)
    assert.equal(normalizeLatestReminder('2026-11-21,星期六,Web'), undefined)
    assert.equal(normalizeLatestReminder('2026-11-21,,上海,Web,简体中文'), undefined)
    assert.equal(normalizeLatestReminder(''), undefined)
    assert.equal(normalizeLatestReminder(undefined), undefined)
  })

  it('stripClockTime 与 extractClockTime 行为一致', () => {
    assert.equal(stripClockTime('2026-11-21 22:19,星期六,北京,Web,简体中文'), '2026-11-21,星期六,北京,Web,简体中文')
    assert.equal(extractClockTime('2026-11-21 22:19,星期六,北京,Web,简体中文'), '22:19')
    assert.equal(extractClockTime('2026-11-21,星期六,北京,Web,简体中文'), null)
  })

  it('cleanSessionText 自动修复坏快照、清除 DSML 标记与孤立代理', () => {
    const session: Session = {
      id: 's1',
      title: '测试<|end_of_sentence|>',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        { id: 'u1', parentId: null, role: 'user', content: '你好\uD800世界', files: [], createdAt: 1 },
        {
          id: 'a1',
          parentId: 'u1',
          role: 'assistant',
          status: 'done',
          thinking: false,
          blocks: [{ type: 'text', text: '正文</||DSML||invoke>' }],
          latestReminder: '2026-11-21 22:19,星期六,北京,Web,简体中文',
          createdAt: 2,
        },
        { id: 'u2', parentId: 'a1', role: 'user', content: '继续', files: [], createdAt: 3 },
        {
          id: 'a2',
          parentId: 'u2',
          role: 'assistant',
          status: 'done',
          thinking: false,
          blocks: [{ type: 'text', text: '正常回复' }],
          latestReminder: 'broken-reminder',
          createdAt: 4,
        },
      ],
    }

    const cleaned = cleanSessionText(session)
    assert.equal(cleaned.title, '测试')
    assert.equal(cleaned.messages[0].role === 'user' && cleaned.messages[0].content, '你好\uFFFD世界')
    assert.equal(
      cleaned.messages[1].role === 'assistant' && cleaned.messages[1].blocks[0].type === 'text'
        ? cleaned.messages[1].blocks[0].text
        : '',
      '正文'
    )
    assert.equal(
      cleaned.messages[1].role === 'assistant' ? cleaned.messages[1].latestReminder : undefined,
      '2026-11-21,星期六,北京,Web,简体中文'
    )
    assert.equal(
      cleaned.messages[3].role === 'assistant' ? cleaned.messages[3].latestReminder : 'unexpected',
      undefined
    )
  })

  it('toRequestMessages 出站前兜底规范化并丢弃非法 latest_reminder', () => {
    const question: UserMessage = {
      id: 'u3',
      parentId: 'a2',
      role: 'user',
      content: '发一句',
      files: [],
      createdAt: 5,
    }
    const messages = toRequestMessages(
      [
        { id: 'u1', parentId: null, role: 'user', content: 'hi', files: [], createdAt: 1 },
        {
          id: 'a1',
          parentId: 'u1',
          role: 'assistant',
          status: 'done',
          thinking: false,
          blocks: [{ type: 'text', text: 'ok' }],
          latestReminder: '2026-11-21 22:19,星期六,北京,Web,简体中文',
          createdAt: 2,
        },
      ],
      question,
      undefined,
      false,
      'bad-reminder-format'
    )
    const reminders = messages.filter((m) => m.role === 'latest_reminder')
    assert.equal(reminders.length, 1)
    assert.equal(reminders[0].content, '2026-11-21,星期六,北京,Web,简体中文')
  })
})
