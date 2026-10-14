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
import { threadMemoryBody } from '../../shared/threads'

type Part =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>> extends { stream: ReadableStream<infer T> }
    ? T
    : never

it('真实 HTTP ask 恢复后 todo 写入仍关联原 run 和持久化 assistant', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-task-resume-'))
  let phase = 0
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
  }
  const model = new MockLanguageModelV4({
    provider: 'task-resume',
    modelId: 'task-resume',
    doStream: async () => {
      const step = phase++
      let chunks: Part[]
      if (step < 2) {
        const toolName = step === 0 ? 'ask_user' : 'todo'
        const toolCallId = step === 0 ? 'ask-resume' : 'todo-after-resume'
        const input = JSON.stringify(
          step === 0
            ? {
                questions: [
                  {
                    id: 'q',
                    header: '确认',
                    question: '选择方式',
                    options: [
                      { id: 'yes', label: '继续' },
                      { id: 'no', label: '停止' }
                    ]
                  }
                ]
              }
            : {
                action: 'replace',
                expectedRevision: 0,
                items: [{ title: '恢复后的任务', status: 'pending' }]
              }
        )
        chunks = [
          { type: 'stream-start', warnings: [] },
          { type: 'tool-input-start', id: toolCallId, toolName },
          { type: 'tool-input-delta', id: toolCallId, delta: input },
          { type: 'tool-input-end', id: toolCallId },
          { type: 'tool-call', toolCallId, toolName, input },
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
  const server = new MastraServer({ app, mastra: handle.mastra })
  await server.init()
  const http = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>((resolve, reject) => {
    http.once('listening', resolve)
    http.once('error', reject)
  })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('test address unavailable')
  const url = `http://127.0.0.1:${address.port}`
  try {
    const initial = await fetch(`${url}/chat/kyclaw-agent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: '先问再记任务' }] }],
        ...threadMemoryBody('resume-thread')
      })
    })
    expect(initial.status).toBe(200)
    await initial.text()
    const pendingResponse = await fetch(`${url}/ask-user/pending?threadId=resume-thread`)
    const pending = (await pendingResponse.json()) as {
      pending: Array<{ runId: string; toolCallId: string }>
    }
    expect(pending.pending).toHaveLength(1)
    const originalRun = pending.pending[0].runId
    const response = await fetch(`${url}/ask-user/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: 'resume-thread',
        runId: originalRun,
        toolCallId: 'ask-resume',
        resumeData: {
          status: 'answered',
          answers: [{ questionId: 'q', selectedOptionIds: ['yes'] }]
        }
      })
    })
    expect(response.status).toBe(200)
    const stream = await response.text()
    expect(stream).not.toContain('无法唯一定位')
    await handle.memory.settled()
    const revisions = await handle.tasks.listRevisions('resume-thread')
    expect(revisions).toHaveLength(1)
    expect(revisions[0].toolCallId).toBe('todo-after-resume')
    const { messages } = await handle.memory.recall({ threadId: 'resume-thread', perPage: false })
    const message = messages.find((entry) => entry.id === revisions[0].messageId)
    expect(message?.role).toBe('assistant')
    expect(JSON.stringify(message?.content)).toContain('todo-after-resume')
    expect((await handle.tasks.get('resume-thread')).revision).toBe(1)
    expect(originalRun).toEqual(expect.any(String))
    expect(await (await fetch(`${url}/ask-user/pending?threadId=resume-thread`)).json()).toEqual({
      pending: []
    })
  } finally {
    if ('closeAllConnections' in http && typeof http.closeAllConnections === 'function')
      http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await handle.mastra.shutdown()
    await handle.storage.close()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] resume task test cleanup deferred')
    }
  }
}, 30_000)
