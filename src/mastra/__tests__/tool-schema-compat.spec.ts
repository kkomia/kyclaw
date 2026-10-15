// @vitest-environment node
/**
 * 工具 schema 的**跨 provider 兼容形状**（round 84）。
 *
 * 为什么单开一份：这些要求不是"风格"，而是**服务端硬校验**，而且踩过两次——
 *   ① DeepSeek 官方端点：每个 function 的 `parameters` 顶层必须是 `type: "object"`
 *      （`todo` 的判别联合只有 oneOf，整轮 400 `got 'type: null'`，见 agent-comparison
 *      run/code-task-1.json；修法见 shared/tasks.ts 的 `.meta`）。
 *   ② LM Studio（llama.cpp 系）：`parameters.properties` **必须存在且是对象**，缺失时整轮 400
 *      （实测 `invalid_type ... path [.., "properties"], message "Required"`，2026-10-15 内网复现；
 *      同样在 shared/tasks.ts 用 `.meta({ properties: {} })` 修）。
 *     它还会把工具 schema 编译成语法：**只有 maxItems、没有 minItems** 的数组在
 *     1999–2001 这个窗口编译失败（`failed to parse grammar`，1998/2002/2048 都正常；补上
 *     minItems 后同一上限可编译）——所以这里把"大 maxItems 必须带 minItems"钉成规则。
 *
 * 断言的是**真正发给 provider 的那份 schema**：真起 Agent + 真 Mastra loop，
 * 用 MockLanguageModelV4 接住 `options.tools`（与 todo-tool-schema.spec.ts 同路数）。
 */
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { expect, it } from 'vitest'
import { createKyclawAgent } from '../agents/kyclaw'
import { createPlanRuntime } from '../plan-runtime'
import { createTasksContext } from '../tasks-context'
import type { KyclawModel } from '../model'

interface JsonSchemaNode {
  type?: unknown
  properties?: Record<string, JsonSchemaNode>
  additionalProperties?: unknown
  items?: unknown
  oneOf?: unknown
  anyOf?: unknown
  minItems?: unknown
  maxItems?: unknown
}

/** LM Studio 语法编译失败的实测窗口（只有 maxItems、没有 minItems 时） */
const GRAMMAR_WINDOW = [1999, 2000, 2001]

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}

interface ToolFunction {
  name: string
  inputSchema: JsonSchemaNode
}

async function providerTools(): Promise<ToolFunction[]> {
  let captured: { tools?: unknown } | null = null
  const model = new MockLanguageModelV4({
    provider: 'tool-schema-compat',
    modelId: 'tool-schema-compat',
    doStream: async (options) => {
      captured = options as { tools?: unknown }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: '好' },
            { type: 'text-end', id: 'text' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
          ]
        })
      }
    }
  })

  const planRuntime = createPlanRuntime({
    store: {} as never,
    coordinator: {} as never,
    resume: async () => {
      throw new Error('tool-schema-compat：这里不该被调用')
    }
  })

  const agent = await createKyclawAgent(async () => model as unknown as KyclawModel, undefined, {
    mcpTools: async () => ({}),
    tasksContext: createTasksContext(),
    tasks: { ensureTable: async () => undefined } as never,
    planRuntime: planRuntime as never
  })

  const output = await agent.stream('检查工具 schema', { maxSteps: 1 })
  for await (const _chunk of output.fullStream) void _chunk

  const tools = (captured as { tools?: unknown } | null)?.tools
  if (!Array.isArray(tools)) throw new Error('没有抓到 provider 侧的工具清单')
  return tools.map((tool) => {
    const item = tool as { name?: unknown; inputSchema?: JsonSchemaNode }
    if (typeof item.name !== 'string' || item.inputSchema === undefined) {
      throw new Error('工具形状不对：拿不到 name/inputSchema')
    }
    return { name: item.name, inputSchema: item.inputSchema }
  })
}

/** 递归收集所有 schema 节点（含 properties / items / oneOf / anyOf） */
function walk(
  node: unknown,
  path: string,
  visit: (node: JsonSchemaNode, path: string) => void
): void {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, `${path}[${index}]`, visit))
    return
  }
  const record = node as JsonSchemaNode
  visit(record, path)
  if (record.properties !== undefined && typeof record.properties === 'object') {
    for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) {
      walk(child, `${path}.${key}`, visit)
    }
  }
  walk(record.items, `${path}[]`, visit)
  walk(record.oneOf, `${path}.oneOf`, visit)
  walk(record.anyOf, `${path}.anyOf`, visit)
}

let tools: ToolFunction[]
let loadError: unknown = null
try {
  tools = await providerTools()
} catch (error) {
  loadError = error
  tools = []
}

it('能拿到全部内置工具的 provider 侧 schema', () => {
  if (loadError !== null) throw loadError
  expect(tools.length).toBeGreaterThan(20)
})

it('每个工具的 parameters 顶层都是 object，且 properties 存在（DeepSeek / LM Studio 硬要求）', () => {
  const bad = tools.filter((tool) => {
    const schema = tool.inputSchema
    return (
      schema.type !== 'object' ||
      schema.properties === undefined ||
      typeof schema.properties !== 'object'
    )
  })
  expect(bad.map((tool) => tool.name)).toEqual([])
})

// 注：**只有顶层**有这个要求——LM Studio 对嵌套对象（如 fetch.headers 的 record 形状、
// 我们自己 properties 里的 `{type: "object"}`）不查 properties，工具级实测全部通过。

it('没有"只有 maxItems、没有 minItems"的数组落进语法编译窗口（LM Studio 实测 1999–2001）', () => {
  const bad: string[] = []
  for (const tool of tools) {
    walk(tool.inputSchema, tool.name, (node, path) => {
      if (typeof node.maxItems !== 'number') return
      if (node.minItems !== undefined) return
      if (GRAMMAR_WINDOW.includes(node.maxItems)) bad.push(`${path} maxItems=${node.maxItems}`)
    })
  }
  expect(bad).toEqual([])
})

it('顶层 oneOf 的分支字段都出现在顶层 properties 里（否则语法会禁掉这些键）', () => {
  const bad: string[] = []
  for (const tool of tools) {
    const branches = tool.inputSchema.oneOf
    if (!Array.isArray(branches)) continue
    const allowed = new Set(Object.keys(tool.inputSchema.properties ?? {}))
    for (const branch of branches as JsonSchemaNode[]) {
      for (const key of Object.keys(branch.properties ?? {})) {
        if (!allowed.has(key)) bad.push(`${tool.name} 分支字段 ${key}`)
      }
    }
  }
  expect(bad).toEqual([])
})
