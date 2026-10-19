// @vitest-environment node
/**
 * PB-039 阶段②：模型侧 goal 工具三件套（`src/mastra/tools/goal.ts`）。
 * 覆盖：get/create/update 字段与输出形状；人类轮 vs goal round 的来源权限；
 * resume paused 拒绝；blocked 阈值（仅在 goal round 来源强制）；自主 complete/blocked 的收尾注入。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLStore } from '@mastra/libsql'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createGoalTools } from '../goal'
import { createSessionGoalStore, type SessionGoalStore } from '../../session-goal'
import { GOAL_ROUND_CONTEXT_KEY, type GoalState } from '../../../shared/goal'

let dir: string
let storage: LibSQLStore
let store: SessionGoalStore
let tools: Awaited<ReturnType<typeof createGoalTools>>

/** 人类直发轮的上下文（没有 goal round 标记） */
const human = { agent: { threadId: 't1' }, requestContext: {} }
/** goal round（自动续跑）轮的上下文：阶段③会在 chat 入口写这一条 */
function goalRound(goal: GoalState, round = 1): unknown {
  return {
    agent: { threadId: 't1' },
    requestContext: { [GOAL_ROUND_CONTEXT_KEY]: { goalId: goal.goal?.id, revision: goal.goal?.revision, round } }
  }
}

const run = async (tool: unknown, input: unknown, context: unknown = human): Promise<string> => {
  const execute = (tool as { execute?: (input: unknown, context?: unknown) => Promise<unknown> }).execute
  if (execute === undefined) throw new Error('tool has no execute')
  return String(await execute(input, context))
}

const parse = (value: string): GoalState => JSON.parse(value) as GoalState

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-goal-tool-'))
  storage = new LibSQLStore({
    id: 'goal-tool-test',
    url: `file:${join(dir, 'app.db').replace(/\\/g, '/')}`
  })
  store = createSessionGoalStore(storage)
  await store.ensureTable()
  tools = await createGoalTools(store)
})

afterEach(async () => {
  await storage.close()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    console.warn('[kyclaw] goal tool test temp cleanup deferred', error)
  }
})

describe('goal 工具：get / create', () => {
  it('get_goal：无 goal → {goal:null,activation:disarmed}', async () => {
    expect(parse(await run(tools.get_goal, {}))).toEqual({ goal: null, activation: 'disarmed' })
  })

  it('create_goal（人类轮）→ active/revision 1/默认 256 + armed；再 create → GOAL_ALREADY_EXISTS', async () => {
    const created = parse(await run(tools.create_goal, { objective: '完成迁移' }))
    expect(created.goal).toMatchObject({
      revision: 1,
      phase: 'active',
      objective: '完成迁移',
      maxGoalRounds: 256
    })
    expect(created.activation).toBe('armed')
    const again = JSON.parse(await run(tools.create_goal, { objective: '另一个' })) as {
      error: { code: string; message: string }
    }
    expect(again.error.code).toBe('GOAL_ALREADY_EXISTS')
    expect(again.error.message).toContain('未完成的 goal')
  })

  it('create_goal 在 goal round 里 → GOAL_TOOL_HUMAN_ONLY（不建 goal）', async () => {
    // 一个结构合法的 goal round 标记（真实场景里这一轮必有 goal；这里只看来源权限）
    const roundContext = {
      agent: { threadId: 't1' },
      requestContext: {
        [GOAL_ROUND_CONTEXT_KEY]: { goalId: 'round-goal', revision: 1, round: 1 }
      }
    }
    const output = JSON.parse(
      await run(tools.create_goal, { objective: '续跑里建' }, roundContext)
    ) as { error: { code: string } }
    expect(output.error.code).toBe('GOAL_TOOL_HUMAN_ONLY')
    expect((await store.state('t1')).goal).toBeNull()
  })
})

describe('goal 工具：update 动作与权限', () => {
  it('edit（人类轮）：改 objective + max_goal_rounds，phase 不变；陈旧 revision → STALE', async () => {
    const created = parse(await run(tools.create_goal, { objective: '原目标' }))
    const edited = parse(
      await run(tools.update_goal, {
        goal_id: created.goal?.id,
        revision: created.goal?.revision,
        action: 'edit',
        objective: '新目标',
        max_goal_rounds: 5
      })
    )
    expect(edited.goal).toMatchObject({ objective: '新目标', maxGoalRounds: 5, phase: 'active', revision: 2 })
    const stale = JSON.parse(
      await run(tools.update_goal, {
        goal_id: created.goal?.id,
        revision: 1,
        action: 'edit',
        objective: '再改'
      })
    ) as { error: { code: string } }
    expect(stale.error.code).toBe('GOAL_STALE_REVISION')
  })

  it('pause（人类轮）→ paused/disarmed；模型不能 resume paused（GOAL_TOOL_RESUME_PAUSED）', async () => {
    const created = parse(await run(tools.create_goal, { objective: '目标' }))
    const paused = parse(
      await run(tools.update_goal, {
        goal_id: created.goal?.id,
        revision: created.goal?.revision,
        action: 'pause'
      })
    )
    expect(paused.goal?.phase).toBe('paused')
    const resumed = JSON.parse(
      await run(tools.update_goal, {
        goal_id: created.goal?.id,
        revision: paused.goal?.revision,
        action: 'resume'
      })
    ) as { error: { code: string } }
    expect(resumed.error.code).toBe('GOAL_TOOL_RESUME_PAUSED')
  })

  it('pause/edit 在 goal round 里 → GOAL_TOOL_HUMAN_ONLY', async () => {
    const created = parse(await run(tools.create_goal, { objective: '目标' }))
    const context = goalRound(created)
    for (const action of ['pause', 'edit'] as const) {
      const output = JSON.parse(
        await run(tools.update_goal, {
          goal_id: created.goal?.id,
          revision: created.goal?.revision,
          action,
          ...(action === 'edit' ? { objective: '改' } : {})
        }, context)
      ) as { error: { code: string } }
      expect(output.error.code, action).toBe('GOAL_TOOL_HUMAN_ONLY')
    }
  })

  it('complete（goal round）→ complete + 注入 <goal_complete> 收尾；人类轮不注入', async () => {
    const created = parse(await run(tools.create_goal, { objective: '目标' }))
    const autonomous = await run(
      tools.update_goal,
      { goal_id: created.goal?.id, revision: created.goal?.revision, action: 'complete' },
      goalRound(created)
    )
    expect(autonomous).toContain('<goal_complete>')
    expect(autonomous).toContain('向用户交代')
    expect(JSON.parse(autonomous.split('\n\n')[0]).goal.phase).toBe('complete')

    const next = parse(await run(tools.create_goal, { objective: '第二个目标' }))
    const humanComplete = await run(tools.update_goal, {
      goal_id: next.goal?.id,
      revision: next.goal?.revision,
      action: 'complete'
    })
    expect(humanComplete).not.toContain('<goal_complete>')
  })

  it('blocked：goal round 且轮数 <3 → GOAL_TOOL_BLOCK_THRESHOLD；满 3 轮后成功并注入 <goal_blocked>', async () => {
    let state = parse(await run(tools.create_goal, { objective: '目标' }))
    const goalId = state.goal?.id ?? ''
    // 先走 3 轮准入（模拟 driver 的三轮）
    for (let round = 1; round <= 3; round += 1) {
      state = await store.admitRound('t1', {
        goalId,
        revision: state.goal?.revision ?? 0,
        round
      })
    }
    // 阈值边界：满 3 轮后允许
    const blocked = await run(
      tools.update_goal,
      {
        goal_id: goalId,
        revision: state.goal?.revision,
        action: 'blocked',
        blocked_reason: '缺用户提供的部署凭据'
      },
      goalRound(state)
    )
    expect(blocked).toContain('<goal_blocked>')
    const body = JSON.parse(blocked.split('\n\n')[0]) as GoalState
    expect(body.goal).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'model-reported', message: '缺用户提供的部署凭据' }
    })
    // 新一轮 goal（先把 blocked 的收成 complete 才能 create），只跑 1 轮就 blocked → 阈值拒绝
    await store.complete('t1', { id: body.goal?.id ?? '', revision: body.goal?.revision ?? 0 })
    const fresh = parse(await run(tools.create_goal, { objective: '第二个' }))
    const admitted = await store.admitRound('t1', {
      goalId: fresh.goal?.id ?? '',
      revision: fresh.goal?.revision ?? 0,
      round: 1
    })
    const tooEarly = JSON.parse(
      await run(
        tools.update_goal,
        {
          goal_id: fresh.goal?.id,
          revision: admitted.goal?.revision,
          action: 'blocked',
          blocked_reason: '太早'
        },
        goalRound(admitted)
      )
    ) as { error: { code: string } }
    expect(tooEarly.error.code).toBe('GOAL_TOOL_BLOCK_THRESHOLD')
  })
})

