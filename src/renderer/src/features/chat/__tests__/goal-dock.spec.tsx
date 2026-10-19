import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KernelGoalProjection } from '@shared/kernel-ui'

/**
 * PB-018 goal 条容器：只读内核投影（不再打旧 `/api/goal`），动作发内核命令后重取投影。
 */
const api = vi.hoisted(() => ({
  fetchKernelProjection: vi.fn(),
  runKernelCommand: vi.fn()
}))
vi.mock('../kernel-command-api', () => api)

import { GoalDockContainer } from '../GoalDockContainer'

const projection: KernelGoalProjection = {
  visible: true,
  goalId: 'g1',
  phase: 'active',
  rounds: { started: 1, limit: 16, kernelLimit: 256, label: '1/16（内核上限 256）' },
  rows: [
    { id: 'status', label: 'Status', value: '进行中', tone: 'normal' },
    { id: 'blocker', label: 'Blocker', value: '—', tone: 'muted' },
    { id: 'objective', label: 'Objective', value: '完成迁移', tone: 'normal' },
    { id: 'rounds', label: 'Rounds', value: '1/16（内核上限 256）', tone: 'normal' },
    { id: 'activation', label: 'Activation', value: '续行已启用', tone: 'normal' },
    { id: 'commands', label: 'Commands', value: '/goal pause', tone: 'muted' }
  ],
  commands: ['goal pause', 'goal edit', 'goal clear']
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('GoalDockContainer（内核投影）', () => {
  it('无 goal → 不渲染（不占位），并上报 hasGoal=false / plan', async () => {
    api.fetchKernelProjection.mockResolvedValue({
      goal: null,
      plan: { active: false, pending: true }
    })
    const onHasGoalChange = vi.fn()
    const onPlanChange = vi.fn()
    const { container } = render(
      <GoalDockContainer
        threadId="t1"
        onHasGoalChange={onHasGoalChange}
        onPlanChange={onPlanChange}
      />
    )
    await waitFor(() => expect(api.fetchKernelProjection).toHaveBeenCalledWith('t1'))
    expect(container.querySelector('[data-testid=goal-dock]')).toBeNull()
    expect(onHasGoalChange).toHaveBeenCalledWith(false)
    expect(onPlanChange).toHaveBeenCalledWith({ active: false, pending: true })
  })

  it('有 goal → 状态/目标/轮数来自六行投影；pause 发内核命令成功后重取', async () => {
    api.fetchKernelProjection.mockResolvedValue({
      goal: projection,
      plan: { active: false, pending: false }
    })
    api.runKernelCommand.mockResolvedValue(undefined)
    const onHasGoalChange = vi.fn()
    render(<GoalDockContainer threadId="t1" onHasGoalChange={onHasGoalChange} />)

    const dock = await screen.findByTestId('goal-dock')
    expect(dock).toHaveTextContent('进行中')
    expect(dock).toHaveTextContent('完成迁移')
    expect(dock).toHaveTextContent('1/16（内核上限 256）')
    expect(screen.getByTestId('goal-dock-pause')).toBeInTheDocument()

    screen.getByTestId('goal-dock-pause').click()
    await waitFor(() =>
      expect(api.runKernelCommand).toHaveBeenCalledWith('t1', '/goal pause', expect.any(Function))
    )
    // 动作成功后重取投影（GET 再拉一次）
    await waitFor(() =>
      expect(api.fetchKernelProjection.mock.calls.length).toBeGreaterThanOrEqual(2)
    )
    expect(onHasGoalChange).toHaveBeenCalledWith(true)
  })

  it('投影给 resume/clear 时只出现对应按钮（四动作由 commands 决定，不自己猜 phase）', async () => {
    api.fetchKernelProjection.mockResolvedValue({
      goal: {
        ...projection,
        phase: 'paused',
        commands: ['goal resume', 'goal edit', 'goal clear']
      },
      plan: null
    })
    render(<GoalDockContainer threadId="t1" />)
    const dock = await screen.findByTestId('goal-dock')
    expect(dock).toHaveAttribute('data-phase', 'paused')
    expect(screen.getByTestId('goal-dock-resume')).toBeInTheDocument()
    expect(screen.queryByTestId('goal-dock-pause')).not.toBeInTheDocument()
    expect(screen.getByTestId('goal-dock-clear')).toBeInTheDocument()
  })
})
