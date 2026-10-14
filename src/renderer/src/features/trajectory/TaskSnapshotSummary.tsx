import { useStore } from 'zustand'
import { tasksStore, taskSession, type TasksStore } from '@renderer/lib/tasks-store'
import { projectTaskSnapshot } from '../chat/task-history'

export function TaskSnapshotSummary({
  threadId,
  store = tasksStore
}: {
  threadId: string
  store?: TasksStore
}): React.JSX.Element | null {
  const state = useStore(store, (value) => taskSession(value, threadId))
  const current = projectTaskSnapshot(state.snapshot)
  if (!current || current.progress.total === 0) return null
  return (
    <p
      data-testid="trajectory-current-tasks"
      className="shrink-0 px-4 py-1 text-c1 text-ink-secondary [overflow-wrap:anywhere]"
    >
      当前任务快照 · 版本 {current.revision} · {current.summary}
      <span className="ml-2 text-ink-tertiary">历史以各次 todo 回执为准</span>
    </p>
  )
}
