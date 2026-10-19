// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createKernelThreadsRouter, createKernelThreadsUnavailableRouter } from '../kernel-threads'
import type {
  KernelSessionEventLike,
  KernelSessionOps,
  KernelSessionSummary
} from '../../kernel/kernel-session-ops'
import { KernelSessionOpsError } from '../../kernel/kernel-session-ops'

function summary(sessionId: string, title: string | null = null): KernelSessionSummary {
  return {
    sessionId,
    title,
    updatedAt: 1_700_000_000_000,
    origin: 'user',
    cwd: '/workspace'
  }
}

function userEvent(text: string, seq = 1): KernelSessionEventLike {
  return {
    type: 'user/message',
    seq,
    time: 1_700_000_000_000,
    surfaceOp: 'append',
    data: {
      id: `u-${String(seq)}`,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text }]
    }
  }
}

function assistantEvent(text: string, seq = 2): KernelSessionEventLike {
  return {
    type: 'assistant/message',
    seq,
    time: 1_700_000_000_000,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: { id: `a-${String(seq)}`, role: 'assistant', content: [{ type: 'text', text }] }
    }
  }
}

interface FakeOps extends KernelSessionOps {
  calls: string[]
  archived: string[]
}

function fakeOps(): FakeOps {
  const calls: string[] = []
  const archived: string[] = []
  const threads = [
    summary('t1', '标题一'),
    summary('t2', null),
    { ...summary('t3'), origin: 'subagent' },
    summary('archived'),
    summary('session-default')
  ]
  const events: Record<string, KernelSessionEventLike[]> = {
    t1: [userEvent('你好'), assistantEvent('你好，在。')],
    t2: [userEvent('只有用户')],
    compacted: [
      userEvent('旧'),
      assistantEvent('旧回答'),
      {
        type: 'compaction/summary',
        seq: 3,
        time: 1_700_000_000_000,
        data: {
          summary: [{ type: 'text', text: '摘要' }],
          shadowedSeqs: [1, 2],
          shadowedRange: { start: 1, end: 2 }
        }
      }
    ]
  }
  const ops: FakeOps = {
    calls,
    archived,
    async listSessions() {
      return threads
    },
    async listArchivedSessionIds() {
      return ['archived']
    },
    async createSession(input) {
      calls.push(`create:${input.threadId}:${input.cwd}`)
      const created = summary(input.threadId, input.title ?? null)
      threads.push(created)
      return { session: created, created: true }
    },
    async renameSession(threadId, title) {
      calls.push(`rename:${threadId}:${title}`)
      const target = threads.find((thread) => thread.sessionId === threadId)
      if (target === undefined) throw new KernelSessionOpsError('session/not-found', 'missing')
      target.title = title
    },
    async readEvents(threadId) {
      return events[threadId] ?? []
    },
    async archiveSession(threadId) {
      calls.push(`archive:${threadId}`)
      if (threadId === 'missing') throw new KernelSessionOpsError('session/not-found', 'missing')
      archived.push(threadId)
    },
    async compact(threadId) {
      calls.push(`compact:${threadId}`)
      return { compacted: true, text: 'Compacted' }
    }
  }
  return ops
}

async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

describe('kernel-threads：9 个端点', () => {
  it('GET /api/threads：过滤 archived + subagent + adapter 默认会话（R2）', async () => {
    const app = createKernelThreadsRouter({
      ops: fakeOps(),
      defaultCwd: '/workspace',
      defaultSessionId: 'session-default'
    })
    const response = await app.request('/')
    expect(response.status).toBe(200)
    const body = await jsonOf<{
      threads: Array<{ id: string; title: string | null; updatedAt: string }>
    }>(response)
    expect(body.threads.map((thread) => thread.id)).toEqual(['t1', 't2'])
    expect(body.threads[0]).toMatchObject({ id: 't1', title: '标题一' })
    expect(body.threads[0]?.updatedAt).toBe('2023-11-14T22:13:20.000Z')
  })

  it('POST /api/threads：cwdOf 优先，返回 summary', async () => {
    const ops = fakeOps()
    const app = createKernelThreadsRouter({
      ops,
      defaultCwd: '/workspace',
      cwdOf: (threadId) => `/ws/${threadId}`
    })
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: 'new-thread', title: '新会话' })
    })
    expect(response.status).toBe(200)
    expect(ops.calls).toContain('create:new-thread:/ws/new-thread')
    await expect(jsonOf(response)).resolves.toMatchObject({ id: 'new-thread', title: '新会话' })
  })

  it('GET messages：事件投影成旧 StoredMessage', async () => {
    const app = createKernelThreadsRouter({ ops: fakeOps(), defaultCwd: '/workspace' })
    const response = await app.request('/t1/messages')
    expect(response.status).toBe(200)
    const body = await jsonOf<{ messages: Array<{ role: string; content: unknown }> }>(response)
    expect(body.messages).toHaveLength(2)
    expect(JSON.stringify(body.messages[0]?.content)).toContain('你好')
    expect(JSON.stringify(body.messages[1]?.content)).toContain('你好，在。')
  })

  it('PATCH：调用 rename 并回更新后的 summary', async () => {
    const ops = fakeOps()
    const app = createKernelThreadsRouter({ ops, defaultCwd: '/workspace' })
    const response = await app.request('/t1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '新标题' })
    })
    expect(response.status).toBe(200)
    expect(ops.calls).toContain('rename:t1:新标题')
    await expect(jsonOf(response)).resolves.toMatchObject({ id: 't1', title: '新标题' })
  })

  it('DELETE：映射归档；不存在也回 ok（幂等）', async () => {
    const ops = fakeOps()
    const app = createKernelThreadsRouter({ ops, defaultCwd: '/workspace' })
    const ok = await app.request('/t1', { method: 'DELETE' })
    expect(ok.status).toBe(200)
    await expect(jsonOf(ok)).resolves.toEqual({ ok: true })
    expect(ops.calls).toContain('archive:t1')

    const missing = await app.request('/missing', { method: 'DELETE' })
    expect(missing.status).toBe(200)
    await expect(jsonOf(missing)).resolves.toEqual({ ok: true })
  })

  it('truncate：501 feature-disabled，不返回 deleted', async () => {
    const app = createKernelThreadsRouter({ ops: fakeOps(), defaultCwd: '/workspace' })
    const response = await app.request('/t1/truncate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'm1' })
    })
    expect(response.status).toBe(501)
    const body = await jsonOf<{
      error: string
      feature: string
      availableIn: string
    }>(response)
    expect(body).toMatchObject({
      error: 'feature-disabled',
      feature: 'truncate',
      availableIn: '0.2.x'
    })
    expect(JSON.stringify(body)).not.toContain('deleted')
  })

  it('title：只读 projection，generated 恒为 false（没有强制生成 RPC）', async () => {
    const app = createKernelThreadsRouter({ ops: fakeOps(), defaultCwd: '/workspace' })
    const response = await app.request('/t2/title', { method: 'POST' })
    expect(response.status).toBe(200)
    await expect(jsonOf(response)).resolves.toEqual({ title: '', generated: false })
  })

  it('compact：无 keep；返回 compacted + 从事件派生的记录', async () => {
    const ops = fakeOps()
    const app = createKernelThreadsRouter({ ops, defaultCwd: '/workspace' })
    const response = await app.request('/compacted/compact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(response.status).toBe(200)
    expect(ops.calls).toContain('compact:compacted')
    await expect(jsonOf(response)).resolves.toMatchObject({
      compacted: true,
      compaction: { summary: '摘要', summarized: 2, level: 'summary' }
    })

    const keep = await app.request('/compacted/compact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keep: 10 })
    })
    expect(keep.status).toBe(501)
    await expect(jsonOf(keep)).resolves.toMatchObject({
      error: 'feature-disabled',
      feature: 'compact-keep',
      availableIn: '0.2.x'
    })
  })

  it('flag 关/无 adapter：threads 统一 503 feature-disabled，不注册旧实现', async () => {
    const app = createKernelThreadsUnavailableRouter('test')
    const response = await app.request('/')
    expect(response.status).toBe(503)
    await expect(jsonOf(response)).resolves.toMatchObject({
      error: 'feature-disabled',
      feature: 'threads',
      availableIn: '0.2.x'
    })
  })

  it('GET compaction：从 compaction/summary 派生；tokens 缺失为 null', async () => {
    const app = createKernelThreadsRouter({ ops: fakeOps(), defaultCwd: '/workspace' })
    const response = await app.request('/compacted/compaction')
    expect(response.status).toBe(200)
    const body = await jsonOf<{
      compaction: { summary: string; tokensBefore: number | null; tokensAfter: number | null }
    }>(response)
    expect(body.compaction).toMatchObject({
      summary: '摘要',
      tokensBefore: null,
      tokensAfter: null
    })
  })
})
