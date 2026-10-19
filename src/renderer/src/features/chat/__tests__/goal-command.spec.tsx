import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { isGoalCommand, parseGoalCommand } from '../goal-command'
import { GoalCommandCard } from '../GoalCommandCard'
import type { GoalView } from '@shared/goal'

/**
 * PB-039 `/goal` 解析 + 六行结果卡片（V1 不进历史）。
 * 语法照 DSH `command-goal:19-35`（控制词占满整行才算），输出结构照 `:59-77`。
 */
const goal: GoalView = {
  id: 'g1',
  revision: 2,
  objective: '完成迁移',
  phase: 'active',
  roundsStarted: 1,
  maxGoalRounds: 256,
  createdAt: 1,
  updatedAt: 2
}

describe('/goal 解析', () => {
  it('命令名边界：/goal 与 /goal … 命中，/goalkeeper 不命中', () => {
    expect(isGoalCommand('/goal')).toBe(true)
    expect(isGoalCommand('/goal pause')).toBe(true)
    expect(isGoalCommand('/goalkeeper')).toBe(false)
    expect(parseGoalCommand('帮我看看')).toEqual({ kind: 'not-goal' })
  })

  it('控制词占满整行才算；带后缀的 pause 创建字面 objective', () => {
    expect(parseGoalCommand('/goal clear')).toEqual({ kind: 'action', action: 'clear' })
    expect(parseGoalCommand('/goal pause')).toEqual({ kind: 'action', action: 'pause' })
    expect(parseGoalCommand('/goal resume')).toEqual({ kind: 'action', action: 'resume' })
    expect(parseGoalCommand('/goal pause after verification')).toEqual({
      kind: 'action',
      action: 'create',
      objective: 'pause after verification'
    })
  })

  it('edit：缺 objective 报错不发送；带 objective 走 edit；其余文本走 create；无参数 = 状态', () => {
    expect(parseGoalCommand('/goal edit')).toMatchObject({ kind: 'invalid' })
    expect(parseGoalCommand('/goal edit 新目标')).toEqual({
      kind: 'action',
      action: 'edit',
      objective: '新目标'
    })
    expect(parseGoalCommand('/goal 做一次迁移')).toEqual({
      kind: 'action',
      action: 'create',
      objective: '做一次迁移'
    })
    expect(parseGoalCommand('/goal')).toEqual({ kind: 'action', action: 'status' })
  })
})

describe('GoalCommandCard 六行', () => {
  it('有 goal：Status/Blocker/Objective/Rounds/Activation/Commands 六行', () => {
    render(<GoalCommandCard goal={goal} activation="disarmed" />)
    const card = screen.getByTestId('goal-command-card')
    for (const label of ['Status', 'Blocker', 'Objective', 'Rounds', 'Activation', 'Commands']) {
      expect(card).toHaveTextContent(label)
    }
    expect(card).toHaveTextContent('进行中')
    expect(card).toHaveTextContent('1/256')
    expect(card).toHaveTextContent('disarmed')
    expect(screen.queryByTestId('goal-command-empty')).not.toBeInTheDocument()
  })

  it('无 goal：显示契约原文，不造数据、没有假按钮', () => {
    render(<GoalCommandCard goal={null} activation="disarmed" />)
    expect(screen.getByTestId('goal-command-empty')).toHaveTextContent(
      'No goal is currently set; /goal <action> requires one.'
    )
    expect(screen.queryByTestId('goal-command-lines')).not.toBeInTheDocument()
  })

  it('错误：显示中文 message，不渲染 id/revision', () => {
    render(
      <GoalCommandCard
        goal={null}
        activation="disarmed"
        error="这个 goal 在别处被改过（revision 不一致），请刷新后再试。"
      />
    )
    expect(screen.getByTestId('goal-command-error')).toHaveTextContent('revision 不一致')
  })
})
