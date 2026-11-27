import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeReply } from '../src/services/chat/describe.js'
import type { AssistantMessage } from '../src/services/chat/types.js'

const makeHttpError = (status: number, message: string): AssistantMessage => ({
  id: 'a1',
  parentId: 'u1',
  role: 'assistant',
  status: 'error',
  thinking: false,
  blocks: [],
  createdAt: 1,
  error: { kind: 'http', status, message },
})

describe('describeReply 错误文案细分', () => {
  it('区分 400 的格式/元数据错误、附件错误、内容检查错误与中性兜底', () => {
    const formatErr = describeReply(
      makeHttpError(400, "Invalid 'messages.735.content': invalid date '2026-11-21 22:19'")
    )
    assert.ok(formatErr?.text.includes('请求格式或历史消息元数据异常'))

    const fileErr = describeReply(
      makeHttpError(400, 'file_ids do not exist or are not created under your account')
    )
    assert.ok(fileErr?.text.includes('附件已失效'))

    const imgSizeErr = describeReply(
      makeHttpError(400, 'total size of image files exceeds limit')
    )
    assert.ok(imgSizeErr?.text.includes('图片总大小超过服务端上限'))

    const contentErr = describeReply(makeHttpError(400, 'Request violates content policy'))
    assert.ok(contentErr?.text.includes('内容检查未通过'))

    const genericErr = describeReply(makeHttpError(400, 'unexpected custom backend rejection'))
    assert.ok(genericErr?.text.includes('展开下方技术详情'))
  })

  it('保留 400 专项规则与常见状态码动作按钮', () => {
    const tooLong = describeReply(makeHttpError(400, 'user input too long: 42000 tokens'))
    assert.ok(tooLong?.text.includes('42000'))

    const proBlocked = describeReply(
      makeHttpError(400, 'deepseek_web_search is unavailable for model deepseek-v4-pro')
    )
    assert.ok(proBlocked?.text.includes('v4 pro') || proBlocked?.text.includes('Flash'))

    const unauth = describeReply(makeHttpError(401, 'invalid api key'))
    assert.equal(unauth?.action, 'apiKey')

    const noBalance = describeReply(makeHttpError(402, 'insufficient balance'))
    assert.equal(noBalance?.action, 'topUp')
  })
})
