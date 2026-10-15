// @vitest-environment node
/**
 * 轨迹的两条数据面：
 *   - 用量：`GET /api/usage/thread`（该会话逐轮的记账行）；
 *   - 请求：`GET /api/trajectory/requests`（逐次模型请求的摘要）与
 *     `GET /api/trajectory/requests/detail?id=`（一次请求的正文）。
 *
 * 钉住四条：
 *   1. 行形状（含 round 67 那三个"上下文大小 / 调用次数"字段；老库没有列 → null，不是 0）；
 *   2. 入参纪律（缺 threadId / id = 400，不静默回空表）；
 *   3. round 87（用户反馈 017）：读表抛出 → **500 + `{ error: 人话 }`**，不是裸 500
 *      —— 渲染端要靠这句人话显示"为什么没取到"；
 *   4. round 87（用户反馈 017）：**两条面互不牵连** —— 用量那条坏掉时请求面照常出
 *      （独立路由、独立读口；这是"轨迹不该被用量带走"的负向守卫）。
 * 不碰真库：`UsageStore` / `RequestSnapshotStore` 是接口，这里给最窄的假实现。
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  trajectoryRequestDetailResponseSchema,
  trajectoryThreadRequestsResponseSchema,
  trajectoryThreadUsageResponseSchema
} from '../../shared/trajectory'
import { createTrajectoryRouter } from '../routes/trajectory'
import { createUsageRouter } from '../routes/usage'
import type { RequestSnapshot, RequestSnapshotStore, RequestSnapshotSummary } from '../request-log'
import type { UsageRun, UsageStore } from '../usage'

const THREAD = 'thread-1'

function run(overrides: Partial<UsageRun> = {}): UsageRun {
  return {
    id: 'r1',
    runId: 'run-1',
    threadId: THREAD,
    model: 'deepseek-flash',
    provider: 'deepseek.chat',
    tokens: { input: 1234, output: 56, total: 1290 },
    cachedInput: 1000,
    contextInput: 4200,
    contextCachedInput: 3900,
    stepCount: 2,
    createdAt: '2026-10-13T06:24:16.797Z',
    ...overrides
  }
}

function summary(overrides: Partial<RequestSnapshotSummary> = {}): RequestSnapshotSummary {
  return {
    id: 's1',
    runId: 'run-1',
    threadId: THREAD,
    step: 0,
    status: 'complete',
    error: null,
    model: 'deepseek-flash',
    provider: 'deepseek.chat',
    messageCount: 3,
    toolCount: 35,
    systemChars: 14000,
    toolsChars: 81000,
    truncated: false,
    createdAt: '2026-10-13T06:24:16.797Z',
    ...overrides
  }
}

function detail(overrides: Partial<RequestSnapshot> = {}): RequestSnapshot {
  return {
    ...summary(),
    system: '你是 kyclaw。',
    tools: '[\n  {\n    "type": "function"\n  }\n]',
    messages: [{ role: 'user', text: '你好', chars: 2, truncated: false }],
    ...overrides
  }
}

function storeOf(rows: UsageRun[]): UsageStore {
  return {
    ensureTable: async () => undefined,
    insert: async () => undefined,
    listSince: async () => [],
    listByThread: async (threadId) => rows.filter((row) => row.threadId === threadId)
  }
}

/** 快照行 → 摘要（列表不带正文，长度按正文算） */
function summaryOf(row: RequestSnapshot): RequestSnapshotSummary {
  return {
    id: row.id,
    runId: row.runId,
    threadId: row.threadId,
    step: row.step,
    status: row.status,
    error: row.error,
    model: row.model,
    provider: row.provider,
    messageCount: row.messageCount,
    toolCount: row.toolCount,
    systemChars: row.system === null ? null : row.system.length,
    toolsChars: row.tools === null ? null : row.tools.length,
    truncated: row.truncated,
    createdAt: row.createdAt
  }
}

/** 假快照 store：`listByThread` 回摘要、`detail` 按 id 找（找不到 = null） */
function snapshotStoreOf(rows: RequestSnapshot[]): RequestSnapshotStore {
  return {
    ensureTable: async () => undefined,
    insert: async () => undefined,
    listByThread: async (threadId) =>
      rows.filter((row) => row.threadId === threadId).map(summaryOf),
    detail: async (id) => rows.find((row) => row.id === id) ?? null
  }
}

function usageApp(rows: UsageRun[]): Hono {
  return new Hono().route('/api/usage', createUsageRouter({ store: storeOf(rows) }))
}

function trajectoryApp(rows: RequestSnapshot[] = []): Hono {
  return new Hono().route(
    '/api/trajectory',
    createTrajectoryRouter({ snapshots: snapshotStoreOf(rows) })
  )
}

describe('GET /api/usage/thread', () => {
  it('回该会话的逐轮账（时间升序由 store 保证），字段逐个对上', async () => {
    const response = await usageApp([
      run(),
      run({ id: 'r2', runId: null, createdAt: '2026-10-13T07:00:00.000Z' })
    ]).request(`/api/usage/thread?threadId=${THREAD}`)

    expect(response.status).toBe(200)
    const parsed = trajectoryThreadUsageResponseSchema.parse(await response.json())

    expect(parsed.threadId).toBe(THREAD)
    expect(parsed.runs).toHaveLength(2)
    expect(parsed.runs[0]).toEqual({
      id: 'r1',
      runId: 'run-1',
      model: 'deepseek-flash',
      provider: 'deepseek.chat',
      input: 1234,
      output: 56,
      total: 1290,
      cachedInput: 1000,
      contextInput: 4200,
      contextCachedInput: 3900,
      stepCount: 2,
      createdAt: '2026-10-13T06:24:16.797Z'
    })
  })

  it('014：逐轮账里没有计费字段', async () => {
    const response = await usageApp([run()]).request(`/api/usage/thread?threadId=${THREAD}`)
    const body = (await response.json()) as { runs: Array<Record<string, unknown>> }

    // 负向守卫：`cost`（与任何币种字段）是**故意删掉**的（用户口径 014 不做计费），别顺手加回来
    expect(Object.keys(body.runs[0] ?? {}).sort()).toEqual([
      'cachedInput',
      'contextCachedInput',
      'contextInput',
      'createdAt',
      'id',
      'input',
      'model',
      'output',
      'provider',
      'runId',
      'stepCount',
      'total'
    ])
  })

  it('老库还没有 round 67 那几列：读出来是 null（不拿 undefined 当 0）', async () => {
    const legacy = run()
    delete (legacy as Partial<UsageRun>).contextInput
    delete (legacy as Partial<UsageRun>).contextCachedInput
    delete (legacy as Partial<UsageRun>).stepCount

    const response = await usageApp([legacy]).request(`/api/usage/thread?threadId=${THREAD}`)
    const parsed = trajectoryThreadUsageResponseSchema.parse(await response.json())

    expect(parsed.runs[0]?.contextInput).toBeNull()
    expect(parsed.runs[0]?.contextCachedInput).toBeNull()
    expect(parsed.runs[0]?.stepCount).toBeNull()
    // 整轮合计那三个字段照旧在
    expect(parsed.runs[0]?.input).toBe(1234)
  })

  it('别的会话的账不会串进来；没记过账的会话回空数组', async () => {
    const app = usageApp([run(), run({ id: 'other', threadId: 'thread-2' })])

    const mine = trajectoryThreadUsageResponseSchema.parse(
      await (await app.request(`/api/usage/thread?threadId=${THREAD}`)).json()
    )
    expect(mine.runs.map((entry) => entry.id)).toEqual(['r1'])

    const empty = trajectoryThreadUsageResponseSchema.parse(
      await (await app.request('/api/usage/thread?threadId=none')).json()
    )
    expect(empty.runs).toEqual([])
  })

  it('缺 threadId = 400（不静默回空表）', async () => {
    const response = await usageApp([run()]).request('/api/usage/thread')

    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toContain('threadId')
  })

  it('round 87 / 017：读表抛出 → 500 + 人话（不是裸 500，也不是空表）', async () => {
    const app = new Hono()
    app.route(
      '/api/usage',
      createUsageRouter({
        store: {
          ...storeOf([]),
          listByThread: async () => {
            throw new Error('usage_runs 表锁住了')
          }
        }
      })
    )

    const response = await app.request(`/api/usage/thread?threadId=${THREAD}`)

    expect(response.status).toBe(500)
    const body = (await response.json()) as { error?: unknown }
    // 人话里带原因（渲染端把这一段原样显示给用户）
    expect(body.error).toBe('读取失败：usage_runs 表锁住了')
  })
})

describe('GET /api/trajectory/requests', () => {
  it('回该会话的逐次请求摘要（时间升序由 store 保证），字段逐个对上', async () => {
    const app = trajectoryApp([
      detail(),
      detail({ id: 's2', runId: null, step: 1, status: 'error', error: 'Bad Request' })
    ])
    const response = await app.request(`/api/trajectory/requests?threadId=${THREAD}`)

    expect(response.status).toBe(200)
    const parsed = trajectoryThreadRequestsResponseSchema.parse(await response.json())

    expect(parsed.threadId).toBe(THREAD)
    expect(parsed.requests).toHaveLength(2)
    expect(parsed.requests[0]).toEqual({
      id: 's1',
      runId: 'run-1',
      step: 0,
      status: 'complete',
      error: null,
      model: 'deepseek-flash',
      provider: 'deepseek.chat',
      messageCount: 3,
      toolCount: 35,
      systemChars: 10,
      toolsChars: 34,
      truncated: false,
      createdAt: '2026-10-13T06:24:16.797Z'
    })
    // 失败的那次照实带 status/error（正文未知）
    expect(parsed.requests[1]).toMatchObject({ status: 'error', error: 'Bad Request', runId: null })
    // 列表**不带正文**（正文按 id 取；一条请求实测 ~96 KB）
    expect(Object.keys(parsed.requests[0] ?? {})).not.toContain('system')
    expect(Object.keys(parsed.requests[0] ?? {})).not.toContain('messages')
  })

  it('别的会话的请求不会串进来；没记过的会话回空数组（是事实不是错误）', async () => {
    const app = trajectoryApp([detail(), detail({ id: 'other', threadId: 'thread-2' })])

    const mine = trajectoryThreadRequestsResponseSchema.parse(
      await (await app.request(`/api/trajectory/requests?threadId=${THREAD}`)).json()
    )
    expect(mine.requests.map((entry) => entry.id)).toEqual(['s1'])

    const empty = trajectoryThreadRequestsResponseSchema.parse(
      await (await app.request('/api/trajectory/requests?threadId=none')).json()
    )
    expect(empty.requests).toEqual([])
  })

  it('缺 threadId = 400；读表抛出 → 500 + 人话', async () => {
    const app = trajectoryApp([detail()])
    const missing = await app.request('/api/trajectory/requests')
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { error: string }).error).toContain('threadId')

    const broken = new Hono()
    broken.route(
      '/api/trajectory',
      createTrajectoryRouter({
        snapshots: {
          ...snapshotStoreOf([]),
          listByThread: async () => {
            throw new Error('快照表坏了')
          }
        }
      })
    )
    const response = await broken.request(`/api/trajectory/requests?threadId=${THREAD}`)
    expect(response.status).toBe(500)
    expect(((await response.json()) as { error: string }).error).toContain('快照表坏了')
  })

  it('017 负向守卫：**用量那条面坏掉，请求面照常出**（两条路互不牵连）', async () => {
    const usageBroken = new Hono()
    usageBroken.route(
      '/api/usage',
      createUsageRouter({
        store: {
          ...storeOf([]),
          listByThread: async () => {
            throw new Error('usage_runs 表锁住了')
          }
        }
      })
    )
    expect((await usageBroken.request(`/api/usage/thread?threadId=${THREAD}`)).status).toBe(500)

    // 请求面用的是另一个 store（另一张表、另一条路由）：用量坏掉不影响它
    const response = await trajectoryApp([detail()]).request(
      `/api/trajectory/requests?threadId=${THREAD}`
    )
    expect(response.status).toBe(200)
    const parsed = trajectoryThreadRequestsResponseSchema.parse(await response.json())
    expect(parsed.requests.map((entry) => entry.id)).toEqual(['s1'])
  })
})

describe('GET /api/trajectory/requests/detail', () => {
  it('回一次请求的完整正文（系统指令 / 工具表 / 消息清单）', async () => {
    const app = trajectoryApp([detail()])
    const response = await app.request('/api/trajectory/requests/detail?id=s1')

    expect(response.status).toBe(200)
    const parsed = trajectoryRequestDetailResponseSchema.parse(await response.json())
    expect(parsed.request.system).toBe('你是 kyclaw。')
    expect(parsed.request.tools).toContain('"type": "function"')
    expect(parsed.request.messages).toEqual([
      { role: 'user', text: '你好', chars: 2, truncated: false }
    ])
  })

  it('缺 id = 400；没这条记录 = 404 + 人话；读表抛出 = 500 + 人话', async () => {
    const app = trajectoryApp([detail()])

    const missing = await app.request('/api/trajectory/requests/detail')
    expect(missing.status).toBe(400)
    expect(((await missing.json()) as { error: string }).error).toContain('id')

    const notFound = await app.request('/api/trajectory/requests/detail?id=nope')
    expect(notFound.status).toBe(404)
    expect(((await notFound.json()) as { error: string }).error).toContain('没有这条请求记录')

    const broken = new Hono()
    broken.route(
      '/api/trajectory',
      createTrajectoryRouter({
        snapshots: {
          ...snapshotStoreOf([]),
          detail: async () => {
            throw new Error('快照表坏了')
          }
        }
      })
    )
    const response = await broken.request('/api/trajectory/requests/detail?id=s1')
    expect(response.status).toBe(500)
    expect(((await response.json()) as { error: string }).error).toBe('读取失败：快照表坏了')
  })
})
