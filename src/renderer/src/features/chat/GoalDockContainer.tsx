import { useCallback, useEffect, useState } from 'react'
import type { GoalState, GoalView } from '@shared/goal'
import { fetchGoal, postGoalWithRetry } from './goal-api'
import { GoalDock } from './GoalDock'

/**
 * PB-039 goal 条容器：自己取数（`GET /api/goal`），无 goal 不渲染（返回 null，不占位）。
 * 对外只暴露两样：组件本身 + `onHasGoalChange(hasGoal)`（父级据此隐藏海獭/排 dock 顺序）。
 * 动作 → `POST`，409 重 GET 重发一次复用 `postGoalWithRetry`（与 /goal 命令同一套）。
 */
export interface GoalDockContainerProps {
  threadId: string
  /** 有/无 goal 变化时通知父级（dock 顺序与海獭可见性） */
  onHasGoalChange?: (hasGoal: boolean) => void
  /** 编辑入口交给上层（内联编辑不在本组件内实现） */
  onEdit?: (goal: GoalView) => void
}

export function GoalDockContainer({
  threadId,
  onHasGoalChange,
  onEdit
}: GoalDockContainerProps): React.JSX.Element | null {
  const [state, setState] = useState<GoalState | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await fetchGoal(threadId)
      setState(next)
      onHasGoalChange?.(next.goal !== null)
    } catch {
      setState(null)
      onHasGoalChange?.(false)
    }
  }, [threadId, onHasGoalChange])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = useCallback(
    async (action: 'pause' | 'resume' | 'clear') => {
      const current = state?.goal
      if (current === undefined || current === null) return
      try {
        await postGoalWithRetry(
          { threadId, action, ref: { id: current.id, revision: current.revision } },
          threadId
        )
      } catch {
        // 失败留给下一次刷新展示（卡片/条只反映服务端真值，不做乐观态）
      } finally {
        await refresh()
      }
    },
    [refresh, state?.goal, threadId]
  )

  const goal = state?.goal ?? null
  // complete / 无 goal 不渲染（不占位）
  if (goal === null || goal.phase === 'complete') return null

  return (
    <GoalDock
      goal={goal}
      activation={state?.activation ?? 'disarmed'}
      onPause={() => void act('pause')}
      onResume={() => void act('resume')}
      onClear={() => void act('clear')}
      onEdit={onEdit === undefined ? undefined : () => onEdit(goal)}
    />
  )
}
