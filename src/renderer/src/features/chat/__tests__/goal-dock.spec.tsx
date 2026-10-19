import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * PB-039 goal 条容器：GET 取数、无 goal 不渲染、动作走 POST（409 重 GET 重发由 postGoalWithRetry）、
 * 动作成功后重新 GET。
 */
const api = vi.hoisted(() => ({ fetchGoal: vi.fn(), postGoalWithRetry: vi.fn() }))
vi.mock('../goal-api', () => api)

import { GoalDockContainer } from '../GoalDockContainer'

const goal = {
  id: 'g1',
  revision: 4,
  objective: '完成迁移',
  phase: 'active' as const,
  roundsStarted: 1,
  maxGoalRounds: 256,
  createdAt: 1,
  updatedAt: 2
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('GoalDockContainer', () => {
  it('无 goal → 不渲染（不占位）', async () => {
    api.fetchGoal.mockResolvedValue({ goal: null, activation: 'disarmed' })
    const onHasGoalChange = vi.fn()
    const { container } = render(
      <GoalDockContainer threadId="t1" onHasGoalChange={onHasGoalChange} />
    )
    await waitFor(() => expect(api.fetchGoal).toHaveBeenCalled())
    expect(container.querySelector('[data-testid=goal-dock]')).toBeNull()
    expect(onHasGoalChange).toHaveBeenCalledWith(false)
  })

  it('有 goal → 渲染 phase/objective/轮数 + 圆钮；pause 走 POST 成功后重新 GET', async () => {
    api.fetchGoal.mockResolvedValue({ goal, activation: 'armed' })
    api.postGoalWithRetry.mockResolvedValue({ goal: { ...goal, phase: 'paused' }, activation: 'disarmed' })
    const onHasGoalChange = vi.fn()
    render(<GoalDockContainer threadId="t1" onHasGoalChange={onHasGoalChange} />)

    const dock = await screen.findByTestId('goal-dock')
    expect(dock).toHaveTextContent('进行中')
    expect(dock).toHaveTextContent('完成迁移')
    expect(dock).toHaveTextContent('1/256')
    expect(screen.getByTestId('goal-dock-pause')).toBeInTheDocument()

    screen.getByTestId('goal-dock-pause').click()
    await waitFor(() =>
      expect(api.postGoalWithRetry).toHaveBeenCalledWith(
        { threadId: 't1', action: 'pause', ref: { id: 'g1', revision: 4 } },
        't1'
      )
    )
    // 动作成功后刷新（GET 再拉一次）
    await waitFor(() => expect(api.fetchGoal.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(onHasGoalChange).toHaveBeenCalledWith(true)
  })
})
