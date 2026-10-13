// @vitest-environment node
/**
 * round 66：会话↔PPT 模板映射（真 libsql + 真路由）。
 *
 * 三层关注点：
 *   1. 表与内存镜像的一致性：set/clear 之后同步 `get` 立刻是新值（create_ppt 取缺省模板读的就是它）；
 *   2. 持久化：换一个 store 实例 `load()`（= 应用重启）能读回同库里的映射；
 *   3. 路由：入参过 schema、**模板名必须过注册表**（认不出来的名字 400，不静默落成"其实没生效"），
 *      写失败 500；GET 回的是全量映射（渲染端启动拉一遍）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLStore } from '@mastra/libsql'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionPptTemplatesRouter } from '../routes/session-ppt-templates'
import {
  createSessionPptTemplateStore,
  type SessionPptTemplateStore
} from '../session-ppt-templates'

let dir: string
let storage: LibSQLStore
let store: SessionPptTemplateStore
let app: Hono

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-session-ppt-'))
  storage = new LibSQLStore({
    id: 'kyclaw-session-ppt-test',
    url: `file:${join(dir, 'kyclaw.db').replace(/\\/g, '/')}`
  })
  store = createSessionPptTemplateStore(storage)
  app = new Hono().route('/api/ppt', createSessionPptTemplatesRouter({ store }))
})

afterEach(async () => {
  await storage?.close()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

async function put(body: unknown): Promise<Response> {
  return await app.request('/api/ppt/templates', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('会话↔PPT 模板映射：表与内存镜像', () => {
  it('没载入、没写过：get 回 null（= 这个会话没固定模板），list 空', async () => {
    await store.ensureTable()
    expect(store.get('t1')).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('set 之后同步 get 立刻能看到（内存镜像），list 里也在', async () => {
    await store.set('t1', '学术紫')
    expect(store.get('t1')).toBe('学术紫')
    expect(store.list()).toEqual([{ threadId: 't1', template: '学术紫' }])
  })

  it('同一会话换模板 = 覆盖（不是两条）；clear 之后回 null（幂等）', async () => {
    await store.set('t1', '学术紫')
    await store.set('t1', '奶油')
    expect(store.list()).toEqual([{ threadId: 't1', template: '奶油' }])

    await store.clear('t1')
    expect(store.get('t1')).toBeNull()
    await store.clear('t1')
    expect(store.list()).toEqual([])
  })

  it('换一个实例 load()（= 应用重启）读回同库里的映射 —— 这个会话还认得自己那套', async () => {
    await store.set('t1', '酒红')
    await store.set('t2', '湖蓝')

    const reopened = createSessionPptTemplateStore(storage)
    await reopened.load()

    expect(reopened.get('t1')).toBe('酒红')
    expect(reopened.get('t2')).toBe('湖蓝')
    expect(reopened.list().sort((a, b) => a.threadId.localeCompare(b.threadId))).toEqual([
      { threadId: 't1', template: '酒红' },
      { threadId: 't2', template: '湖蓝' }
    ])
  })

  it('load 会整表覆盖镜像（库里删掉的不会留在内存里）', async () => {
    await store.set('t1', '酒红')
    await store.clear('t1')
    // 另一个实例在"我们"之外改了表（模拟）—— load 以库为准
    const other = createSessionPptTemplateStore(storage)
    await other.set('t9', '奶油')

    await store.load()
    expect(store.get('t1')).toBeNull()
    expect(store.get('t9')).toBe('奶油')
  })

  it('storage 形状不对（拿不到 client）→ 显式抛，不静默丢映射', () => {
    expect(() => createSessionPptTemplateStore({} as unknown as LibSQLStore)).toThrow(
      /libsql 客户端/
    )
  })
})

describe('路由：PUT /api/ppt/templates', () => {
  it('写一条：200 + 镜像更新（create_ppt 这一轮读到的就是它）', async () => {
    const response = await put({ threadId: 't1', template: '学术紫' })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(store.get('t1')).toBe('学术紫')
  })

  it('空串 = 清回自动（合法）：删掉那一行', async () => {
    await put({ threadId: 't1', template: '学术紫' })
    const response = await put({ threadId: 't1', template: '' })

    expect(response.status).toBe(200)
    expect(store.get('t1')).toBeNull()
  })

  it('不相干的模板名 → 400（不落一个"看着固定了、其实自动挑"的值）', async () => {
    const response = await put({ threadId: 't1', template: '彩虹色' })
    expect(response.status).toBe(400)
    expect(store.get('t1')).toBeNull()
    expect(store.list()).toEqual([])
  })

  it('入参形状不对（缺 threadId / 多字段）→ 400，表不动', async () => {
    expect((await put({ template: '酒红' })).status).toBe(400)
    expect((await put({ threadId: 't1', template: '酒红', extra: 1 })).status).toBe(400)
    expect(store.list()).toEqual([])
  })
})

describe('路由：GET /api/ppt/templates', () => {
  it('回全量映射（渲染端启动拉一遍，切会话当场就有）', async () => {
    await put({ threadId: 't1', template: '酒红' })
    await put({ threadId: 't2', template: '奶油' })

    const response = await app.request('/api/ppt/templates')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      sessions: Array<{ threadId: string; template: string }>
    }
    expect(body.sessions.sort((a, b) => a.threadId.localeCompare(b.threadId))).toEqual([
      { threadId: 't1', template: '酒红' },
      { threadId: 't2', template: '奶油' }
    ])
  })
})
