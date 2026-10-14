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
import { LOCAL_USER_RESOURCE_ID } from '../../shared/threads'

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>> extends {
    stream: ReadableStream<infer Part>
  }
    ? Part
    : never

it('真实 agent loop 在 assistant 消息尚未进入 getMessages 时拒绝伪造身份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-todo-agent-'))
  const storage = new LibSQLStore({
    id: 'todo-agent-test',
    url: `file:${join(dir, 'tasks.db').replace(/\\/g, '/')}`
  })
  const store = createSessionTaskStore(storage)
  const memory = new Memory({ storage, options: { lastMessages: 10 } })
  const input = JSON.stringify({
    action: 'replace',
    expectedRevision: 0,
    items: [{ title: '任务数据', status: 'pending' }]
  })
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 3, text: 3, reasoning: 0 }
  }
  let call = 0
  const model = new MockLanguageModelV4({
    provider: 'todo-test',
    modelId: 'todo-test',
    doStream: async () => ({
      stream: simulateReadableStream<StreamPart>({
        chunks:
          call++ === 0
            ? [
                { type: 'stream-start', warnings: [] },
                { type: 'tool-input-start', id: 'call-todo', toolName: 'todo' },
                { type: 'tool-input-delta', id: 'call-todo', delta: input },
                { type: 'tool-input-end', id: 'call-todo' },
                { type: 'tool-call', toolCallId: 'call-todo', toolName: 'todo', input },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                  usage
                }
              ]
            : [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text' },
                { type: 'text-delta', id: 'text', delta: '已记录' },
                { type: 'text-end', id: 'text' },
                { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
              ]
      })
    })
  })
  const agent = new Agent({
    id: 'todo-agent',
    name: 'todo-agent',
    instructions: 'Use todo to maintain tasks.',
    model,
    memory,
    tools: { todo: await createTodoTool(store) }
  })
  const mastra = new Mastra({ agents: { 'todo-agent': agent }, storage })
  try {
    const output = await agent.stream('记录任务', {
      memory: { thread: 'thread-todo', resource: LOCAL_USER_RESOURCE_ID },
      maxSteps: 3
    })
    const chunks: unknown[] = []
    for await (const chunk of output.fullStream) chunks.push(chunk)
    const toolError = chunks.find(
      (chunk) =>
        typeof chunk === 'object' &&
        chunk !== null &&
        'type' in chunk &&
        chunk.type === 'tool-error'
    )
    expect(JSON.stringify(toolError)).toContain(
      'todo 当前时序无法唯一定位 assistant 调用消息，未写入任务'
    )
    expect(JSON.stringify(toolError)).toContain('call-todo')
    expect(await store.listRevisions('thread-todo')).toEqual([])
    expect(await store.get('thread-todo')).toEqual({ revision: 0, items: [], updatedAt: null })
    await memory.settled()
    const { messages } = await memory.recall({ threadId: 'thread-todo', perPage: false })
    expect(messages.some((message) => message.role === 'assistant')).toBe(true)
  } finally {
    await mastra.shutdown()
    await storage.close()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      console.warn('[kyclaw] todo agent test temp cleanup deferred', error)
    }
  }
}, 30_000)
