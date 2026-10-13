// @vitest-environment node
/**
 * 轨迹的用量面（GET /api/usage/thread）：该会话逐轮的记账行。
 *
 * 钉住两条：
 *   1. 行形状（含 round 67 那三个"上下文大小 / 调用次数"字段；老库没有列 → null，不是 0）；
 *   2. 入参纪律（缺 threadId = 400，不静默回空表）。
 * 不碰真库：`UsageStore` 是接口，这里给一份最窄的假实现（只实现路由用到的那两个方法）。
 */
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { trajectoryThreadUsageResponseSchema } from '../../shared/trajectory'
import { createUsageRouter } from '../routes/usage'
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
    cost: 0.0123,
    createdAt: '2026-10-13T06:24:16.797Z',
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

function appWith(rows: UsageRun[]): Hono {
  const app = new Hono()
  app.route('/api/usage', createUsageRouter({ store: storeOf(rows) }))
  return app
}

describe('GET /api/usage/thread', () => {
  it('回该会话的逐轮账（时间升序由 store 保证），字段逐个对上', async () => {
    const response = await appWith([
      run(),
      run({ id: 'r2', runId: null, createdAt: '2026-10-13T07:00:00.000Z', cost: null })
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
      cost: 0.0123,
      createdAt: '2026-10-13T06:24:16.797Z'
    })
    // 价目表不认识的模型：cost 是 null（不是 0）
    expect(parsed.runs[1]?.cost).toBeNull()
  })

  it('老库还没有 round 67 那几列：读出来是 null（不拿 undefined 当 0）', async () => {
    const legacy = run()
    delete (legacy as Partial<UsageRun>).contextInput
    delete (legacy as Partial<UsageRun>).contextCachedInput
    delete (legacy as Partial<UsageRun>).stepCount

    const response = await appWith([legacy]).request(`/api/usage/thread?threadId=${THREAD}`)
    const parsed = trajectoryThreadUsageResponseSchema.parse(await response.json())

    expect(parsed.runs[0]?.contextInput).toBeNull()
    expect(parsed.runs[0]?.contextCachedInput).toBeNull()
    expect(parsed.runs[0]?.stepCount).toBeNull()
    // 整轮合计那三个字段照旧在
    expect(parsed.runs[0]?.input).toBe(1234)
  })

  it('别的会话的账不会串进来；没记过账的会话回空数组', async () => {
    const app = appWith([run(), run({ id: 'other', threadId: 'thread-2' })])

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
    const response = await appWith([run()]).request('/api/usage/thread')

    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toContain('threadId')
  })
})
