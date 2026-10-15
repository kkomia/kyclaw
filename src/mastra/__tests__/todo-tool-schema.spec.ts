// @vitest-environment node
/**
 * 发给 provider 的 todo function schema 形状（真实缺口见
 * `.superpowers/agent-comparison/kyclaw/run/code-task-1.json`）。
 *
 * DeepSeek / OpenAI 官方端点在 function-calling 校验阶段要求每个 function 的 parameters
 * 顶层是 `type: "object"`；而 todo 的入参是**顶层判别联合**，zod 导出的 JSON Schema 顶层
 * 只有 oneOf、没有 type，于是整轮请求 400（`got 'type: null'`）。todo 恒注入，任何一轮都发不出去。
 *
 * 这里不 mock 工具装配：真起 Agent + 真 Mastra loop，抓 MockLanguageModelV4 收到的 tools，
 * 断言**真正发给 provider 的那份** schema。同时钉住"只补顶层 type"——oneOf 的分支、
 * 以及分支内本来就无 type 的 anyOf（可空字段），都不许被改写。
 */
import { Agent } from '@mastra/core/agent'
import { Mastra } from '@mastra/core/mastra'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { beforeAll, expect, it, vi } from 'vitest'
import type { SessionTaskStore } from '../session-tasks'
import { createTodoTool } from '../tools/todo'

type ProviderCall = Parameters<MockLanguageModelV4['doStream']>[0]

interface JsonSchemaNode {
  $schema?: unknown
  type?: unknown
  oneOf?: JsonSchemaNode[]
  required?: string[]
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
  anyOf?: unknown
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}

function stubStore(): SessionTaskStore {
  const snapshot = { revision: 0, items: [], updatedAt: null }
  return {
    ensureTable: vi.fn(),
    get: vi.fn().mockResolvedValue(snapshot),
    listRevisions: vi.fn().mockResolvedValue([]),
    apply: vi.fn().mockResolvedValue({ status: 'ok', snapshot }),
    clear: vi.fn().mockResolvedValue(snapshot),
    truncate: vi.fn().mockResolvedValue(snapshot)
  } as unknown as SessionTaskStore
}

async function todoFunctionSchema(): Promise<JsonSchemaNode> {
  const calls: ProviderCall[] = []
  const model = new MockLanguageModelV4({
    provider: 'todo-schema-test',
    modelId: 'todo-schema-test',
    doStream: async (options) => {
      calls.push(options)
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: '已记录' },
            { type: 'text-end', id: 'text' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
          ]
        })
      }
    }
  })
  const agent = new Agent({
    id: 'todo-schema-agent',
    name: 'todo-schema-agent',
    instructions: 'Use todo to maintain tasks.',
    model,
    tools: { todo: await createTodoTool(stubStore()) }
  })
  const mastra = new Mastra({ agents: { 'todo-schema-agent': agent } })
  try {
    const output = await agent.stream('记录任务', { maxSteps: 1 })
    for await (const _chunk of output.fullStream) void _chunk
  } finally {
    await mastra.shutdown()
  }

  expect(calls).toHaveLength(1)
  const todoTool = calls[0]!.tools?.find((tool) => tool.type === 'function' && tool.name === 'todo')
  if (todoTool?.type !== 'function') throw new Error('todo 没有装配成 function 工具')
  return todoTool.inputSchema as JsonSchemaNode
}

let schema: JsonSchemaNode
beforeAll(async () => {
  schema = await todoFunctionSchema()
})

it('顶层 type/properties（LM Studio/DeepSeek 的 function schema 硬要求；properties 不能是空对象）', () => {
  expect(schema.type).toBe('object')
  expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#')
  // 缺 properties 整轮 400（LM Studio）；空对象又会让语法只允许 `{}`（模型调用退化成空参数），
  // 所以顶层必须列全三个分支用到的字段名
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
    'action',
    'changes',
    'expectedRevision',
    'items'
  ])
  expect(Object.keys(schema).sort()).toEqual([
    '$schema',
    'additionalProperties',
    'oneOf',
    'properties',
    'type'
  ])
})

it('oneOf 三个 action 分支原样保留：互斥与必填不变', () => {
  const branches = schema.oneOf ?? []
  expect(branches.map((branch) => branch.required)).toEqual([
    ['action'],
    ['action', 'expectedRevision', 'items'],
    ['action', 'expectedRevision', 'changes']
  ])
  expect(branches.map((branch) => branch.properties?.action)).toEqual([
    { type: 'string', const: 'get' },
    { type: 'string', const: 'replace' },
    { type: 'string', const: 'update' }
  ])
})

it('只补顶层 type：分支内可空字段的 anyOf 不被改写', () => {
  const updateBranch = (schema.oneOf ?? [])[2]
  expect(updateBranch?.properties?.changes?.items?.properties?.note).toEqual({
    anyOf: [{ type: 'string', maxLength: 1000 }, { type: 'null' }]
  })
  expect(updateBranch?.properties?.changes?.items?.properties?.note?.type).toBeUndefined()
})
