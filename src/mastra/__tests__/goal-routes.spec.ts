// @vitest-environment node
/**
 * PB-039 goal HTTP 路由层（`src/mastra/routes/goal.ts`）：入参校验 + 领域错误 → `{error,message}`
 * + 动作派发。存储用真 libsql；路由是 Hono 子路由，用 `app.request()` 直接跑（真 HTTP 语义，
 * 不另起端口）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLStore } from '@mastra/libsql'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGoalRouter } from '../routes/goal'
import { createSessionGoalStore, type SessionGoalStore } from '../session-goal'
import type { GoalState } from '../../shared/goal'

let dir: string
let storage: LibSQLStore
let store: SessionGoalStore
let app: ReturnType<typeof createGoalRouter>

async function get(threadId?: string): Promise<Response> {
  return app.request(`/?threadId=${encodeURIComponent(threadId ?? '')}`)
}

async function post(body: unknown): Promise<Response> {
  return app.request('/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

async function stateOf(threadId: string): Promise<GoalState> {
  return (await (await get(threadId)).json()) as GoalState
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-goal-http-'))
  storage = new LibSQLStore({
    id: 'goal-http-test',
    url: `file:${join(dir, 'app.db').replace(/\\/g, '/')}`
  })
  store = createSessionGoalStore(storage)
  await store.ensureTable()
  app = createGoalRouter(store)
})

afterEach(async () => {
  await storage.close()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    console.warn('[kyclaw] goal http test temp cleanup deferred', error)
  }
})

describe('goal 路由：读与动作', () => {
  it('GET 无 goal → 200 {goal:null,activation:disarmed}', async () => {
    const response = await get('t1')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ goal: null, activation: 'disarmed' })
  })

  it('GET 缺 threadId → 400 GOAL_INVALID_ACTION', async () => {
    const response = await get(undefined)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'GOAL_INVALID_ACTION' })
  })

  it('POST create → goal active + armed；再 create → 409 GOAL_ALREADY_EXISTS（带中文 message）', async () => {
    const created = await post({ threadId: 't1', action: 'create', objective: '完成迁移' })
    expect(created.status).toBe(200)
    const body = (await created.json()) as GoalState
    expect(body.goal).toMatchObject({ phase: 'active', revision: 1, roundsStarted: 0 })
    expect(body.activation).toBe('armed')

    const again = await post({ threadId: 't1', action: 'create', objective: '另一个' })
    expect(again.status).toBe(409)
    const error = (await again.json()) as { error: string; message: string }
    expect(error.error).toBe('GOAL_ALREADY_EXISTS')
    expect(error.message).toContain('未完成的 goal')
  })

  it('POST pause/resume/edit/clear 全链路（CAS 用最新 revision）', async () => {
    const created = (await (
      await post({ threadId: 't1', action: 'create', objective: '目标' })
    ).json()) as GoalState
    const ref = { id: created.goal?.id ?? '', revision: created.goal?.revision ?? 0 }

    const paused = (await (
      await post({ threadId: 't1', action: 'pause', ref })
    ).json()) as GoalState
    expect(paused.goal?.phase).toBe('paused')
    expect(paused.activation).toBe('disarmed')

    const edited = (await (
      await post({
        threadId: 't1',
        action: 'edit',
        ref: { id: ref.id, revision: paused.goal?.revision ?? 0 },
        objective: '改过的目标'
      })
    ).json()) as GoalState
    expect(edited.goal).toMatchObject({ phase: 'paused', objective: '改过的目标' })

    const resumed = (await (
      await post({
        threadId: 't1',
        action: 'resume',
        ref: { id: ref.id, revision: edited.goal?.revision ?? 0 }
      })
    ).json()) as GoalState
    expect(resumed.goal?.phase).toBe('active')
    expect(resumed.activation).toBe('armed')

    const cleared = (await (
      await post({
        threadId: 't1',
        action: 'clear',
        ref: { id: ref.id, revision: resumed.goal?.revision ?? 0 }
      })
    ).json()) as GoalState
    expect(cleared.goal).toBeNull()
    expect((await stateOf('t1')).goal).toBeNull()
  })

  it('陈旧 revision → 409 GOAL_STALE_REVISION；非法 body → 400 GOAL_INVALID_ACTION', async () => {
    const created = (await (
      await post({ threadId: 't1', action: 'create', objective: '目标' })
    ).json()) as GoalState
    const stale = { id: created.goal?.id ?? '', revision: 1 }
    await post({ threadId: 't1', action: 'pause', ref: stale })
    const resumed = await post({
      threadId: 't1',
      action: 'resume',
      ref: stale // 已被 pause 消费掉的 revision
    })
    expect(resumed.status).toBe(409)
    expect(await resumed.json()).toMatchObject({ error: 'GOAL_STALE_REVISION' })

    const invalid = await post({ threadId: 't1', action: 'nope' })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: 'GOAL_INVALID_ACTION' })
  })

  it('POST block 写稳定 code；POST disarm 只改 activation 不动 revision', async () => {
    const created = (await (
      await post({ threadId: 't1', action: 'create', objective: '目标' })
    ).json()) as GoalState
    const ref = { id: created.goal?.id ?? '', revision: created.goal?.revision ?? 0 }

    const blocked = (await (
      await post({
        threadId: 't1',
        action: 'block',
        ref,
        blocked: { code: 'round-limit', message: 'Goal reached its configured limit of 256 rounds.' }
      })
    ).json()) as GoalState
    expect(blocked.goal?.phase).toBe('blocked')
    expect(blocked.goal?.blockedReason?.code).toBe('round-limit')
    expect(blocked.activation).toBe('disarmed')

    const fresh = (await (
      await post({ threadId: 't2', action: 'create', objective: '第二个会话' })
    ).json()) as GoalState
    const disarmed = (await (
      await post({ threadId: 't2', action: 'disarm' })
    ).json()) as GoalState
    expect(disarmed.activation).toBe('disarmed')
    expect(disarmed.goal).toMatchObject({ revision: fresh.goal?.revision, phase: 'active' })
  })
})

