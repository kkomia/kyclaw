// @vitest-environment node
/**
 * 探针（gated，默认不跑）：`onFinish` 事件里到底有没有**这一轮真实发给 provider 的请求体**，
 * 以及把它喂给落库抽取器（`request-log.ts`）能抽出什么。
 *
 * 为什么问这个（round 87 / 用户反馈 015）：现在请求组装（系统指令 + 运行时快照 + 规矩注入 +
 * 工具表 + 记忆）全部**每轮现算、零落库**，轨迹里因此没有"系统 / 上下文"两行——展示侧
 * （`trajectory/model.ts` 的 `system` / `context` 行类型与配色）已经半就绪，只差原料。
 * `@mastra/core` 的类型声明里 `steps[]` 带 `request: { body?: unknown }`
 * （stream/types.d.ts 的 LLMStepResult），而现有 `onFinish` 钩子（index.ts 的 chatOptions）
 * 就在手里——如果运行时真有值，落库就不必自己拼一份"像请求体"的东西。
 *
 * 做法：真起 Agent + 真 Mastra loop，模型用 MockLanguageModelV4。`doStream` 收到的是**真的调用
 * 参数**（这一轮的 system 指令 + 工具表），探针按 `@ai-sdk/openai-compatible` 的转换把它拼成
 * provider 形状的 body 回填到 `request: { body }`（真 provider 就是这么回的：实测
 * `@ai-sdk/openai-compatible` 与 `@ai-sdk/deepseek` 的 `doStream` 都回 `request: { body }`）。
 * 于是这个探针一次答两问：
 *   1. 框架这条管道通不通（回填的 body 原样出现在 onFinish 事件的 steps[].request.body 里吗）；
 *   2. 抽出来的东西长什么样（系统指令多长 / 工具几个 / 上下文几条，够不够轨迹那两行用）。
 *
 * 跑法：`KYCLAW_R87_DUMP=1 node_modules/.bin/vitest run src/mastra/__tests__/_r87-request-body.spec.ts`
 * 结论（2026-10-15 实测）见本轮 report。
 */
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { expect, it } from 'vitest'
import { createKyclawAgent } from '../agents/kyclaw'
import { createPlanRuntime } from '../plan-runtime'
import { createTasksContext } from '../tasks-context'
import {
  createRequestSnapshotRecorder,
  type RequestFinishEvent,
  type RequestSnapshot,
  type RequestSnapshotStore
} from '../request-log'
import type { KyclawModel } from '../model'

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}

const ENABLED = process.env.KYCLAW_R87_DUMP === '1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 按 `@ai-sdk/openai-compatible` 的转换把调用参数拼成 provider 形状的 body（探针用，简化版）：
 * system 进 `messages[0]`、工具进 `tools[].function`。真 provider 还会加 stream / 采样参数等，
 * 这里只造与抽取器有关的那两块。
 */
function providerShapedBody(options: unknown): Record<string, unknown> {
  const opts = isRecord(options) ? options : {}
  const prompt = Array.isArray(opts.prompt) ? opts.prompt : []
  const messages = prompt.map((raw) => {
    const message = isRecord(raw) ? raw : {}
    const role = typeof message.role === 'string' ? message.role : 'user'
    const content = message.content
    if (typeof content === 'string') return { role, content }
    const parts = Array.isArray(content) ? content : []
    const texts = parts.flatMap((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
    )
    const others = parts.length - texts.length
    return {
      role,
      content: texts.join('\n\n') + (others > 0 ? `\n[+${others} 个非文本块]` : '')
    }
  })
  const tools = (Array.isArray(opts.tools) ? opts.tools : []).flatMap((raw) => {
    if (!isRecord(raw)) return []
    const name = typeof raw.name === 'string' ? raw.name : null
    if (name === null) return []
    return [
      {
        type: 'function',
        function: {
          name,
          description: typeof raw.description === 'string' ? raw.description : undefined,
          parameters: raw.inputSchema
        }
      }
    ]
  })
  return { model: 'kyclaw-r87-probe', messages, tools, stream: true }
}

function topKeys(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.keys(value as Record<string, unknown>).sort()
}

/** body 可能是对象（兼容层直接给对象）也可能是字符串（JSON.stringify 过的） */
function describeBody(body: unknown): string {
  if (body === undefined) return 'undefined'
  if (body === null) return 'null'
  if (typeof body === 'string') {
    let keys = '（不是 JSON）'
    try {
      keys = JSON.stringify(topKeys(JSON.parse(body)))
    } catch {
      /* 保持"不是 JSON" */
    }
    return `string(${body.length} 字节) 顶层键=${keys}`
  }
  return `object 顶层键=${JSON.stringify(topKeys(body))}`
}

it.skipIf(!ENABLED)('onFinish 事件里 steps[].request.body 有没有值', async () => {
  /** 收集 onFinish 事件（只收第一份，够答问题） */
  const finished: unknown[] = []
  /** 探针回填的"provider 形状 body"（由这一轮真的调用参数拼出来） */
  let returnBody: Record<string, unknown> | null = null
  let capturedToolCount = 0

  const model = new MockLanguageModelV4({
    provider: 'kyclaw-r87-probe',
    modelId: 'kyclaw-r87-probe',
    doStream: async (options) => {
      returnBody = providerShapedBody(options)
      capturedToolCount = Array.isArray(returnBody.tools) ? returnBody.tools.length : 0
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text' },
            { type: 'text-delta', id: 'text', delta: '好' },
            { type: 'text-end', id: 'text' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
          ]
        }),
        // 真 provider 的形状（@ai-sdk/openai-compatible / deepseek 的 doStream 都这么回）
        request: { body: returnBody },
        response: { headers: {} }
      } as never
    }
  })

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
    tasksContext: createTasksContext(),
    tasks: { ensureTable: async () => undefined } as never,
    planRuntime: planRuntime as never
  })

  const output = await agent.stream('R87: 探针一轮', {
    maxSteps: 1,
    onFinish: (event) => {
      finished.push(event)
    }
  } as never)
  for await (const _chunk of output.fullStream) void _chunk

  const event = finished[0] as
    | {
        request?: { body?: unknown }
        steps?: Array<{ request?: { body?: unknown }; response?: Record<string, unknown> }>
        finishReason?: unknown
      }
    | undefined

  const step = event?.steps?.[0]
  const stepRequest = step?.request
  const stepBody = stepRequest?.body
  const topBody = event?.request?.body

  // 第二问：把这个事件喂给**真的**落库抽取器，看抽出来的是什么
  const rows: RequestSnapshot[] = []
  await createRequestSnapshotRecorder({
    store: { insert: async (row) => void rows.push(row) } as unknown as RequestSnapshotStore,
    now: () => new Date('2026-10-15T06:00:00.000Z')
  })(event as RequestFinishEvent)
  const extracted = rows[0]
  const extractedSystem = extracted?.system ?? null
  const extractedTools = extracted?.tools ?? null
  /** 回填的 body 是在 doStream 回调里赋的值：这里显式收窄一次（TS 对闭包内赋值不做流分析） */
  const probeBody = returnBody as Record<string, unknown> | null
  let extractedToolCount = 0
  try {
    const parsed: unknown = extractedTools === null ? [] : JSON.parse(extractedTools)
    extractedToolCount = Array.isArray(parsed) ? parsed.length : 0
  } catch {
    extractedToolCount = -1
  }

  console.log(
    [
      '[r87] onFinish 事件收到：',
      `  · 事件数 ${finished.length} · finishReason=${String(event?.finishReason)}`,
      `  · 事件顶层键 = ${JSON.stringify(topKeys(event))}`,
      `  · event.request.body = ${describeBody(topBody)}`,
      `  · steps 数 = ${event?.steps?.length ?? 0}`,
      `  · steps[0] 顶层键 = ${JSON.stringify(topKeys(step))}`,
      `  · steps[0].request 顶层键 = ${JSON.stringify(topKeys(stepRequest))}`,
      `  · steps[0].request.body = ${describeBody(stepBody)}`,
      `  · steps[0].response 顶层键 = ${JSON.stringify(topKeys(step?.response))}`,
      `  · 回填 body 命中（steps[0].request.body === 回填对象） = ${stepBody === returnBody}`,
      '[r87] 这一轮真的调用参数（探针收到、拼成 provider 形状）：',
      `  · 工具表 = ${capturedToolCount} 个工具`,
      `  · 消息 = ${Array.isArray(probeBody?.messages) ? (probeBody.messages as unknown[]).length : 0} 条`,
      '[r87] 把事件喂给 request-log 的抽取器，落库行长这样：',
      extracted === undefined
        ? '  · 没落行（抽取器认为这份请求体没信息量）'
        : [
            `  · system = ${extractedSystem === null ? 'null' : `${extractedSystem.length} 字 · 首行「${extractedSystem.split('\n')[0]?.slice(0, 80)}」`}`,
            `  · tools = ${extractedTools === null ? 'null' : `${extractedTools.length} 字节 · ${extractedToolCount} 个工具`}`,
            `  · messageCount = ${String(extracted.messageCount)} · model = ${extracted.model}`,
            `  · 总字节数 ≈ ${(extractedSystem?.length ?? 0) + (extractedTools?.length ?? 0)}`
          ].join('\n')
    ].join('\n')
  )

  // 探针本身不断言"必须有值"：它是**取证**，两种结果都算跑通（结论写进 report）
  expect(finished.length).toBeGreaterThan(0)
})
