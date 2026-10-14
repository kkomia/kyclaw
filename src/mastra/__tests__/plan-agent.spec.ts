// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { RequestContext } from '@mastra/core/request-context'
import { createTool } from '@mastra/core/tools'
import { LibSQLStore } from '@mastra/libsql'
import { Memory } from '@mastra/memory'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { expect, it } from 'vitest'
import { z } from '../../shared/zod'
import { createPlanGuard } from '../plan-guard'
import { createSessionPlanStore } from '../session-plan'

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>> extends {
    stream: ReadableStream<infer Part>
  }
    ? Part
    : never

it('real Agent filters write, denies a forced write and executes read/search with server-owned identity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-plan-agent-'))
  const file = join(dir, 'target.txt')
  writeFileSync(file, 'unchanged')
  const storage = new LibSQLStore({
    id: 'plan-agent',
    url: `file:${join(dir, 'app.db').replace(/\\/g, '/')}`
  })
  const store = createSessionPlanStore(storage)
  const initial = await store.initialize('plan-thread')
  await store.enter('plan-thread', initial.version)
  const memory = new Memory({ storage, options: { lastMessages: 10 } })
  const runId = randomUUID()
  const requestContext = new RequestContext()
  const serverKey = `plan-server-${randomUUID()}`
  requestContext.set(serverKey, { threadId: 'plan-thread', runId })
  const guard = createPlanGuard({
    store,
    resolveRun: () => requestContext.get(serverKey) as { threadId: string; runId: string }
  })
  const exposed: string[][] = []
  const observedRunIds: Array<string | undefined> = []
  let readCalls = 0
  let searchCalls = 0
  let writeCalls = 0
  let step = 0
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 }
  }
  const model = new MockLanguageModelV4({
    provider: 'plan-test',
    modelId: 'plan-test',
    doStream: async (options) => {
      exposed.push((options.tools ?? []).map((tool) => tool.name))
      const name = ['read', 'web_search', 'write'][step++]
      const chunks: StreamPart[] = name
        ? [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-input-start', id: `call-${step}`, toolName: name },
            { type: 'tool-input-delta', id: `call-${step}`, delta: '{}' },
            { type: 'tool-input-end', id: `call-${step}` },
            { type: 'tool-call', toolCallId: `call-${step}`, toolName: name, input: '{}' },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }
          ]
        : [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: 'done' },
            { type: 'text-end', id: 'text' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
          ]
      return { stream: simulateReadableStream<StreamPart>({ chunks }) }
    }
  })
  const tool = (name: string, execute: () => string): ReturnType<typeof createTool> =>
    createTool({
      id: name,
      description: name,
      inputSchema: z.object({}),
      outputSchema: z.string(),
      execute: async () => execute()
    })
  const agent = new Agent({
    id: 'plan-agent',
    name: 'plan-agent',
    instructions: 'Research only.',
    model,
    memory,
    inputProcessors: [
      {
        id: 'observe-run',
        processInputStep(args) {
          observedRunIds.push(args.runId)
        }
      },
      guard.processor
    ],
    hooks: guard.hooks,
    tools: {
      write: tool('write', () => {
        writeCalls++
        writeFileSync(file, 'modified')
        return 'wrote'
      }),
      read: tool('read', () => {
        readCalls++
        return readFileSync(file, 'utf8')
      }),
      web_search: tool('web_search', () => {
        searchCalls++
        return 'research result'
      })
    }
  })
  const mastra = new Mastra({ agents: { 'plan-agent': agent }, storage })
  try {
    const output = await agent.stream('Research the file', {
      runId,
      requestContext,
      memory: { thread: 'plan-thread', resource: 'plan-user' },
      maxSteps: 5
    })
    const chunks: unknown[] = []
    for await (const chunk of output.fullStream) chunks.push(chunk)
    expect(exposed.length).toBeGreaterThan(0)
    expect(
      exposed.every(
        (names) =>
          !names.includes('write') && names.includes('read') && names.includes('web_search')
      )
    ).toBe(true)
    expect(writeCalls).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe('unchanged')
    expect(readCalls, JSON.stringify(chunks)).toBe(1)
    expect(searchCalls).toBe(1)
    expect(observedRunIds.length).toBeGreaterThan(0)
    expect(observedRunIds.every((id) => id === undefined || id === runId)).toBe(true)
    expect(observedRunIds).toContain(undefined)
    expect(JSON.stringify(chunks)).toContain('Tool \\"write\\" not found')
    await expect(
      guard.hooks.beforeToolCall!({
        toolName: 'write',
        input: {},
        context: { agent: { threadId: 'plan-thread' } }
      })
    ).rejects.toThrow('prohibited')
  } finally {
    await mastra.shutdown()
    await storage.close()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      console.warn('[kyclaw] plan agent cleanup deferred', error)
    }
  }
}, 30_000)
