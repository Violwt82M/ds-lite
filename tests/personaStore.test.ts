import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { setPersonaPersistenceForTest } from '../src/services/persona/storage.js'
import {
  addPersonaCard,
  flushPersonaWrites,
  initPersonaStore,
  resetPersonaStoreForTest,
  setPersonaAvatar,
  usePersona,
  type PersonaEntry,
} from '../src/services/persona/store.js'
import type { PersonaCard } from '../src/services/persona/card.js'

const sampleCard = (name: string): PersonaCard => ({
  name,
  description: 'desc',
  personality: '',
  style: '',
  rules: '',
  behavior: '',
  scenario: '',
  firstMessage: '',
  messageExamples: '',
  systemPrompt: '',
  postHistoryInstructions: '',
  source: 'json',
})

describe('persona/store.ts 角色库持久存储与平滑迁移', () => {
  afterEach(() => {
    setPersonaPersistenceForTest(null)
    localStorage.clear()
    resetPersonaStoreForTest()
  })

  it('从旧 localStorage 自动迁移到大仓库，并清除旧大对象 key；清空 localStorage 后角色不丢', async () => {
    let remoteCards: PersonaEntry[] | null = null
    setPersonaPersistenceForTest({
      loadCards: async () => remoteCards,
      saveCards: async (cards) => {
        remoteCards = structuredClone(cards)
      },
    })

    // 1. 模拟老版本留在 localStorage 的大对象（含自定义头像）
    localStorage.setItem(
      'ds-lite:persona',
      JSON.stringify({
        enabled: true,
        userName: '小明',
        activeId: 'card-1',
        showAvatar: true,
        cards: [{ id: 'card-1', card: sampleCard('学姐'), avatar: 'data:image/png;base64,AAAA' }],
      })
    )

    resetPersonaStoreForTest()
    await initPersonaStore()

    // 迁移后：大仓库已落盘，旧大对象 key 已被移除释放 5MB 配额
    assert.equal(localStorage.getItem('ds-lite:persona'), null)
    assert.ok(localStorage.getItem('ds-lite:persona-prefs') !== null)
    assert.equal(remoteCards?.length, 1)
    assert.equal(remoteCards?.[0]?.card.name, '学姐')
    assert.equal(remoteCards?.[0]?.avatar, 'data:image/png;base64,AAAA')

    // 2. 模拟用户清掉浏览器 localStorage 缓存，重启后从大仓库无损恢复角色卡
    localStorage.clear()
    resetPersonaStoreForTest()
    await initPersonaStore()

    const state = usePersona.getState()
    const restored = state.cards.find((c) => c.id === 'card-1')
    assert.ok(restored)
    assert.equal(restored.card.name, '学姐')
    assert.equal(restored.avatar, 'data:image/png;base64,AAAA')
  })

  it('新增角色卡与头像只落大仓库，不再把大对象写回 localStorage', async () => {
    let saved: PersonaEntry[] = []
    setPersonaPersistenceForTest({
      loadCards: async () => [],
      saveCards: async (cards) => {
        saved = structuredClone(cards)
      },
    })

    resetPersonaStoreForTest()
    await initPersonaStore()

    const id = addPersonaCard(sampleCard('新角色'))
    setPersonaAvatar(id, 'data:image/webp;base64,BBBB')
    await flushPersonaWrites()

    assert.equal(localStorage.getItem('ds-lite:persona'), null)
    const prefsRaw = localStorage.getItem('ds-lite:persona-prefs') ?? ''
    assert.ok(!prefsRaw.includes('BBBB'))
    assert.equal(saved.length, 1)
    assert.equal(saved[0]?.avatar, 'data:image/webp;base64,BBBB')
  })
})
