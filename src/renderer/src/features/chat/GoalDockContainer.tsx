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
  /**
   * 外部要求重取的信号（值变化即重取一次）。
   * 为什么需要：`/goal <objective>` 这类命令在别处改完 goal 后，本容器只在挂载/换会话时取数，
   * 不刷新就看不到新条（命令建了 goal、条却不出现）。
   */
  refreshKey?: number
}

export function GoalDockContainer({
  threadId,
  onHasGoalChange,
  onEdit,
  refreshKey = 0
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
    // 不直接调 refresh()：它是 async，但调用发生在同步阶段，`react-hooks/set-state-in-effect`
    // 会把它当成"effect 里同步 setState"。写成 promise 回调里的 setState —— 语义不变
    // （挂载/换会话/refreshKey 变 → 取一次），并保证卸载后不再回写。
    let cancelled = false
    void fetchGoal(threadId).then(
      (next) => {
        if (cancelled) return
        setState(next)
        onHasGoalChange?.(next.goal !== null)
      },
      () => {
        if (cancelled) return
        setState(null)
        onHasGoalChange?.(false)
      }
    )
    return () => {
      cancelled = true
    }
  }, [threadId, onHasGoalChange, refreshKey])

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
