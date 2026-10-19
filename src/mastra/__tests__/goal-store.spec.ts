// @vitest-environment node
/**
 * PB-039 goal 服务端权威状态（`src/mastra/session-goal.ts`）：
 * create 互斥 / edit 只改两字段 / pause·resume·complete·block·clear 的合法转换 /
 * CAS revision / **activation 不持久化** / goal round 准入计数。
 * 存储用真 libsql（临时目录），与 `session-plan.spec.ts` 同款夹具。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLStore } from '@mastra/libsql'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionGoalStore, type SessionGoalStore } from '../session-goal'
import { DEFAULT_MAX_GOAL_ROUNDS, type GoalRef, type GoalState } from '../../shared/goal'

let dir: string
let storage: LibSQLStore
let store: SessionGoalStore

function refOf(state: GoalState): GoalRef {
  if (state.goal === null) throw new Error('no goal')
  return { id: state.goal.id, revision: state.goal.revision }
}

async function created(objective = '完成迁移', maxGoalRounds?: number): Promise<GoalState> {
  return store.create('t1', objective, maxGoalRounds)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-goal-'))
  storage = new LibSQLStore({
    id: 'goal-test',
    url: `file:${join(dir, 'app.db').replace(/\\/g, '/')}`
  })
  store = createSessionGoalStore(storage)
  await store.ensureTable()
})

afterEach(async () => {
  await storage.close()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    console.warn('[kyclaw] goal test temp cleanup deferred (libsql handle)', error)
  }
})

describe('goal：create 与 CAS', () => {
  it('create → active/revision 1/rounds 0/默认上限 256，且 armed', async () => {
    const state = await created()
    expect(state.activation).toBe('armed')
    expect(state.goal).toMatchObject({
      revision: 1,
      objective: '完成迁移',
      phase: 'active',
      roundsStarted: 0,
      maxGoalRounds: DEFAULT_MAX_GOAL_ROUNDS
    })
  })

  it('还有未完成的 goal 时 create → GOAL_ALREADY_EXISTS（409）', async () => {
    await created()
    await expect(created('另一个')).rejects.toMatchObject({
      code: 'GOAL_ALREADY_EXISTS',
      status: 409
    })
  })

  it('陈旧 revision 的 edit → GOAL_STALE_REVISION', async () => {
    const first = await created()
    const stale = refOf(first)
    const next = await store.edit('t1', stale, { objective: '改过的目标' })
    expect(next.goal?.revision).toBe(2)
    await expect(store.edit('t1', stale, { objective: '再改' })).rejects.toMatchObject({
      code: 'GOAL_STALE_REVISION'
    })
  })

  it('edit 一个字段都不给 → GOAL_INVALID_EDIT；改 maxGoalRounds 不改 phase', async () => {
    const state = await created()
    await expect(store.edit('t1', refOf(state), {})).rejects.toMatchObject({
      code: 'GOAL_INVALID_EDIT'
    })
    const edited = await store.edit('t1', refOf(state), { maxGoalRounds: 5 })
    expect(edited.goal).toMatchObject({ phase: 'active', maxGoalRounds: 5, revision: 2 })
  })
})

describe('goal：生命周期转换', () => {
  it('pause：仅 active；paused 后再次 pause → GOAL_INVALID_TRANSITION', async () => {
    const state = await created()
    const paused = await store.pause('t1', refOf(state))
    expect(paused.goal?.phase).toBe('paused')
    expect(paused.activation).toBe('disarmed')
    await expect(store.pause('t1', refOf(paused))).rejects.toMatchObject({
      code: 'GOAL_INVALID_TRANSITION'
    })
  })

  it('resume：paused → active + armed；已 armed 再 resume → 拒绝', async () => {
    const state = await created()
    const paused = await store.pause('t1', refOf(state))
    const resumed = await store.resume('t1', refOf(paused))
    expect(resumed.goal?.phase).toBe('active')
    expect(resumed.activation).toBe('armed')
    await expect(store.resume('t1', refOf(resumed))).rejects.toMatchObject({
      code: 'GOAL_INVALID_TRANSITION'
    })
  })

  it('resume 在轮数用尽时拒绝（maxGoalRounds=1，用完 1 轮后 pause→resume）', async () => {
    const state = await created('小上限', 1)
    const admitted = await store.admitRound('t1', {
      goalId: state.goal?.id ?? '',
      revision: state.goal?.revision ?? 0,
      round: 1
    })
    expect(admitted.goal?.roundsStarted).toBe(1)
    const paused = await store.pause('t1', refOf(admitted))
    await expect(store.resume('t1', refOf(paused))).rejects.toMatchObject({
      code: 'GOAL_INVALID_TRANSITION'
    })
  })

  it('block：仅 active；写 {code,message} 并 disarmed', async () => {
    const state = await created()
    const blocked = await store.block('t1', refOf(state), {
      code: 'round-limit',
      message: 'Goal reached its configured limit of 3 rounds.'
    })
    expect(blocked.goal?.phase).toBe('blocked')
    expect(blocked.goal?.blockedReason).toEqual({
      code: 'round-limit',
      message: 'Goal reached its configured limit of 3 rounds.'
    })
    expect(blocked.activation).toBe('disarmed')
    await expect(
      store.block('t1', refOf(blocked), { code: 'x', message: 'y' })
    ).rejects.toMatchObject({ code: 'GOAL_INVALID_TRANSITION' })
  })

  it('complete 后可以 create 新 goal（替换旧 complete）', async () => {
    const state = await created()
    const completed = await store.complete('t1', refOf(state))
    expect(completed.goal?.phase).toBe('complete')
    expect(completed.activation).toBe('disarmed')
    const fresh = await created('新的目标')
    expect(fresh.goal?.phase).toBe('active')
    expect(fresh.goal?.objective).toBe('新的目标')
  })

  it('clear：goal 变 null、disarmed；再 clear → GOAL_NOT_FOUND；之后可再 create', async () => {
    const state = await created()
    const oldRef = refOf(state)
    const cleared = await store.clear('t1', oldRef)
    expect(cleared.goal).toBeNull()
    expect(cleared.activation).toBe('disarmed')
    const after = await store.state('t1')
    expect(after.goal).toBeNull()
    // 已经没有 goal：再 clear 按契约是 NOT_FOUND（墓碑只保证状态为空，不给旧 ref 续命）
    await expect(store.clear('t1', oldRef)).rejects.toMatchObject({
      code: 'GOAL_NOT_FOUND',
      status: 404
    })
    // 墓碑行还在，但 create 能直接在其上替换（revision 继续单调）
    const fresh = await created('清除后的新目标')
    expect(fresh.goal?.phase).toBe('active')
    expect(fresh.goal?.revision).toBe(1)
  })

  it('没有 goal 时做 edit/pause/resume/complete/block/clear → GOAL_NOT_FOUND（404）', async () => {
    const ref = { id: 'nope', revision: 1 }
    for (const run of [
      () => store.edit('t1', ref, { objective: 'x' }),
      () => store.pause('t1', ref),
      () => store.resume('t1', ref),
      () => store.complete('t1', ref),
      () => store.block('t1', ref, { code: 'x', message: 'y' }),
      () => store.clear('t1', ref)
    ]) {
      await expect(run()).rejects.toMatchObject({ code: 'GOAL_NOT_FOUND', status: 404 })
    }
  })
})

describe('goal：activation 不持久化', () => {
  it('新 store 实例（同库）读到的 activation 是 disarmed，goal 仍在', async () => {
    const state = await created()
    expect(state.activation).toBe('armed')
    const fresh = createSessionGoalStore(storage)
    const reread = await fresh.state('t1')
    expect(reread.goal?.id).toBe(state.goal?.id)
    expect(reread.activation).toBe('disarmed')
  })

  it('disarm 只改 activation、不动 phase / revision', async () => {
    const state = await created()
    const disarmed = await store.disarm('t1')
    expect(disarmed.activation).toBe('disarmed')
    expect(disarmed.goal).toMatchObject({
      id: state.goal?.id,
      revision: state.goal?.revision,
      phase: 'active'
    })
  })
})

describe('goal：round 准入计数', () => {
  it('准入成功：roundsStarted+1、revision+1（预留轮号必须正好是下一轮）', async () => {
    const state = await created()
    const admitted = await store.admitRound('t1', {
      goalId: state.goal?.id ?? '',
      revision: state.goal?.revision ?? 0,
      round: 1
    })
    expect(admitted.goal).toMatchObject({ roundsStarted: 1, revision: 2, phase: 'active' })
    const second = await store.admitRound('t1', {
      goalId: state.goal?.id ?? '',
      revision: admitted.goal?.revision ?? 0,
      round: 2
    })
    expect(second.goal?.roundsStarted).toBe(2)
  })

  it('轮号跳号 / 陈旧 revision → GOAL_STALE_REVISION', async () => {
    const state = await created()
    const goalId = state.goal?.id ?? ''
    await expect(
      store.admitRound('t1', { goalId, revision: state.goal?.revision ?? 0, round: 2 })
    ).rejects.toMatchObject({ code: 'GOAL_STALE_REVISION' })
    await expect(store.admitRound('t1', { goalId, revision: 99, round: 1 })).rejects.toMatchObject({
      code: 'GOAL_STALE_REVISION'
    })
  })

  it('非 active（paused）或轮数用尽 → GOAL_INVALID_TRANSITION', async () => {
    const state = await created('上限 1', 1)
    const goalId = state.goal?.id ?? ''
    const admitted = await store.admitRound('t1', {
      goalId,
      revision: state.goal?.revision ?? 0,
      round: 1
    })
    // 用尽（roundsStarted === max）
    await expect(
      store.admitRound('t1', { goalId, revision: admitted.goal?.revision ?? 0, round: 2 })
    ).rejects.toMatchObject({ code: 'GOAL_INVALID_TRANSITION' })
    // paused 也不能准入
    const paused = await store.pause('t1', refOf(admitted))
    await expect(
      store.admitRound('t1', { goalId, revision: paused.goal?.revision ?? 0, round: 2 })
    ).rejects.toMatchObject({ code: 'GOAL_INVALID_TRANSITION' })
  })
})
