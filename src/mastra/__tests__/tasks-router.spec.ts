import type { MastraMemory } from '@mastra/core/memory'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { createTasksRouter } from '../routes/tasks'
import { TaskValidationError, type SessionTaskStore } from '../session-tasks'
import { LOCAL_USER_RESOURCE_ID } from '../../shared/threads'
import type { TaskSnapshot } from '../../shared/tasks'

function fixture(resourceId: string | null = LOCAL_USER_RESOURCE_ID): {
  app: Hono
  store: SessionTaskStore
  snapshot: TaskSnapshot
  request: (method?: string, body?: unknown, path?: string) => Promise<Response>
} {
  const snapshot = { revision: 3, items: [], updatedAt: null }
  const memory = {
    getThreadById: vi.fn().mockResolvedValue(resourceId === null ? null : { id: 't1', resourceId })
  } as unknown as Pick<MastraMemory, 'getThreadById'>
  const store: SessionTaskStore = {
    ensureTable: vi.fn(),
    get: vi.fn().mockResolvedValue(snapshot),
    listRevisions: vi.fn().mockResolvedValue([]),
    apply: vi.fn().mockResolvedValue({ status: 'ok', snapshot }),
    clear: vi.fn().mockResolvedValue(snapshot),
    truncate: vi.fn().mockResolvedValue(snapshot)
  }
  const app = new Hono()
  app.use('/api/*', async (context, next) => {
    if (context.req.header('Authorization') !== 'Bearer test-only')
      return context.json({ error: 'unauthorized' }, 401)
    await next()
    return undefined
  })
  app.route('/api/tasks', createTasksRouter({ memory, store }))
  const request = async (
    method = 'GET',
    body?: unknown,
    path = '/api/tasks/t1'
  ): Promise<Response> =>
    await app.request(path, {
      method,
      headers: { Authorization: 'Bearer test-only', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  return { app, store, snapshot, request }
}

describe('任务 HTTP 路由', () => {
  it('父 service Bearer 闸门拦截，GET/PUT 返回完整快照', async () => {
    const { app, request, store, snapshot } = fixture()
    expect((await app.request('/api/tasks/t1')).status).toBe(401)
    expect(store.get).not.toHaveBeenCalled()
    expect(await (await request()).json()).toEqual(snapshot)
    const input = { action: 'replace', expectedRevision: 3, items: [] }
    expect(await (await request('PUT', input)).json()).toEqual(snapshot)
    expect(store.apply).toHaveBeenCalledWith('t1', input, { origin: 'user' })
  })

  it.each([null, 'other-user'])('不存在或不属于 local-user 都 404 %#', async (owner) => {
    const { request, store } = fixture(owner)
    expect((await request()).status).toBe(404)
    expect(
      (await request('PUT', { action: 'replace', expectedRevision: 0, items: [] })).status
    ).toBe(404)
    expect(store.get).not.toHaveBeenCalled()
    expect(store.apply).not.toHaveBeenCalled()
  })

  it('非法参数、JSON、未知 id 都 400', async () => {
    const { request, app, store } = fixture()
    expect((await request('PUT', { action: 'get' })).status).toBe(400)
    expect((await request('GET', undefined, `/api/tasks/${'a'.repeat(201)}`)).status).toBe(400)
    expect(
      (
        await app.request('/api/tasks/t1', {
          method: 'PUT',
          headers: { Authorization: 'Bearer test-only' },
          body: '{'
        })
      ).status
    ).toBe(400)
    vi.mocked(store.apply).mockRejectedValue(new TaskValidationError('未知任务 id'))
    expect(
      (
        await request('PUT', {
          action: 'update',
          expectedRevision: 3,
          changes: [{ id: 'unknown', title: 'x' }]
        })
      ).status
    ).toBe(400)
  })

  it('409 包含最新快照，不再次写入', async () => {
    const { request, store, snapshot } = fixture()
    vi.mocked(store.apply).mockResolvedValue({ status: 'conflict', snapshot })
    const result = await request('PUT', { action: 'replace', expectedRevision: 0, items: [] })
    expect(result.status).toBe(409)
    expect(await result.json()).toEqual({ error: 'revision-conflict', snapshot })
    expect(store.apply).toHaveBeenCalledTimes(1)
  })
})
