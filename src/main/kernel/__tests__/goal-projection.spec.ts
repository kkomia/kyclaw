// @vitest-environment node
/**
 * B3.3：goal 六行投影（纯函数）。核心判据：
 * - Rounds **不得单独显示 256**：内核 256 > 我方安全阀 16 → `x/16（内核上限 256）`；
 * - 到 16 轮：Activation 停用、Commands 只留清空/人工确认；
 * - 内核上限 ≤16 时按内核值显示。
 */
import { describe, expect, it } from 'vitest'
import {
  GOAL_SAFE_ROUND_LIMIT,
  projectGoalDock,
  projectGoal,
  type KernelGoalState
} from '../goal-projection'

function state(
  overrides: Partial<KernelGoalState['goal']> = {},
  roundsStarted = 3
): KernelGoalState {
  return {
    goal: {
      id: 'goal-1',
      objective: '完成迁移验证',
      phase: 'active',
      maxGoalRounds: 256,
      revision: 1,
      ...overrides
    },
    roundsStarted,
    createdAt: 1,
    updatedAt: 2
  }
}

describe('goal 六行投影（内核权威只读）', () => {
  it('无 goal → dock 隐藏', () => {
    expect(projectGoalDock(null)).toEqual({ visible: false, rows: [], commands: [] })
  })

  it('Rounds 显示 x/16（内核上限 256），绝不单独显示 256', () => {
    const dock = projectGoalDock(state({}, 3))
    const rows = Object.fromEntries(dock.rows.map((row) => [row.id, row]))
    expect(dock.rows.map((row) => row.id)).toEqual([
      'status',
      'blocker',
      'objective',
      'rounds',
      'activation',
      'commands'
    ])
    expect(rows.rounds?.value).toBe('3/16（内核上限 256）')
    expect(dock.rounds).toEqual({
      started: 3,
      limit: 16,
      kernelLimit: 256,
      label: '3/16（内核上限 256）'
    })
    expect(rows.activation?.value).toBe('续行已启用')
    expect(rows.commands?.value).toContain('/goal pause')
  })

  it('到达 16 轮安全阀：状态行提示、Activation 停用、Commands 只留清空', () => {
    const dock = projectGoalDock(state({}, GOAL_SAFE_ROUND_LIMIT))
    const rows = Object.fromEntries(dock.rows.map((row) => [row.id, row]))
    expect(rows.rounds?.value).toContain('已达安全阀上限')
    expect(rows.activation?.value).toContain('已停用')
    expect(dock.commands).toEqual(['goal clear'])
  })

  it('内核上限 ≤16 时按内核值显示（不强行写 16）', () => {
    const dock = projectGoalDock(state({ maxGoalRounds: 8 }, 3))
    expect(dock.rounds?.label).toBe('3/8')
    expect(dock.rows.find((row) => row.id === 'rounds')?.value).toBe('3/8')
  })

  it('blocked：Blocker 行显示内核策略说明，命令含 resume/clear', () => {
    const dock = projectGoalDock(
      state({ phase: 'blocked', blockedReason: { code: 'round-limit', message: '轮次额度用尽' } })
    )
    expect(dock.rows.find((row) => row.id === 'blocker')?.value).toBe('轮次额度用尽')
    expect(dock.commands).toEqual(['goal resume', 'goal clear'])
  })

  it('兼容 B2 GoalPort 投影：只读、actions 从命令推导', () => {
    expect(projectGoal(null)).toEqual({ visible: false, actions: [] })
    const projection = projectGoal(state())
    expect(projection.visible).toBe(true)
    expect(projection.roundsLabel).toBe('3/16（内核上限 256）')
    expect(projection.actions).toContain('pause')
  })
})
