// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLStore } from '@mastra/libsql'
import { Memory } from '@mastra/memory'
import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { expect, it } from 'vitest'
import { createSessionTaskStore } from '../session-tasks'
import { createTodoTool } from '../tools/todo'
import { createTasksContext } from '../tasks-context'
import { LOCAL_USER_RESOURCE_ID } from '../../shared/threads'

type Part =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>> extends { stream: ReadableStream<infer T> }
    ? T
    : never

it('公开 processor messageId 对应持久化 assistant 调用，replace/update 和线程隔离真实成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-task-context-'))
  const storage = new LibSQLStore({
    id: 'task-context-test',
    url: `file:${join(dir, 'tasks.db').replace(/\\/g, '/')}`
  })
  const store = createSessionTaskStore(storage)
  const memory = new Memory({ storage, options: { lastMessages: 10 } })
  const tasksContext = createTasksContext()
  let currentThread = 'thread-a'
  let phase = 0
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
  }
  const model = new MockLanguageModelV4({
    provider: 'tasks-test',
    modelId: 'tasks-test',
    doStream: async () => {
      const snapshot = await store.get(currentThread)
      const toolCallId = `call-${currentThread}-${phase}`
      let chunks: Part[]
      if (phase++ < 2) {
        const input = JSON.stringify(
          snapshot.revision === 0
            ? {
                action: 'replace',
                expectedRevision: 0,
                items: [{ title: currentThread, status: 'pending' }]
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
  const agent = new Agent({
    id: 'tasks-positive',
    name: 'tasks-positive',
    instructions: 'Maintain tasks.',
    model,
    memory,
    inputProcessors: [tasksContext.processor],
    tools: { todo: await createTodoTool(store, tasksContext) }
  })
  const mastra = new Mastra({ agents: { 'tasks-positive': agent }, storage })
  try {
    for (const threadId of ['thread-a', 'thread-b']) {
      currentThread = threadId
      phase = 0
      const request = tasksContext.prepareRequest(threadId)
      const output = await agent.stream('更新任务', {
        ...request,
        memory: { thread: threadId, resource: LOCAL_USER_RESOURCE_ID },
        maxSteps: 4
      })
      const chunks: Array<{ type: string; runId?: string }> = []
      for await (const chunk of output.fullStream) chunks.push(chunk)
      expect(chunks.filter((chunk) => chunk.type === 'tool-error')).toEqual([])
      expect(chunks.every((chunk) => chunk.runId === request.runId)).toBe(true)
      await memory.settled()
      const snapshot = await store.get(threadId)
      expect(snapshot.revision).toBe(2)
      expect(snapshot.items[0]).toMatchObject({ title: threadId, status: 'done' })
      const revisions = await store.listRevisions(threadId)
      expect(revisions.map((revision) => revision.revision)).toEqual([1, 2])
      const { messages } = await memory.recall({ threadId, perPage: false })
      for (const revision of revisions) {
        const message = messages.find((item) => item.id === revision.messageId)
        expect(message?.role).toBe('assistant')
        expect(message?.threadId).toBe(threadId)
        expect(JSON.stringify(message?.content)).toContain(revision.toolCallId)
      }
    }
    expect((await store.get('thread-a')).items[0].id).not.toBe(
      (await store.get('thread-b')).items[0].id
    )
    const revisions = await store.listRevisions('thread-a')
    const truncated = await store.truncate('thread-a', [revisions[0].messageId!])
    expect(truncated.items).toEqual([])
    expect(truncated.revision).toBe(3)
    expect((await store.get('thread-b')).revision).toBe(2)
  } finally {
    await mastra.shutdown()
    await storage.close()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] tasks context temp cleanup deferred')
    }
  }
}, 30_000)
