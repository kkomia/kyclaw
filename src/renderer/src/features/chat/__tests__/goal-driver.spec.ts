import { describe, expect, it, vi } from 'vitest'
import type { GoalView } from '@shared/goal'
import { GOAL_DRIVER_ENABLED, blockGoalRoundLimit, disarmGoalOnAbort, planGoalRound, type GoalRoundGateInput } from '../goal-driver'

/**
 * PB-039 driver 骨架：四条准入门串行 + revision 复查 + 消息体/metadata 字段（严格 {goalId, round, revision}）。
 * 默认关闭：`GOAL_DRIVER_ENABLED=false`；单测用 `enabled:true` 显式开。
 */
const goal: GoalView = {
  id: 'g1',
  revision: 4,
  objective: '完成迁移',
  phase: 'active',
  roundsStarted: 1,
  maxGoalRounds: 256,
  createdAt: 1,
  updatedAt: 2
}

const base: GoalRoundGateInput = {
  enabled: true,
  goal,
  activation: 'armed',
  approvalPending: false,
  askUserPending: false,
  planPending: false,
  compacting: false
}

describe('goal-driver 骨架', () => {
  it('默认关闭：GOAL_DRIVER_ENABLED=false → skip disabled', () => {
    expect(GOAL_DRIVER_ENABLED).toBe(false)
    expect(planGoalRound({ ...base, enabled: undefined })).toEqual({
      kind: 'skip',
      reason: 'disabled'
    })
  })

  it('四条准入门各拦一次（审批 / askUser / Plan / 压缩）', () => {
    expect(planGoalRound({ ...base, approvalPending: true })).toEqual({
      kind: 'skip',
      reason: 'approval-pending'
    })
    expect(planGoalRound({ ...base, askUserPending: true })).toEqual({
      kind: 'skip',
      reason: 'ask-user-pending'
    })
    expect(planGoalRound({ ...base, planPending: true })).toEqual({
      kind: 'skip',
      reason: 'plan-pending'
    })
    expect(planGoalRound({ ...base, compacting: true })).toEqual({
      kind: 'skip',
      reason: 'compacting'
    })
  })

  it('goal 自身条件：无 goal / 非 active / 未 armed / 轮尽 各自 skip', () => {
    expect(planGoalRound({ ...base, goal: null })).toEqual({ kind: 'skip', reason: 'no-goal' })
    expect(planGoalRound({ ...base, goal: { ...goal, phase: 'paused' } })).toEqual({
      kind: 'skip',
      reason: 'not-active'
    })
    expect(planGoalRound({ ...base, activation: 'disarmed' })).toEqual({
      kind: 'skip',
      reason: 'not-armed'
    })
    expect(
      planGoalRound({ ...base, goal: { ...goal, roundsStarted: goal.maxGoalRounds } })
    ).toEqual({ kind: 'skip', reason: 'rounds-exhausted' })
  })

  it('发送前 revision 不一致 → 放弃本轮（不拿旧 ref 硬撞 409）', () => {
    expect(planGoalRound({ ...base, latestRevision: 5 })).toEqual({
      kind: 'skip',
      reason: 'revision-changed'
    })
  })

  it('正常准入：<goal_round> 消息体 + metadata {goalId, round, revision}（字段名不改）', () => {
    const decision = planGoalRound(base)
    expect(decision.kind).toBe('send')
    if (decision.kind !== 'send') return

    expect(decision.text).toContain('<goal_round>')
    expect(decision.text).toContain('Round: 2/256')
    expect(decision.text).toContain('"objective":"完成迁移"')
    expect(decision.metadata).toEqual({
      goalRound: { goalId: 'g1', round: 2, revision: 4 }
    })
    expect(Object.keys(decision.metadata.goalRound).sort()).toEqual([
      'goalId',
      'revision',
      'round'
    ])
  })
})

describe('goal-driver round-limit / disarm（2)3)）', () => {
  const state = (g: unknown) => ({ goal: g, activation: 'armed' as const })
  const maxed = { ...goal, roundsStarted: goal.maxGoalRounds }

  it('轮尽 → POST block(round-limit) 一次；重复调用（已 blocked）不再发', async () => {
    const postGoal = vi.fn(async () => state({ ...maxed, phase: 'blocked' }))
    const fetchGoal = vi
      .fn()
      .mockResolvedValueOnce(state(maxed))
      .mockResolvedValueOnce(state({ ...maxed, phase: 'blocked' }))
    const deps = { fetchGoal, postGoal }

    expect(await blockGoalRoundLimit('t1', deps)).toBe(true)
    expect(postGoal).toHaveBeenCalledTimes(1)
    expect(postGoal.mock.calls[0]?.[0]).toMatchObject({
      action: 'block',
      ref: { id: 'g1', revision: 4 },
      blocked: { code: 'round-limit' }
    })

    // 第二次：GET 看到已 blocked → 不发（幂等）
    expect(await blockGoalRoundLimit('t1', deps)).toBe(false)
    expect(postGoal).toHaveBeenCalledTimes(1)
  })

  it('未轮尽 → 不发 block；block 失败只记日志不抛', async () => {
    const postGoal = vi.fn(async () => state(goal))
    const deps = { fetchGoal: vi.fn(async () => state(goal)), postGoal }
    expect(await blockGoalRoundLimit('t2', deps)).toBe(false)
    expect(postGoal).not.toHaveBeenCalled()

    const failing = {
      fetchGoal: vi.fn(async () => state(maxed)),
      postGoal: vi.fn(async () => {
        throw new Error('boom')
      }),
      log: vi.fn()
    }
    await expect(blockGoalRoundLimit('t3', failing)).resolves.toBe(false)
    expect(failing.log).toHaveBeenCalled()
  })

  it('disarm：成功发一次；失败被吞掉（不抛）并记日志', async () => {
    const postGoal = vi.fn(async () => state(goal))
    await disarmGoalOnAbort('t4', { fetchGoal: vi.fn(), postGoal })
    expect(postGoal).toHaveBeenCalledWith({ threadId: 't4', action: 'disarm' })

    const failing = {
      fetchGoal: vi.fn(),
      postGoal: vi.fn(async () => {
        throw new Error('down')
      }),
      log: vi.fn()
    }
    await expect(disarmGoalOnAbort('t5', failing)).resolves.toBeUndefined()
    expect(failing.log).toHaveBeenCalled()
  })
})

