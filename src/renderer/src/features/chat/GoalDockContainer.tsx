import { useCallback, useEffect, useState } from 'react'
import type { KernelGoalProjection, KernelPlanProjection } from '@shared/kernel-ui'
import { fetchKernelProjection, runKernelCommand } from './kernel-command-api'
import { GoalDock } from './GoalDock'

/**
 * PB-018 goal 条容器：**只读内核投影**（`GET /api/kernel/projection`），无 goal 不渲染（不占位）。
 * 动作不再 POST 旧 `/api/goal`（PB-024 起八条旧路由会 501），而是发内核命令
 * `/goal pause|resume|clear`（走 `POST /api/kernel/command` 的 command/run→done），完成后重取投影。
 *
 * 对外：组件 + `onHasGoalChange(hasGoal)`（父级据此隐藏海獭/排 dock 顺序）+
 * `onPlanChange(plan)`（plan 投影上报，`active||pending` 都算规划中，由上层用 kernelPlanActive 判）。
 */
export interface GoalDockContainerProps {
  threadId: string
  /** 有/无 goal 变化时通知父级（dock 顺序与海獭可见性） */
  onHasGoalChange?: (hasGoal: boolean) => void
  /** plan 投影变化时上报（内核模式的状态摘要/任务清单可见性用） */
  onPlanChange?: (plan: KernelPlanProjection | null) => void
  /** 编辑入口交给上层（内联编辑不在本组件内实现） */
  onEdit?: (projection: KernelGoalProjection) => void
  /** 外部要求重取的信号（值变化即重取一次；命令改过 goal 后 +1） */
  refreshKey?: number
}

export function GoalDockContainer({
  threadId,
  onHasGoalChange,
  onPlanChange,
  onEdit,
  refreshKey = 0
}: GoalDockContainerProps): React.JSX.Element | null {
  const [projection, setProjection] = useState<KernelGoalProjection | null>(null)

  const refresh = useCallback(async () => {
    try {
      const snapshot = await fetchKernelProjection(threadId)
      setProjection(snapshot.goal)
      onHasGoalChange?.(snapshot.goal?.visible === true)
      onPlanChange?.(snapshot.plan)
    } catch {
      setProjection(null)
      onHasGoalChange?.(false)
      onPlanChange?.(null)
    }
  }, [threadId, onHasGoalChange, onPlanChange])

  useEffect(() => {
    // 与旧容器同一手法：effect 里不直接调 async（react-hooks/set-state-in-effect），
    // 写成 promise 回调里的 setState，并保证卸载后不再回写。
    let cancelled = false
    void fetchKernelProjection(threadId).then(
      (snapshot) => {
        if (cancelled) return
        setProjection(snapshot.goal)
        onHasGoalChange?.(snapshot.goal?.visible === true)
        onPlanChange?.(snapshot.plan)
      },
      () => {
        if (cancelled) return
        setProjection(null)
        onHasGoalChange?.(false)
        onPlanChange?.(null)
      }
    )
    return () => {
      cancelled = true
    }
  }, [threadId, onHasGoalChange, onPlanChange, refreshKey])

  const act = useCallback(
    async (command: 'pause' | 'resume' | 'clear') => {
      try {
        await runKernelCommand(threadId, `/goal ${command}`, () => {
          // 结果卡由 ChatPage 自己订阅；这里只需在 done 后重取投影
        })
      } catch {
        // 失败留给下一次刷新投影展示（条只反映服务端真值，不做乐观态）
      } finally {
        await refresh()
      }
    },
    [refresh, threadId]
  )

  if (projection === null || !projection.visible) return null
  if (projection.phase === 'complete') return null

  return (
    <GoalDock
      projection={projection}
      onPause={() => void act('pause')}
      onResume={() => void act('resume')}
      onClear={() => void act('clear')}
      onEdit={onEdit === undefined ? undefined : () => onEdit(projection)}
    />
  )
}
