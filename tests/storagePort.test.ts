import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { saveSessionRecord } from '../src/services/chat/db.js'
import {
  setStoragePortForTest,
  StorageVerifyError,
  type StoragePort,
} from '../src/services/chat/storagePort.js'
import type { Session } from '../src/services/chat/types.js'

const makeMemoryPort = (overrides: Partial<StoragePort> = {}): {
  port: StoragePort
  sessions: Map<string, Session>
} => {
  const sessions = new Map<string, Session>()
  const port: StoragePort = {
    loadSessionSummaries: async () => [],
    loadSession: async (id) => sessions.get(id),
    saveSessionRecord: async (session) => {
      sessions.set(session.id, structuredClone(session))
    },
    saveSessionFiles: async () => {},
    loadFile: async () => undefined,
    renameSession: async () => {},
    deleteSession: async (id) => {
      sessions.delete(id)
    },
    loadAllSearchDocs: async () => [],
    saveSearchDocs: async () => {},
    ...overrides,
  }
  return { port, sessions }
}

const sampleSession = (): Session => ({
  id: 'session-verify-1',
  title: '校验测试',
  createdAt: 100,
  updatedAt: 200,
  messages: [
    { id: 'u1', parentId: null, role: 'user', content: '你好', files: [], createdAt: 100 },
    {
      id: 'a1',
      parentId: 'u1',
      role: 'assistant',
      status: 'done',
      thinking: false,
      blocks: [{ type: 'text', text: '收到' }],
      latestReminder: '2026-11-21 22:19,星期六,北京,Web,简体中文',
      createdAt: 200,
    },
  ],
})

describe('StoragePort 统一契约与写后读校验', () => {
  afterEach(() => {
    setStoragePortForTest(null)
  })

  it('正常落盘自动清洗脏快照并通过写后读校验', async () => {
    const { port, sessions } = makeMemoryPort()
    setStoragePortForTest(port)

    await saveSessionRecord(sampleSession())
    const stored = sessions.get('session-verify-1')
    assert.ok(stored)
    assert.equal(
      stored.messages[1].role === 'assistant' ? stored.messages[1].latestReminder : undefined,
      '2026-11-21,星期六,北京,Web,简体中文'
    )
  })

  it('人为制造静默写丢时，写后读校验当场抛出 StorageVerifyError', async () => {
    const { port } = makeMemoryPort({
      saveSessionRecord: async () => {
        // 故意吞掉写入，模拟底层静默失败
      },
      loadSession: async () => undefined,
    })
    setStoragePortForTest(port)

    await assert.rejects(() => saveSessionRecord(sampleSession()), StorageVerifyError)
  })

  it('人为制造落盘消息截断时，写后读校验当场抛出 StorageVerifyError', async () => {
    const { port } = makeMemoryPort({
      loadSession: async (id) => ({
        ...sampleSession(),
        id,
        messages: [sampleSession().messages[0]], // 少了 1 条消息
      }),
    })
    setStoragePortForTest(port)

    await assert.rejects(() => saveSessionRecord(sampleSession()), StorageVerifyError)
  })
})
