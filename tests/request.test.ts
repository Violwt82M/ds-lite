import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildRequest,
  EXTENDED_INPUT_LIMIT_TOKENS,
  wantsExtendedRequest,
} from '../src/services/chat/request.js'

describe('request.ts 请求构造与 32K 扩展模式闸门', () => {
  it('普通聊天默认走标准模式，不带扩展工具', () => {
    const result = buildRequest({
      model: 'deepseek-flash',
      system: '你是助手',
      messages: [{ role: 'user', content: '你好' }],
      questionText: '你好',
    })
    assert.equal(result.degraded, false)
    assert.equal(result.proCapsBlocked, false)
    assert.deepEqual(result.body.tools, [])
    assert.equal(result.body.safety_check?.level, 'low')
  })

  it('长输入超过 30K token 时自动降级回标准模式并放弃服务端标题与工具', () => {
    const result = buildRequest({
      model: 'deepseek-flash',
      system: '你是助手',
      messages: [{ role: 'user', content: '帮我查一下 https://example.com' }],
      questionText: '帮我查一下 https://example.com',
      search: true,
      safety: 'high',
      wantTitle: true,
      inputTokens: EXTENDED_INPUT_LIMIT_TOKENS + 1,
    })
    assert.equal(result.degraded, true)
    assert.equal(result.titleRequested, false)
    assert.deepEqual(result.body.tools, [])
    assert.equal(result.body.safety_check?.level, 'low')
    assert.equal(result.body.title, undefined)
  })

  it('v4-pro 屏蔽服务端联网/读链接/标题，但严格审查仍判定为扩展模式', () => {
    assert.equal(
      wantsExtendedRequest({
        model: 'deepseek-v4-pro',
        search: true,
        questionText: 'https://example.com',
        safety: 'low',
      }),
      false
    )
    assert.equal(
      wantsExtendedRequest({
        model: 'deepseek-v4-pro',
        search: false,
        safety: 'high',
      }),
      true
    )

    const result = buildRequest({
      model: 'deepseek-v4-pro',
      system: '你是助手',
      messages: [{ role: 'user', content: '搜索一下' }],
      questionText: '搜索一下',
      search: true,
      wantTitle: true,
    })
    assert.equal(result.proCapsBlocked, true)
    assert.equal(result.titleRequested, false)
    assert.deepEqual(result.body.tools, [])
  })

  it('出站消息自动净化孤立代理、DSML 标记并过滤畸形 latest_reminder', () => {
    const result = buildRequest({
      model: 'deepseek-flash',
      system: '系统\uD800提示',
      messages: [
        { role: 'latest_reminder', content: '2026-11-21 22:19,星期六,北京,Web,简体中文' },
        { role: 'latest_reminder', content: 'invalid-date-only' },
        { role: 'user', content: '你好\uD800' },
        { role: 'assistant', content: '回答</||DSML||calls>' },
      ],
    })
    assert.equal(result.body.system, '系统\uFFFD提示')
    assert.equal(result.body.messages.length, 3)
    assert.deepEqual(result.body.messages[0], {
      role: 'latest_reminder',
      content: '2026-11-21,星期六,北京,Web,简体中文',
    })
    assert.equal(result.body.messages[1].content, '你好\uFFFD')
    assert.equal(result.body.messages[2].content, '回答')
  })
})
