// @vitest-environment node
/**
 * 临时探针（不入库用途，跑完即删）：把 kyclaw **真实发给 provider 的请求体**导出来，
 * 好拿去内网那台直接复放（区分"网关拦的"还是"LM Studio 对这份 schema 有问题"）。
 *
 * 做法与 `todo-tool-schema.spec.ts` 同路数：真起 Agent + 真 Mastra loop，
 * 用 MockLanguageModelV4 接住 provider 收到的 options（tools / prompt），原样落盘。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { expect, it } from 'vitest'
import { createKyclawAgent } from '../agents/kyclaw'
import { createPlanRuntime } from '../plan-runtime'
import { createTasksContext } from '../tasks-context'
import type { KyclawModel } from '../model'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}

const OUT_DIR = join(process.cwd(), '.superpowers', 'lmstudio-probe')

/** 把 AI SDK 的 prompt 转成 OpenAI chat 形状（只为复放用；system / user 都是字符串 + 文本块） */
function toMessages(prompt: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(prompt) ? prompt : []
  return list.map((raw) => {
    const message = raw as { role?: unknown; content?: unknown }
    const role = typeof message.role === 'string' ? message.role : 'user'
    const content = message.content
    if (typeof content === 'string') return { role, content }
    if (Array.isArray(content)) {
      const parts = content
        .map((part) => {
          const piece = part as { type?: unknown; text?: unknown }
          if (piece.type === 'text' && typeof piece.text === 'string') {
            return { type: 'text', text: piece.text }
          }
          return { type: String(piece.type ?? 'unknown') }
        })
        .slice(0, 50)
      return { role, content: parts }
    }
    return { role, content: content === undefined ? '' : JSON.stringify(content).slice(0, 500) }
  })
}

/** 门控：这只是一份"把真实请求体导出到本地"的排障探针，默认不跑（不产生副作用） */
const ENABLED = process.env.KYCLAW_R84_DUMP === '1'

it.skipIf(!ENABLED)('导出 kyclaw 真实请求体（tools + prompt → body）', async () => {
  let captured: { tools?: unknown; prompt?: unknown } | null = null

  const model = new MockLanguageModelV4({
    provider: 'kyclaw-real-body-probe',
    modelId: 'kyclaw-real-body-probe',
    doStream: async (options) => {
      captured = options as { tools?: unknown; prompt?: unknown }
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

  const tasksContext = createTasksContext()
  const planRuntime = createPlanRuntime({
    store: {
      find: async () => null,
      initialize: async () => undefined,
      enter: async () => null,
      update: async () => null,
      approve: async () => null,
      finish: async () => null,
      cancel: async () => null
    } as never,
    coordinator: {} as never,
    resume: async () => {
      throw new Error('probe：这里不该被调用')
    }
  })

  const agent = await createKyclawAgent(async () => model as unknown as KyclawModel, undefined, {
    mcpTools: async () => ({}),
    tasksContext,
    tasks: { ensureTable: async () => undefined } as never,
    planRuntime: planRuntime as never
  })

  const output = await agent.stream('111', { maxSteps: 1 })
  for await (const _chunk of output.fullStream) void _chunk

  const capturedTools = (captured as unknown as { tools?: unknown } | null)?.tools
  const capturedPrompt = (captured as unknown as { prompt?: unknown } | null)?.prompt
  const tools = capturedTools
  const messages = toMessages(capturedPrompt)

  mkdirSync(OUT_DIR, { recursive: true })
  const body = {
    model: 'qwen3.8-27b',
    messages,
    tools,
    tool_choice: 'auto',
    stream: true
  }
  const bodyNoStream = { ...body, stream: false }

  writeFileSync(join(OUT_DIR, 'kyclaw-real-tools.json'), JSON.stringify(tools, null, 2))
  writeFileSync(join(OUT_DIR, 'kyclaw-real-body.json'), JSON.stringify(body, null, 2))
  writeFileSync(
    join(OUT_DIR, 'kyclaw-real-body-nostream.json'),
    JSON.stringify(bodyNoStream, null, 2)
  )

  const names = (Array.isArray(tools) ? tools : []).map((tool) => {
    const item = tool as { name?: unknown; function?: { name?: unknown } }
    return typeof item.name === 'string' ? item.name : item.function?.name
  })
  console.log(
    `[probe] tools=${names.length} · 体量 ${JSON.stringify(body).length} 字节 · 消息 ${messages.length} 条\n` +
      `[probe] 工具名：${names.join(', ')}\n` +
      `[probe] 输出：${OUT_DIR}`
  )
  expect(names.length).toBeGreaterThan(20)
})
