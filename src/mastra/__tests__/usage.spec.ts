// @vitest-environment node
/**
 * T14 Step 2：用量记账。
 *
 * 两层：
 *   1. 价目与花费计算（纯函数）：已知模型按价目算、未知模型 cost=null、缓存档打折、
 *      统计窗口的边界（今天 = 本地零点起；本月 = 本地 1 号零点起）；
 *   2. 真服务集成（startAgentServer：chat 路由 v7 + libsql + Memory + usage 表）：
 *      一轮对话的 usage 从 chat 流里被记账钩子提取 → 写进 libsql 的 `usage_runs` →
 *      `GET /api/usage` 能按模型看到 token 与花费。
 *
 * 记账钩子的到达位置见 src/mastra/usage.ts 头注（chatRoute 的 defaultOptions.onFinish）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { LibSQLStore } from '@mastra/libsql'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { usageResponseSchema, type UsageResponse } from '../../shared/usage'
import { threadMemoryBody } from '../../shared/threads'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import type { KyclawModel } from '../model'
import { createUsageRouter } from '../routes/usage'
import {
  computeCost,
  createUsageRecorder,
  createUsageStore,
  MODEL_PRICING,
  pricingFor,
  rangeStart,
  summarizeUsage,
  threadTokenReadout,
  usageSqlClient,
  type UsageRun,
  type UsageStore
} from '../usage'

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }

/** mock 流的 chunk 类型（从 MockLanguageModelV4 的 doStream 签名上取，避免手抄 spec） */
type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

function textScript(text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: FINISH_STOP, usage: USAGE }
  ]
}

/** 造一行 usage_runs（token 从 input/output 推出 total，除非显式给） */
function run(overrides: {
  model: string
  provider?: string | null
  threadId?: string | null
  input?: number
  output?: number
  total?: number
  cachedInput?: number | null
  /** round 67：末次调用的输入（真实上下文大小）；不给 = null（回读退回整轮合计） */
  contextInput?: number | null
  contextCachedInput?: number | null
  stepCount?: number | null
  cost?: number | null
  at?: Date
}): UsageRun {
  const input = overrides.input ?? 0
  const output = overrides.output ?? 0
  return {
    id: `run-${Math.random().toString(36).slice(2)}`,
    runId: null,
    threadId: overrides.threadId ?? null,
    model: overrides.model,
    provider: overrides.provider ?? null,
    tokens: { input, output, total: overrides.total ?? input + output },
    cachedInput: overrides.cachedInput ?? null,
    contextInput: overrides.contextInput ?? null,
    contextCachedInput: overrides.contextCachedInput ?? null,
    stepCount: overrides.stepCount ?? null,
    cost: overrides.cost ?? null,
    createdAt: (overrides.at ?? new Date()).toISOString()
  }
}

/** 从行列表算窗口内的运行总数（断言"记了几行"用） */
function runCount(usage: UsageResponse): number {
  return usage.byModel.reduce((sum, row) => sum + row.runs, 0)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('价目与花费计算', () => {
  it('价目查找：认大小写与 provider 前缀，认 DeepSeek 的现行与遗留模型名，其余 null', () => {
    expect(pricingFor('deepseek-flash')).toEqual(MODEL_PRICING['deepseek-flash'])
    expect(pricingFor('DeepSeek-Flash')).toEqual(MODEL_PRICING['deepseek-flash'])
    expect(pricingFor('deepseek/deepseek-flash')).toEqual(MODEL_PRICING['deepseek-flash'])
    expect(pricingFor('deepseek-v4-pro')).toEqual(MODEL_PRICING['deepseek-v4-pro'])
    // 遗留名 deepseek-v4-flash 由 Flash 承载（官方定价页脚注），按 Flash 计价
    expect(pricingFor('deepseek-v4-flash')).toEqual(MODEL_PRICING['deepseek-flash'])
    expect(pricingFor('kimi-k3')).toBeNull()
    expect(pricingFor('')).toBeNull()
    expect(pricingFor(null)).toBeNull()
    expect(pricingFor(undefined)).toBeNull()
  })

  it('花费 = 输入(未命中) + 输入(命中) + 输出，按百万 token 单价折算', () => {
    const pricing = MODEL_PRICING['deepseek-flash']
    expect(computeCost(pricing, { input: 1_000_000, output: 1_000_000 })).toBeCloseTo(
      pricing.inputPerMillion + pricing.outputPerMillion,
      10
    )
    // 全部命中缓存：输入按命中价
    expect(
      computeCost(pricing, { input: 1_000_000, output: 0, cachedInput: 1_000_000 })
    ).toBeCloseTo(pricing.cachedInputPerMillion, 10)
    // 命中数超过输入数：按输入数封顶（不出现负的"未命中"）
    expect(
      computeCost(pricing, { input: 1_000_000, output: 0, cachedInput: 2_000_000 })
    ).toBeCloseTo(pricing.cachedInputPerMillion, 10)
    expect(computeCost(pricing, { input: 0, output: 0 })).toBe(0)
  })

  it('窗口边界：今天 = 本地零点起；本月 = 本地 1 号零点起', () => {
    const now = new Date(2026, 9, 15, 13, 45, 30) // 2026-10-15 13:45:30（本地）
    expect(rangeStart('today', now).getTime()).toBe(new Date(2026, 9, 15, 0, 0, 0, 0).getTime())
    expect(rangeStart('month', now).getTime()).toBe(new Date(2026, 9, 1, 0, 0, 0, 0).getTime())
  })

  it('汇总：按模型分组（token 降序）、有价部分求和、未知模型让 costIncomplete 为真', () => {
    const rows: UsageRun[] = [
      run({ model: 'a-known', provider: 'p', input: 100, output: 50, cost: 0.5 }),
      run({ model: 'a-known', provider: 'p', input: 30, output: 10, cost: 0.1 }),
      run({ model: 'b-unknown', provider: null, input: 7, output: 3, cost: null })
    ]

    const summary = summarizeUsage(rows, 'today')
    expect(summary.tokens).toEqual({ input: 137, output: 63, total: 200 })
    expect(summary.cost).toBeCloseTo(0.6, 10)
    expect(summary.costIncomplete).toBe(true)
    expect(summary.byModel.map((row) => [row.model, row.runs])).toEqual([
      ['a-known', 2],
      ['b-unknown', 1]
    ])
    expect(summary.byModel[0]?.tokens).toEqual({ input: 130, output: 60, total: 190 })
    expect(summary.byModel[0]?.cost).toBeCloseTo(0.6, 10)
    expect(summary.byModel[1]?.cost).toBeNull()
  })

  it('汇总边界：空列表 = 全 0 且 cost=null；全是未知模型 = cost=null（不把未知当 0）', () => {
    expect(summarizeUsage([], 'today')).toMatchObject({
      tokens: { input: 0, output: 0, total: 0 },
      cost: null,
      costIncomplete: false,
      byModel: []
    })
    expect(summarizeUsage([run({ model: 'x', cost: null })], 'today')).toMatchObject({
      cost: null,
      costIncomplete: true
    })
  })
})

describe('记账钩子：从 onFinish 事件取"上下文口径"（round 67）', () => {
  /** 记一行就回，供断言读 */
  async function record(event: unknown): Promise<UsageRun | null> {
    const runs: UsageRun[] = []
    const store = {
      insert: async (row: UsageRun) => {
        runs.push(row)
      }
    } as unknown as UsageStore
    await createUsageRecorder({ store })(event as never)
    return runs[0] ?? null
  }

  it('末个 step 的 usage 落进 contextInput；stepNumber+1 落进 stepCount；整轮合计仍进 tokens', async () => {
    const row = await record({
      // AI SDK 的 totalUsage = 全部 step 之和（花费口径）
      totalUsage: { inputTokens: 221_356, outputTokens: 3_928, totalTokens: 225_284, cachedInputTokens: 194_944 },
      stepNumber: 8,
      steps: [
        { usage: { inputTokens: 11_000 } },
        { usage: { inputTokens: 30_000, cachedInputTokens: 29_000 } }
      ],
      finalStep: { usage: { inputTokens: 30_000, cachedInputTokens: 29_000 } },
      model: { modelId: 'deepseek-flash', provider: 'deepseek.chat' }
    })
    expect(row).not.toBeNull()
    expect(row?.tokens.input).toBe(221_356)
    expect(row?.cachedInput).toBe(194_944)
    expect(row?.contextInput).toBe(30_000)
    expect(row?.contextCachedInput).toBe(29_000)
    expect(row?.stepCount).toBe(9)
  })

  it('事件里没有 steps / stepNumber 时两个口径都是 null（不编造），整轮合计照记', async () => {
    const row = await record({
      usage: { inputTokens: 120, outputTokens: 7, totalTokens: 127 },
      model: { modelId: 'deepseek-flash' }
    })
    expect(row?.tokens.input).toBe(120)
    expect(row?.contextInput).toBeNull()
    expect(row?.contextCachedInput).toBeNull()
    expect(row?.stepCount).toBeNull()
  })

  it('缓存命中兼容两种形状：cachedInputTokens 别名 与 inputTokenDetails.cacheReadTokens', async () => {
    const row = await record({
      totalUsage: {
        inputTokens: 500,
        outputTokens: 10,
        totalTokens: 510,
        inputTokenDetails: { cacheReadTokens: 480 }
      },
      finalStep: {
        usage: { inputTokens: 300, inputTokenDetails: { cacheReadTokens: 290 } }
      },
      model: { modelId: 'deepseek-flash' }
    })
    expect(row?.cachedInput).toBe(480)
    expect(row?.contextInput).toBe(300)
    expect(row?.contextCachedInput).toBe(290)
  })
})

describe('会话 token 读数（round 59 / round 67）', () => {
  it('按 created_at 升序取首末：末行 = 最近一轮、首行 = 基线；空会话三个字段全 null', async () => {
    const rows = [
      run({ model: 'm', threadId: 't', input: 100, output: 5, at: new Date(2026, 9, 15, 9, 0, 0) }),
      run({
        model: 'm',
        threadId: 't',
        input: 400,
        output: 5,
        cachedInput: 300,
        at: new Date(2026, 9, 15, 10, 0, 0)
      })
    ]
    const store = { listByThread: async () => rows } as unknown as UsageStore
    // 这个口径同时喂 /api/usage/context 与压缩记录的 tokensBefore（同一处实现，不各算一套）
    expect(await threadTokenReadout(store, 't')).toEqual({
      lastInput: 400,
      lastCachedInput: 300,
      baselineInput: 100
    })

    const empty = { listByThread: async () => [] } as unknown as UsageStore
    expect(await threadTokenReadout(empty, 't')).toEqual({
      lastInput: null,
      lastCachedInput: null,
      baselineInput: null
    })
  })

  it('round 67：有"末次调用"这一列时用它（真实上下文），不再拿整轮合计冒充', async () => {
    // 一轮 9 次调用：整轮合计 221,356，而最后一次调用只有 30,000 —— 面板要的是后者
    const rows = [
      run({
        model: 'm',
        threadId: 't',
        input: 21_000,
        contextInput: 11_000,
        contextCachedInput: 9_000,
        stepCount: 1,
        at: new Date(2026, 9, 15, 9, 0, 0)
      }),
      run({
        model: 'm',
        threadId: 't',
        input: 221_356,
        cachedInput: 194_944,
        contextInput: 30_000,
        contextCachedInput: 29_000,
        stepCount: 9,
        at: new Date(2026, 9, 15, 10, 0, 0)
      })
    ]
    const store = { listByThread: async () => rows } as unknown as UsageStore
    expect(await threadTokenReadout(store, 't')).toEqual({
      lastInput: 30_000,
      lastCachedInput: 29_000,
      baselineInput: 11_000
    })
  })

  it('round 67：新旧混排（老行没有那一列）时逐行各自退回整轮合计，不整体作废', async () => {
    const rows = [
      run({ model: 'm', threadId: 't', input: 100, at: new Date(2026, 9, 15, 9, 0, 0) }),
      run({
        model: 'm',
        threadId: 't',
        input: 400,
        cachedInput: 399,
        contextInput: 250,
        contextCachedInput: 240,
        stepCount: 3,
        at: new Date(2026, 9, 15, 10, 0, 0)
      })
    ]
    const store = { listByThread: async () => rows } as unknown as UsageStore
    expect(await threadTokenReadout(store, 't')).toEqual({
      lastInput: 250,
      lastCachedInput: 240,
      baselineInput: 100
    })
  })
})

describe('用量路由：窗口过滤（真 libsql，注入 now）', () => {
  let dir: string
  let storage: LibSQLStore
  let store: ReturnType<typeof createUsageStore>
  let app: Hono

  const NOW = new Date(2026, 9, 15, 12, 0, 0) // 2026-10-15 12:00（本地）

  async function get(range: string): Promise<UsageResponse> {
    const response = await app.request(`/api/usage?range=${range}`)
    expect(response.status).toBe(200)
    return usageResponseSchema.parse(await response.json())
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-usage-route-'))
    storage = new LibSQLStore({
      id: 'kyclaw-usage-route',
      url: `file:${join(dir, 'kyclaw.db').replace(/\\/g, '/')}`
    })
    store = createUsageStore(usageSqlClient(storage))
    await store.ensureTable()
    app = new Hono().route('/api/usage', createUsageRouter({ store, now: () => NOW }))
  })

  afterAll(async () => {
    await storage?.close()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
    }
  })

  it('空窗口：全 0、cost=null、costIncomplete=false、byModel 空', async () => {
    expect(await get('today')).toMatchObject({
      range: 'today',
      tokens: { input: 0, output: 0, total: 0 },
      cost: null,
      costIncomplete: false,
      byModel: []
    })
  })

  it('今日只算今天零点之后；本月从 1 号零点起', async () => {
    await store.insert(
      run({ model: 'm-today', input: 10, output: 1, at: new Date(2026, 9, 15, 9, 0, 0) })
    )
    await store.insert(
      run({ model: 'm-yesterday', input: 20, output: 2, at: new Date(2026, 9, 14, 23, 0, 0) })
    )
    await store.insert(
      run({ model: 'm-month-start', input: 30, output: 3, at: new Date(2026, 9, 1, 0, 0, 0) })
    )
    await store.insert(
      run({ model: 'm-last-month', input: 40, output: 4, at: new Date(2026, 8, 30, 23, 59, 0) })
    )

    const today = await get('today')
    expect(today.range).toBe('today')
    expect(today.tokens).toEqual({ input: 10, output: 1, total: 11 })
    expect(today.byModel.map((row) => row.model)).toEqual(['m-today'])

    const month = await get('month')
    expect(month.range).toBe('month')
    expect(month.tokens).toEqual({ input: 60, output: 6, total: 66 })
    expect(month.byModel.map((row) => row.model)).toEqual([
      'm-month-start',
      'm-yesterday',
      'm-today'
    ])
  })

  it('脏 range → 400', async () => {
    const response = await app.request('/api/usage?range=nope')
    expect(response.status).toBe(400)
  })

  it('上下文接口（round 18）：无记录 → 全 null；有记录 → 首轮基线 / 最近一轮 / 今日缓存合计', async () => {
    // 空会话：环停在空态（不假装 0）——thread 维度全 null；today 合计是共享库的累计值，
    // 这里只对 thread 维度做全等断言（不受前面用例插入的行影响）
    const empty = await app.request('/api/usage/context?threadId=thread-x')
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({
      threadId: 'thread-x',
      lastInput: null,
      lastCachedInput: null,
      baselineInput: null
    })

    // 同一条会话两轮：首轮 100（当基线）、末轮 400/命中 300；另一条会话不进基线
    await store.insert(
      run({
        model: 'm',
        threadId: 'thread-x',
        input: 100,
        output: 5,
        at: new Date(2026, 9, 15, 9, 0, 0)
      })
    )
    await store.insert(
      run({
        model: 'm',
        threadId: 'other',
        input: 50,
        output: 5,
        at: new Date(2026, 9, 15, 9, 30, 0)
      })
    )
    await store.insert(
      run({
        model: 'm',
        threadId: 'thread-x',
        input: 400,
        output: 5,
        cachedInput: 300,
        at: new Date(2026, 9, 15, 10, 0, 0)
      })
    )

    const context = await app.request('/api/usage/context?threadId=thread-x')
    expect(context.status).toBe(200)
    // 今日合计 = 本用例两条（100 + 400）+ 前面用例今天插入的 m-today(10) 与 other(50)
    expect(await context.json()).toEqual({
      threadId: 'thread-x',
      lastInput: 400,
      lastCachedInput: 300,
      baselineInput: 100,
      todayInput: 560,
      todayCachedInput: 300
    })
  })

  it('上下文接口：threadId 缺失 / 空白 → 400', async () => {
    expect((await app.request('/api/usage/context')).status).toBe(400)
    expect((await app.request('/api/usage/context?threadId=%20')).status).toBe(400)
  })
})

describe('记账钩子（真服务：一轮对话 → usage_runs → /api/usage）', () => {
  let dir: string
  let server: AgentServerHandle
  let currentModel: KyclawModel

  function mock(provider: string, modelId: string): KyclawModel {
    return new MockLanguageModelV4({
      provider,
      modelId,
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: textScript('好。'),
          initialDelayInMs: 0,
          chunkDelayInMs: 0
        })
      })
    })
  }

  async function chat(threadId: string, text: string): Promise<void> {
    const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({
        messages: [{ id: `u-${threadId}`, role: 'user', parts: [{ type: 'text', text }] }],
        ...threadMemoryBody(threadId)
      })
    })
    expect(response.status).toBe(200)
    await response.text()
  }

  async function usage(range: 'today' | 'month'): Promise<UsageResponse> {
    const response = await fetch(`${server.baseUrl}/api/usage?range=${range}`, {
      headers: { authorization: `Bearer ${server.token}` }
    })
    expect(response.status).toBe(200)
    return usageResponseSchema.parse(await response.json())
  }

  /** 记账发生在流收尾处：等到窗口里的行数到齐再断言（最多等 5s） */
  async function waitForRuns(expected: number): Promise<UsageResponse> {
    const deadline = Date.now() + 5000
    let last = await usage('today')
    while (runCount(last) < expected && Date.now() < deadline) {
      await sleep(50)
      last = await usage('today')
    }
    return last
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-usage-'))
    currentModel = mock('deepseek', 'deepseek-flash')
    server = await startAgentServer({
      dataDir: dir,
      resolveModel: async () => currentModel
    })
  }, 60_000)

  afterAll(async () => {
    await server?.stop()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
    }
  })

  it('已知模型：token 从 chat 流进表，花费按价目算出来', async () => {
    await chat('thread-usage-known', '你好')
    const today = await waitForRuns(1)

    expect(today.tokens).toEqual({ input: 1, output: 3, total: 4 })
    expect(today.costIncomplete).toBe(false)
    expect(today.cost).toBeCloseTo(
      computeCost(MODEL_PRICING['deepseek-flash'], { input: 1, output: 3 }),
      12
    )
    expect(today.byModel).toHaveLength(1)
    expect(today.byModel[0]).toMatchObject({
      model: 'deepseek-flash',
      provider: 'deepseek',
      runs: 1,
      tokens: { input: 1, output: 3, total: 4 }
    })
    expect(today.byModel[0]?.cost).toBeGreaterThan(0)
    // 本地日历的窗口口径：同一批行在"本月"里也应当出现（今天 ⊂ 本月）
    expect((await usage('month')).tokens).toEqual(today.tokens)

    // round 18：这一轮**按会话记上了**（threadId 从 onFinish 事件的 dbMessages 取）——
    // 上下文环的数据面就靠这条：无 thread_id 时 lastInput 会是 null
    const contextResponse = await fetch(
      `${server.baseUrl}/api/usage/context?threadId=thread-usage-known`,
      { headers: { authorization: `Bearer ${server.token}` } }
    )
    expect(contextResponse.status).toBe(200)
    expect(await contextResponse.json()).toMatchObject({
      threadId: 'thread-usage-known',
      lastInput: 1,
      baselineInput: 1
    })
  }, 30_000)

  it('未知模型：只记 token，cost=null、costIncomplete=true（不把未知当 0）', async () => {
    currentModel = mock('kyclaw-test', 'kyclaw-test-mock')
    await chat('thread-usage-unknown', '再问一句')
    const today = await waitForRuns(2)

    expect(today.tokens).toEqual({ input: 2, output: 6, total: 8 })
    expect(today.costIncomplete).toBe(true)
    const unknown = today.byModel.find((row) => row.model === 'kyclaw-test-mock')
    expect(unknown).toMatchObject({
      provider: 'kyclaw-test',
      runs: 1,
      tokens: { input: 1, output: 3, total: 4 },
      cost: null
    })
    // 已知模型那一行照常计价
    expect(today.byModel.find((row) => row.model === 'deepseek-flash')?.cost).toBeGreaterThan(0)
  }, 30_000)
})
