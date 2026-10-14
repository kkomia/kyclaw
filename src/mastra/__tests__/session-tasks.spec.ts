// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLStore } from '@mastra/libsql'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionTaskStore, type SessionTaskStore } from '../session-tasks'

let dir: string
let storage: LibSQLStore
let store: SessionTaskStore
const origin = { origin: 'tool' as const, messageId: 'm1', toolCallId: 'c1' }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-tasks-'))
  storage = new LibSQLStore({
    id: 'tasks-test',
    url: `file:${join(dir, 'tasks.db').replace(/\\/g, '/')}`
  })
  store = createSessionTaskStore(storage)
})

afterEach(async () => {
  await storage.close()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    console.warn('[kyclaw] task test temp cleanup deferred', error)
  }
})

const replace = (
  expectedRevision: number,
  title = '任务'
): {
  action: 'replace'
  expectedRevision: number
  items: Array<{ title: string; status: 'pending' }>
} => ({
  action: 'replace' as const,
  expectedRevision,
  items: [{ title, status: 'pending' as const }]
})

describe('任务 libsql 版本与 CAS', () => {
  it('空会话、服务端 id、完整时间、重建 store 持久化、版本来源', async () => {
    expect(await store.get('t1')).toEqual({ revision: 0, items: [], updatedAt: null })
    const result = await store.apply('t1', replace(0), origin)
    expect(result.status).toBe('ok')
    expect(result.snapshot.items[0]).toMatchObject({
      id: expect.any(String),
      createdAt: expect.any(String),
      updatedAt: expect.any(String)
    })
    expect(await createSessionTaskStore(storage).get('t1')).toEqual(result.snapshot)
    expect(await store.listRevisions('t1')).toEqual([
      { ...origin, revision: 1, snapshot: result.snapshot, createdAt: result.snapshot.updatedAt }
    ])
    expect(await store.get('t2')).toEqual({ revision: 0, items: [], updatedAt: null })
  })

  it('两个数据库连接并发同 revision 只能一份成功，冲突携带赢家快照', async () => {
    await store.ensureTable()
    const otherStorage = new LibSQLStore({
      id: 'tasks-other',
      url: `file:${join(dir, 'tasks.db').replace(/\\/g, '/')}`
    })
    try {
      const other = createSessionTaskStore(otherStorage)
      await other.ensureTable()
      const results = await Promise.all([
        store.apply('t1', replace(0, '甲'), origin),
        other.apply('t1', replace(0, '乙'), origin)
      ])
      expect(results.map((item) => item.status).sort()).toEqual(['conflict', 'ok'])
      expect(results[0].snapshot).toEqual(results[1].snapshot)
      expect(await store.listRevisions('t1')).toHaveLength(1)
    } finally {
      await otherStorage.close()
    }
  })

  it('未知 id、空 update、失去 blocked 理由、两个进行中均原子拒绝', async () => {
    const first = await store.apply(
      't1',
      {
        action: 'replace',
        expectedRevision: 0,
        items: [
          { title: '甲', status: 'blocked', note: '等待' },
          { title: '乙', status: 'in_progress' }
        ]
      },
      origin
    )
    const id = first.snapshot.items[0].id
    await expect(
      store.apply(
        't1',
        { action: 'update', expectedRevision: 1, changes: [{ id, note: null }] },
        origin
      )
    ).rejects.toThrow()
    await expect(
      store.apply(
        't1',
        { action: 'update', expectedRevision: 1, changes: [{ id, status: 'in_progress' }] },
        origin
      )
    ).rejects.toThrow()
    await expect(
      store.apply(
        't1',
        { action: 'update', expectedRevision: 1, changes: [{ id: 'unknown', title: 'x' }] },
        origin
      )
    ).rejects.toThrow()
    await expect(
      store.apply(
        't1',
        {
          action: 'replace',
          expectedRevision: 1,
          items: [{ id: 'unknown', title: 'x', status: 'pending' }]
        },
        origin
      )
    ).rejects.toThrow()
    expect(await store.get('t1')).toEqual(first.snapshot)
    expect(await store.listRevisions('t1')).toHaveLength(1)
    const updated = await store.apply(
      't1',
      { action: 'update', expectedRevision: 1, changes: [{ id, status: 'done', note: null }] },
      origin
    )
    expect(updated.snapshot.items[0]).not.toHaveProperty('note')
    expect(updated.snapshot.items[0].createdAt).toBe(first.snapshot.items[0].createdAt)
  })

  it('replace [] 清空、clear 清版本但保留单调墓碑，旧 revision 无 ABA', async () => {
    await store.apply('t1', replace(0), origin)
    await store.apply(
      't1',
      { action: 'replace', expectedRevision: 1, items: [] },
      { origin: 'user' }
    )
    expect((await store.get('t1')).items).toEqual([])
    const cleared = await store.clear('t1')
    expect(cleared.revision).toBe(3)
    expect(await store.listRevisions('t1')).toEqual([])
    const reopened = createSessionTaskStore(storage)
    expect((await reopened.apply('t1', replace(0), origin)).status).toBe('conflict')
    expect((await reopened.apply('t1', replace(2), origin)).status).toBe('conflict')
    expect((await reopened.apply('t1', replace(3), origin)).snapshot.revision).toBe(4)
  })

  it('截断最早被删除消息及其后版本，恢复此前快照且 revision 不回退', async () => {
    const first = await store.apply('t1', replace(0, '保留'), origin)
    await store.apply('t1', replace(1, '删除'), { ...origin, messageId: 'm2' })
    await store.apply('t1', replace(2, '后续用户改动'), { origin: 'user' })
    const restored = await store.truncate('t1', ['m2', 'm3'])
    expect(restored.items).toEqual(first.snapshot.items)
    expect(restored.revision).toBe(4)
    expect((await store.listRevisions('t1')).map((row) => row.revision)).toEqual([1])
    expect((await store.apply('t1', replace(1), origin)).status).toBe('conflict')
    expect(await store.truncate('t1', ['missing'])).toEqual(restored)
    const empty = await store.truncate('t1', ['m1'])
    expect(empty.items).toEqual([])
    expect(empty.revision).toBe(5)
  })

  it('缺少可信工具身份拒绝写库', async () => {
    await expect(store.apply('t1', replace(0), { origin: 'tool' })).rejects.toThrow('身份')
    expect(await store.listRevisions('t1')).toEqual([])
  })
})
