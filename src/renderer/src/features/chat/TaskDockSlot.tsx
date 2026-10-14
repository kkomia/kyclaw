import { useEffect } from 'react'
import { useStore } from 'zustand'
import { tasksStore, taskSession, type TasksStore } from '@renderer/lib/tasks-store'
import { TaskListDock } from './TaskListDock'

export interface TaskDockSlotProps {
  threadId: string | null
  store?: TasksStore
  materialized?: boolean
}

/**
 * 会话任务清单在输入框上方的那一格（round 81 改）。
 *
 * 旧形态：工具条那一行常驻两颗按钮 ——「任务清单」（无任务时撑出一枚入口）与「进入规划模式」，
 * 再挂 `toolbar` 里更多的模式按钮。用户口径：**常驻的模式按钮收进左下角 ＋ 菜单**
 * （见 ComposerControls 的 PlusMenu），这一格就只剩任务清单本体：
 *   - 有任务：渲染紧凑摘要（TaskListDock 自己画，默认收起、点摘要展开详情）；
 *   - 没有任务且收起：**整块不渲染** —— 不铺常驻按钮，入口在 ＋ 菜单的「任务清单」里
 *     （点它把 store 的 collapsed 翻成 false，这一格就带着空态说明出现）。
 *
 * 折叠状态只有一个来源：`tasks-store` 的 `collapsed`（round 81 起默认 true = 收起），
 * 这里不另存一份平行状态。
 */
export function TaskDockSlot({
  threadId,
  materialized = true,
  store = tasksStore
}: TaskDockSlotProps): React.JSX.Element | null {
  const state = useStore(store, (value) =>
    threadId === null ? null : taskSession(value, threadId)
  )
  useEffect(() => {
    if (threadId !== null && materialized) void store.getState().load(threadId)
  }, [threadId, store, materialized])
  if (threadId === null || state === null) return null
  const hasTasks = (state.snapshot?.items.length ?? 0) > 0
  if (!hasTasks && state.collapsed) return null
  return (
    <div
      data-testid="task-dock-slot"
      className="mx-auto mb-2 w-full min-w-0 max-w-(--chat-input-max-width)"
    >
      {materialized ? (
        <TaskListDock threadId={threadId} store={store} />
      ) : (
        <p className="py-2 text-c1 text-ink-secondary">发送消息或进入规划后可使用会话任务清单</p>
      )}
    </div>
  )
}
