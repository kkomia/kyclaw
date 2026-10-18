// @vitest-environment node
/**
 * T14 Step 2：用量记账。
 *
 * 两层：
 *   1. 聚合与窗口（纯函数）：统计窗口的边界（今天 = 本地零点起；本月 = 本地 1 号零点起）、
 *      按模型分组的 token 汇总；
 *   2. 真服务集成（startAgentServer：chat 路由 v7 + libsql + Memory + usage 表）：
 *      一轮对话的 usage 从 chat 流里被记账钩子提取 → 写进 libsql 的 `usage_runs` →
 *      `GET /api/usage` 能按模型看到 token（**没有计费口径**：回包里没有 cost 一类字段）。
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
import { usageCalendarSchema, usageResponseSchema, type UsageResponse } from '../../shared/usage'
import { threadMemoryBody } from '../../shared/threads'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import type { KyclawModel } from '../model'
import { createUsageRouter } from '../routes/usage'
import {
  createUsageRecorder,
  createUsageStore,
  rangeStart,
  summarizeCalendar,
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
    createdAt: (overrides.at ?? new Date()).toISOString()
  }
}

/** 从行列表算窗口内的运行总数（断言"记了几行"用） */
function runCount(usage: UsageResponse): number {
  return usage.byModel.reduce((sum, row) => sum + row.runs, 0)
}

/** task-107：请求快照摘要（composition 拆分只读 system_chars / tools_chars） */
function snapshotSummary(overrides: {
  systemChars: number | null
  toolsChars: number | null
}): Record<string, unknown> {
  return {
    id: `snap-${Math.random().toString(36).slice(2)}`,
    runId: null,
    threadId: 'thread-compose',
    step: null,
    status: 'complete',
    error: null,
    model: 'm',
    provider: null,
    messageCount: null,
    toolCount: null,
    systemChars: overrides.systemChars,
    toolsChars: overrides.toolsChars,
    truncated: false,
    createdAt: new Date(2026, 9, 15, 9, 0, 0).toISOString()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('窗口与聚合（纯函数）', () => {
  it('窗口边界：今天 = 本地零点起；本月 = 本地 1 号零点起', () => {
    const now = new Date(2026, 9, 15, 13, 45, 30) // 2026-10-15 13:45:30（本地）
    expect(rangeStart('today', now).getTime()).toBe(new Date(2026, 9, 15, 0, 0, 0, 0).getTime())
    expect(rangeStart('month', now).getTime()).toBe(new Date(2026, 9, 1, 0, 0, 0, 0).getTime())
  })

  it('汇总：按模型分组（token 降序）、同 provider+model 合并；不认识的模型照记 token', () => {
    const rows: UsageRun[] = [
      run({ model: 'a-known', provider: 'p', input: 100, output: 50 }),
      run({ model: 'a-known', provider: 'p', input: 30, output: 10 }),
      run({ model: 'b-unknown', provider: null, input: 7, output: 3 })
    ]

    const summary = summarizeUsage(rows, 'today')
    expect(summary.tokens).toEqual({ input: 137, output: 63, total: 200 })
    expect(summary.byModel.map((row) => [row.model, row.runs])).toEqual([
      ['a-known', 2],
      ['b-unknown', 1]
    ])
    expect(summary.byModel[0]?.tokens).toEqual({ input: 130, output: 60, total: 190 })
  })

  it('汇总边界：空列表 = 全 0 且 byModel 空', () => {
    expect(summarizeUsage([], 'today')).toMatchObject({
      tokens: { input: 0, output: 0, total: 0 },
      byModel: []
    })
    expect(summarizeUsage([run({ model: 'x' })], 'today').byModel).toHaveLength(1)
  })

  it('014：汇总结果里没有计费口径（cost / costIncomplete / 币种都不回了）', () => {
    const summary = summarizeUsage(
      [run({ model: 'deepseek-flash', provider: 'deepseek', input: 10, output: 1 })],
      'today'
    )
    // 负向守卫：这三个字段是**故意删掉**的（用户口径 014 不做计费），别顺手加回来
    expect(Object.keys(summary).sort()).toEqual(['byModel', 'range', 'tokens'])
    expect(summary).not.toHaveProperty('cost')
    expect(summary).not.toHaveProperty('costIncomplete')
    expect(summary).not.toHaveProperty('currency')
    expect(Object.keys(summary.byModel[0] ?? {}).sort()).toEqual([
      'model',
      'provider',
      'runs',
      'tokens'
    ])
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
      // AI SDK 的 totalUsage = 全部 step 之和（整轮合计口径）
      totalUsage: {
        inputTokens: 221_356,
        outputTokens: 3_928,
        totalTokens: 225_284,
        cachedInputTokens: 194_944
      },
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

  it('空窗口：全 0、byModel 空；回包不带计费字段', async () => {
    const raw = await app.request('/api/usage?range=today')
    expect(raw.status).toBe(200)
    // 负向守卫：/api/usage 的回包里**没有** cost / costIncomplete / currency（014 不做计费）
    expect(Object.keys((await raw.json()) as object).sort()).toEqual(['byModel', 'range', 'tokens'])

    expect(await get('today')).toMatchObject({
      range: 'today',
      tokens: { input: 0, output: 0, total: 0 },
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
      todayCachedInput: 300,
      // task-107：全会话合计（两条 run：input 100+400 / cached 300 / output 5+5）
      totals: {
        rounds: 2,
        modelCalls: 2,
        input: 500,
        cachedInput: 300,
        uncachedInput: 200,
        output: 10,
        hitRate: 60
      },
      // 没注入请求快照 → 不拆（UI 合并一行，不编两个数）
      composition: null
    })
  })

  it('task-107：totals 聚合 = 整轮合计 + Σ stepCount，命中率 = Σcached/Σinput', async () => {
    await store.insert(
      run({
        model: 'm',
        threadId: 'thread-aggr',
        input: 200,
        output: 10,
        cachedInput: 100,
        stepCount: 3,
        at: new Date(2026, 9, 15, 9, 0, 0)
      })
    )
    await store.insert(
      run({
        model: 'm',
        threadId: 'thread-aggr',
        input: 300,
        output: 20,
        cachedInput: 150,
        stepCount: 2,
        at: new Date(2026, 9, 15, 10, 0, 0)
      })
    )

    const response = await app.request('/api/usage/context?threadId=thread-aggr')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      totals: Record<string, number | null>
    }
    expect(body.totals).toEqual({
      rounds: 2,
      modelCalls: 5,
      input: 500,
      cachedInput: 250,
      uncachedInput: 250,
      output: 30,
      hitRate: 50
    })
  })

  it('task-107：composition 用首份请求快照的 system/tools 字符占比拆 baseline（~估算）', async () => {
    await store.insert(
      run({
        model: 'm',
        threadId: 'thread-compose',
        input: 300,
        output: 10,
        contextInput: 1000,
        at: new Date(2026, 9, 15, 9, 0, 0)
      })
    )
    const snapshots = {
      listByThread: async (): Promise<unknown[]> => [
        snapshotSummary({ systemChars: 300, toolsChars: 100 }),
        snapshotSummary({ systemChars: 900, toolsChars: 900 })
      ]
    }
    const appWithSnapshots = new Hono().route(
      '/api/usage',
      createUsageRouter({
        store,
        now: () => NOW,
        snapshots: snapshots as never
      })
    )

    const response = await appWithSnapshots.request('/api/usage/context?threadId=thread-compose')
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      composition: { systemPrompt: number; toolDefinitions: number } | null
    }
    // 首份快照 300:100 → baseline 1000 拆成 750 / 250（只认第一份，后续快照不参与）
    expect(body.composition).toEqual({ systemPrompt: 750, toolDefinitions: 250 })
  })

  it('task-107：快照表读失败 → composition null（不拖垮用量路由）', async () => {
    await store.insert(
      run({
        model: 'm',
        threadId: 'thread-compose-fail',
        input: 300,
        output: 10,
        contextInput: 1000,
        at: new Date(2026, 9, 15, 9, 0, 0)
      })
    )
    const brokenSnapshots = {
      listByThread: async (): Promise<unknown[]> => {
        throw new Error('snapshot store down')
      }
    }
    const appWithSnapshots = new Hono().route(
      '/api/usage',
      createUsageRouter({
        store,
        now: () => NOW,
        snapshots: brokenSnapshots as never
      })
    )

    const response = await appWithSnapshots.request(
      '/api/usage/context?threadId=thread-compose-fail'
    )
    expect(response.status).toBe(200)
    const body = (await response.json()) as { composition: unknown }
    expect(body.composition).toBeNull()
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

  it('已知模型：token 从 chat 流进表（记账只记 token，不算钱）', async () => {
    await chat('thread-usage-known', '你好')
    const today = await waitForRuns(1)

    expect(today.tokens).toEqual({ input: 1, output: 3, total: 4 })
    expect(today.byModel).toHaveLength(1)
    expect(today.byModel[0]).toMatchObject({
      model: 'deepseek-flash',
      provider: 'deepseek',
      runs: 1,
      tokens: { input: 1, output: 3, total: 4 }
    })
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

  it('未知模型：token 照记、按模型各占一行（计价口径已删，不再区分"认不认识"）', async () => {
    currentModel = mock('kyclaw-test', 'kyclaw-test-mock')
    await chat('thread-usage-unknown', '再问一句')
    const today = await waitForRuns(2)

    expect(today.tokens).toEqual({ input: 2, output: 6, total: 8 })
    const unknown = today.byModel.find((row) => row.model === 'kyclaw-test-mock')
    expect(unknown).toMatchObject({
      provider: 'kyclaw-test',
      runs: 1,
      tokens: { input: 1, output: 3, total: 4 }
    })
    // 已知模型那一行照常在列
    expect(today.byModel.find((row) => row.model === 'deepseek-flash')?.runs).toBe(1)
  }, 30_000)
})

/**
 * 014（不做计费）的兼容面：老库的 `usage_runs` 有 `cost` 列，而且**真有值**（T14 时代记过按价目表
 * 算出来的花费）。这一轮不能把老库读炸、也不能动老数据 —— 只在写入侧固定写 NULL、读取侧不映射它。
 *
 * 这里按**老形状**造库：连 round 18 / 67 补的列都没有（`ensureTable` 该把它们补上），cost 有值。
 */
describe('014 兼容：老库（带 cost 值）照样读写', () => {
  let dir: string
  let storage: LibSQLStore

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kyclaw-usage-legacy-'))
    storage = new LibSQLStore({
      id: 'kyclaw-usage-legacy',
      url: `file:${join(dir, 'kyclaw.db').replace(/\\/g, '/')}`
    })
  })

  afterAll(async () => {
    await storage?.close()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
    }
  })

  it('老形状（cost 有值、缺 round 18/67 那几列）：token 照读，新行 cost 写 NULL，老值不动', async () => {
    const client = usageSqlClient(storage)
    await client.execute(
      `CREATE TABLE "usage_runs" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT,
        "model" TEXT NOT NULL,
        "provider" TEXT,
        "input_tokens" INTEGER NOT NULL DEFAULT 0,
        "output_tokens" INTEGER NOT NULL DEFAULT 0,
        "total_tokens" INTEGER NOT NULL DEFAULT 0,
        "cached_input_tokens" INTEGER,
        "cost" REAL,
        "created_at" TEXT NOT NULL
      )`
    )
    await client.execute({
      sql: `INSERT INTO "usage_runs"
        ("id", "run_id", "model", "provider", "input_tokens", "output_tokens", "total_tokens", "cached_input_tokens", "cost", "created_at")
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        'legacy-1',
        'run-1',
        'legacy-model',
        'deepseek',
        100,
        20,
        120,
        50,
        0.0123,
        '2026-10-15T09:00:00.000Z'
      ]
    })

    const store = createUsageStore(client)
    // 建表幂等 + 补列都在这一句里跑（老库少的那几列补上，cost 列原样留着）
    const rows = await store.listSince(new Date('2026-10-14T00:00:00.000Z'))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: 'legacy-1',
      model: 'legacy-model',
      provider: 'deepseek',
      tokens: { input: 100, output: 20, total: 120 },
      cachedInput: 50
    })
    // 读回来的行里没有计费口径（usage.ts 已经没有这个概念）
    expect(rows[0]).not.toHaveProperty('cost')

    // 再写一行新记录：老行的历史值原样留着，新行的 cost 是 NULL（"没记"比 0 诚实）
    await store.insert(
      run({ model: 'new-model', input: 1, output: 1, at: new Date('2026-10-15T10:00:00.000Z') })
    )
    const costs = await client.execute(
      `SELECT "model", "cost" FROM "usage_runs" ORDER BY "created_at" ASC`
    )
    expect(costs.rows.map((row) => [row.model, row.cost])).toEqual([
      ['legacy-model', 0.0123],
      ['new-model', null]
    ])
  })
})

describe('task-127 日历聚合：本地日 / 跨年 / 空', () => {
  it('空年：days 空、totalActiveDays/totalTokens 0（不造零值天）', () => {
    expect(summarizeCalendar([], 2026)).toEqual({
      year: 2026,
      days: [],
      totalActiveDays: 0,
      totalTokens: 0
    })
  })

  it('同一天多轮合并 input/output/cached/runs/steps；无 stepCount 按 1 记（下界）', () => {
    const result = summarizeCalendar(
      [
        run({
          model: 'm',
          input: 10,
          output: 1,
          cachedInput: 4,
          stepCount: 2,
          at: new Date(2026, 0, 2, 9, 0, 0)
        }),
        run({
          model: 'm',
          input: 5,
          output: 1,
          cachedInput: 0,
          stepCount: null,
          at: new Date(2026, 0, 2, 14, 0, 0)
        })
      ],
      2026
    )
    expect(result.days).toEqual([
      { date: '2026-01-02', input: 15, output: 2, cachedInput: 4, runs: 2, steps: 3 }
    ])
    expect(result.totalActiveDays).toBe(1)
    expect(result.totalTokens).toBe(17)
  })

  it('跨年边界按本地日历切：12-31 23:59 归上年、01-01 00:00 归当年；非法 createdAt 跳过', () => {
    const lastYear = summarizeCalendar(
      [
        run({ model: 'm', input: 1, output: 1, at: new Date(2025, 11, 31, 23, 59, 59) }),
        run({ model: 'm', input: 100, output: 100, at: new Date(2026, 0, 1, 0, 0, 0) }),
        run({ model: 'm', input: 200, output: 200, at: new Date(2027, 0, 1, 0, 0, 0) })
      ],
      2025
    )
    expect(lastYear.days.map((day) => day.date)).toEqual(['2025-12-31'])
    expect(lastYear.totalTokens).toBe(2)

    const thisYear = summarizeCalendar(
      [
        run({ model: 'm', input: 1, output: 1, at: new Date(2025, 11, 31, 23, 59, 59) }),
        run({ model: 'm', input: 100, output: 100, at: new Date(2026, 0, 1, 0, 0, 0) }),
        { ...run({ model: 'm', input: 1, output: 1 }), createdAt: 'not-a-date' }
      ],
      2026
    )
    expect(thisYear.days.map((day) => day.date)).toEqual(['2026-01-01'])
    expect(thisYear.totalTokens).toBe(200)
  })
})

describe('task-127 /api/usage/calendar 路由（注入 now + 假 store）', () => {
  const NOW = new Date(2026, 9, 15, 12, 0, 0)
  const rows = [
    run({
      model: 'm',
      input: 10,
      output: 1,
      cachedInput: 4,
      stepCount: 2,
      at: new Date(2026, 0, 2, 9, 0, 0)
    }),
    run({ model: 'm', input: 5, output: 1, stepCount: null, at: new Date(2026, 0, 2, 14, 0, 0) }),
    run({ model: 'm', input: 100, output: 10, at: new Date(2025, 11, 31, 23, 59, 59) }),
    run({ model: 'm', input: 200, output: 20, at: new Date(2027, 0, 1, 0, 0, 0) })
  ]
  const store = {
    ensureTable: async () => undefined,
    insert: async () => undefined,
    listSince: async () => rows,
    listByThread: async () => rows
  } as unknown as UsageStore
  const app = new Hono().route('/api/usage', createUsageRouter({ store, now: () => NOW }))

  it('year=2026：只回当年有记录的天（升序）+ 合计；严格 schema 可解析', async () => {
    const response = await app.request('/api/usage/calendar?year=2026')
    expect(response.status).toBe(200)
    const body = usageCalendarSchema.parse(await response.json())
    expect(body).toEqual({
      year: 2026,
      days: [{ date: '2026-01-02', input: 15, output: 2, cachedInput: 4, runs: 2, steps: 3 }],
      totalActiveDays: 1,
      totalTokens: 17
    })
  })

  it('不传 year 走当前本地年（注入 now 2026）', async () => {
    const response = await app.request('/api/usage/calendar')
    expect(response.status).toBe(200)
    expect((await response.json()) as { year: number }).toMatchObject({ year: 2026 })
  })

  it('空年：200 + 空数组（不报错、不造数）', async () => {
    const response = await app.request('/api/usage/calendar?year=2024')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      year: 2024,
      days: [],
      totalActiveDays: 0,
      totalTokens: 0
    })
  })

  it('脏 year（非整数 / 越界 / 空串）→ 400', async () => {
    for (const raw of ['nope', '1999', '2101', '2026.5', '']) {
      const response = await app.request(`/api/usage/calendar?year=${raw}`)
      expect(response.status, raw).toBe(400)
    }
  })
})
