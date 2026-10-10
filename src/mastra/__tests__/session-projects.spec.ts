// @vitest-environment node
/**
 * T18 Step 1b：会话↔项目映射（真 libsql）。
 *
 * 两层关注点：
 *   1. 表与内存镜像的一致性：set/clear 之后同步 `get` 立刻是新值（工具装配读的就是它）；
 *   2. 持久化：换一个 store 实例 `load()`（= 应用重启）能读回同库里的映射；
 *   3. 失败不静默：storage 形状不对要显式抛（升级 @mastra/libsql 后这里会先炸，不会丢映射）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLStore } from '@mastra/libsql'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionProjectStore, type SessionProjectStore } from '../session-projects'

let dir: string
let storage: LibSQLStore
let store: SessionProjectStore

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-session-projects-'))
  storage = new LibSQLStore({
    id: 'kyclaw-session-projects-test',
    url: `file:${join(dir, 'kyclaw.db').replace(/\\/g, '/')}`
  })
  store = createSessionProjectStore(storage)
})

afterEach(async () => {
  await storage?.close()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('会话↔项目映射', () => {
  it('没载入、没写过：get 回 null（= 没有项目）', async () => {
    await store.ensureTable()
    expect(store.get('t1')).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('set 之后同步 get 立刻能看到（内存镜像），list 里也在', async () => {
    await store.set('t1', 'p1')
    expect(store.get('t1')).toBe('p1')
    expect(store.list()).toEqual([{ threadId: 't1', projectId: 'p1' }])
  })

  it('同一会话改项目 = 覆盖（不是两条）；clear 之后回 null（幂等）', async () => {
    await store.set('t1', 'p1')
    await store.set('t1', 'p2')
    expect(store.list()).toEqual([{ threadId: 't1', projectId: 'p2' }])

    await store.clear('t1')
    expect(store.get('t1')).toBeNull()
    await store.clear('t1')
    expect(store.list()).toEqual([])
  })

  it('换一个实例 load()（= 应用重启）读回同库里的映射', async () => {
    await store.set('t1', 'p1')
    await store.set('t2', 'p2')

    const reopened = createSessionProjectStore(storage)
    await reopened.load()

    expect(reopened.get('t1')).toBe('p1')
    expect(reopened.get('t2')).toBe('p2')
    expect(reopened.list().sort((a, b) => a.threadId.localeCompare(b.threadId))).toEqual([
      { threadId: 't1', projectId: 'p1' },
      { threadId: 't2', projectId: 'p2' }
    ])
  })

  it('load 会整表覆盖镜像（库里删掉的不会留在内存里）', async () => {
    await store.set('t1', 'p1')
    await store.clear('t1')
    // 另一个实例在"我们"之外改了表（模拟）—— load 以库为准
    const other = createSessionProjectStore(storage)
    await other.set('t9', 'p9')

    await store.load()
    expect(store.get('t1')).toBeNull()
    expect(store.get('t9')).toBe('p9')
  })

  it('storage 形状不对（拿不到 client）→ 显式抛，不静默丢映射', () => {
    expect(() => createSessionProjectStore({} as unknown as LibSQLStore)).toThrow(/libsql 客户端/)
  })
})
