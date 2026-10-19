// @vitest-environment node
/**
 * PB-039 阶段①+② 联调：**同一个 libsql 库 + 真实 HTTP 服务 + 同一 store 实例挂的模型工具**。
 *
 * 验收要的三件事：
 *   1. `POST/GET /api/goal` 真跑起来（Hono 子路由 + 真实端口，不是直接调 handler）；
 *   2. 模型工具（`get_goal` / `update_goal`）读写**同一份**状态：HTTP 建的 goal，工具立刻能看到；
 *      工具的改动，HTTP 立刻能读到；
 *   3. 另起一个 store 实例（同库）：goal **持久化**在，但 **activation 回到 disarmed**（不落库语义）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { expect, it } from 'vitest'
import { createKyclawMastra } from '../index'
import { createSessionGoalStore } from '../session-goal'
import { createGoalTools } from '../tools/goal'
import { createGoalRouter, GOAL_ROUTE_PREFIX } from '../routes/goal'
import type { GoalState } from '../../shared/goal'

it('goal：HTTP 路由与模型工具读写同一份状态（同库两个 store 实例）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-goal-int-'))
  // 本用例不跑对话，模型解析器不会被调用
  const handle = await createKyclawMastra({
    dataDir: dir,
    resolveModel: async () => ({}) as never
  })
  const app = new Hono()
  // 与生产 `service.ts` 同一挂载方式：`/api/goal` + 主进程 Hono app
  app.route(GOAL_ROUTE_PREFIX, createGoalRouter(handle.goals))
  const http = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>((resolve, reject) => {
    http.once('listening', resolve)
    http.once('error', reject)
  })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('test address unavailable')
  const baseUrl = `http://127.0.0.1:${address.port}`
  const request = (path: string, method = 'GET', body?: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  const tools = await createGoalTools(handle.goals)
  const human = { agent: { threadId: 't1' }, requestContext: {} }
  const execute = async (tool: unknown, input: unknown, context: unknown): Promise<string> => {
    const run = (tool as { execute?: (input: unknown, context?: unknown) => Promise<unknown> })
      .execute
    if (run === undefined) throw new Error('tool has no execute')
    return String(await run(input, context))
  }

  try {
    // ① 空态
    expect(await (await request('/api/goal?threadId=t1')).json()).toEqual({
      goal: null,
      activation: 'disarmed'
    })

    // ② HTTP 建 goal
    const createdResponse = await request('/api/goal', 'POST', {
      threadId: 't1',
      action: 'create',
      objective: '把迁移做完'
    })
    expect(createdResponse.status).toBe(200)
    const created = (await createdResponse.json()) as GoalState
    expect(created.goal).toMatchObject({ phase: 'active', revision: 1 })
    expect(created.activation).toBe('armed')

    // ③ 模型工具能看到 HTTP 建的那一个（同一个 store 实例）
    const seen = JSON.parse(await execute(tools.get_goal, {}, human)) as GoalState
    expect(seen.goal?.id).toBe(created.goal?.id)
    expect(seen.activation).toBe('armed')

    // ④ 工具改的，HTTP 立刻能读到
    const paused = JSON.parse(
      await execute(
        tools.update_goal,
        {
          goal_id: created.goal?.id,
          revision: created.goal?.revision,
          action: 'pause'
        },
        human
      )
    ) as GoalState
    expect(paused.goal?.phase).toBe('paused')
    const overHttp = (await (await request('/api/goal?threadId=t1')).json()) as GoalState
    expect(overHttp.goal).toMatchObject({ id: created.goal?.id, phase: 'paused', revision: 2 })
    expect(overHttp.activation).toBe('disarmed')

    // ⑤ HTTP 恢复（resume 归用户侧）
    const resumed = (await (
      await request('/api/goal', 'POST', {
        threadId: 't1',
        action: 'resume',
        ref: { id: created.goal?.id, revision: overHttp.goal?.revision }
      })
    ).json()) as GoalState
    expect(resumed.goal?.phase).toBe('active')
    expect(resumed.activation).toBe('armed')

    // ⑥ 另一个 store 实例（同库）：goal 在（持久化），activation 回 disarmed（不落库）
    const second = createSessionGoalStore(handle.storage)
    await second.ensureTable()
    const reread = await second.state('t1')
    expect(reread.goal).toMatchObject({ id: created.goal?.id, phase: 'active' })
    expect(reread.activation).toBe('disarmed')
  } finally {
    if ('closeAllConnections' in http && typeof http.closeAllConnections === 'function')
      http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
    await handle.mastra.shutdown()
    await handle.storage.close()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] goal integration temp cleanup deferred')
    }
  }
}, 60_000)
