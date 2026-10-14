// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { MastraServer } from '@mastra/hono'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { expect, it } from 'vitest'
import { createKyclawMastra } from '../index'
import { createTasksRouter } from '../routes/tasks'
import { createThreadsRouter } from '../routes/threads'
import { threadMemoryBody } from '../../shared/threads'

type Part =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>> extends { stream: ReadableStream<infer T> }
    ? T
    : never

it('生产装配真实 HTTP todo 写入、消息历史关联、线程删除截断和覆盖防线', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-tasks-http-'))
  let phase = 0
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
  }
  const model = new MockLanguageModelV4({
    provider: 'tasks-http',
    modelId: 'tasks-http',
    doStream: async () => {
      const snapshot = await handle.tasks.get('t1')
      const toolCallId = `http-todo-${phase}`
      let chunks: Part[]
      if (phase++ < 2) {
        const input = JSON.stringify(
          snapshot.revision === 0
            ? {
                action: 'replace',
                expectedRevision: 0,
                items: [{ title: 'HTTP 任务', status: 'pending' }]
              }
            : {
                action: 'update',
                expectedRevision: snapshot.revision,
                changes: [{ id: snapshot.items[0].id, status: 'done' }]
              }
        )
        chunks = [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-input-start', id: toolCallId, toolName: 'todo' },
          { type: 'tool-input-delta', id: toolCallId, delta: input },
          { type: 'tool-input-end', id: toolCallId },
          { type: 'tool-call', toolCallId, toolName: 'todo', input },
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }
        ]
      } else
        chunks = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text' },
          { type: 'text-delta', id: 'text', delta: '完成' },
          { type: 'text-end', id: 'text' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
        ]
      return { stream: simulateReadableStream({ chunks }) }
    }
  })
  const handle = await createKyclawMastra({ dataDir: dir, resolveModel: async () => model })
  const app = new Hono()
  app.use('*', async (context, next) => {
    if (context.req.header('Authorization') !== 'Bearer test-only')
      return context.json({ error: 'unauthorized' }, 401)
    await next()
    return undefined
  })
  app.route('/api/tasks', createTasksRouter({ memory: handle.memory, store: handle.tasks }))
  app.route(
    '/api/threads',
    createThreadsRouter({
      memory: handle.memory,
      tasks: handle.tasks,
      resolveModel: async () => model
    })
  )
  const server = new MastraServer({ app, mastra: handle.mastra })
  await server.init()
  const http = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>((resolve, reject) => {
    http.once('listening', resolve)
    http.once('error', reject)
  })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('test address unavailable')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const request = (path: string, method = 'GET', body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: 'Bearer test-only', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  const chat = {
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '记录并完成任务' }] }],
    ...threadMemoryBody('t1')
  }
  try {
    for (const key of [
      'requestContext',
      'inputProcessors',
      'outputProcessors',
      'tools',
      'toolsets',
      'activeTools',
      'onFinish',
      'instructions',
      'runId'
    ]) {
      expect((await request('/chat/kyclaw-agent', 'POST', { ...chat, [key]: {} })).status).toBe(400)
    }
    const response = await request('/chat/kyclaw-agent', 'POST', chat)
    expect(response.status).toBe(200)
    const stream = await response.text()
    expect(stream).not.toContain('无法唯一定位')
    await handle.memory.settled()
    expect((await handle.tasks.get('t1')).revision).toBe(2)
    const historyResponse = await request('/api/tasks/t1/history')
    expect(historyResponse.status).toBe(200)
    const history = (await historyResponse.json()) as {
      revisions: Array<{ messageId: string; toolCallId: string }>
    }
    expect(history.revisions).toHaveLength(2)
    const { messages } = await handle.memory.recall({ threadId: 't1', perPage: false })
    for (const revision of history.revisions) {
      const message = messages.find((item) => item.id === revision.messageId)
      expect(message?.role).toBe('assistant')
      expect(JSON.stringify(message?.content)).toContain(revision.toolCallId)
    }
    expect((await request('/api/tasks/missing/history')).status).toBe(404)
    expect(
      (
        await request('/api/threads/t1/truncate', 'POST', {
          messageId: history.revisions[0].messageId
        })
      ).status
    ).toBe(200)
    expect((await handle.tasks.get('t1')).items).toEqual([])
    expect((await handle.tasks.get('t1')).revision).toBe(3)
    expect((await request('/api/threads/t1', 'DELETE')).status).toBe(200)
    expect((await handle.tasks.get('t1')).revision).toBe(4)
  } finally {
    if ('closeAllConnections' in http && typeof http.closeAllConnections === 'function')
      http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await handle.mastra.shutdown()
    await handle.storage.close()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] tasks HTTP temp cleanup deferred')
    }
  }
}, 30_000)
