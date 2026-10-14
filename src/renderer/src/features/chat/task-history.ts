import {
  taskSnapshotSchema,
  todoOutputSchema,
  type TaskSnapshot,
  type TaskStatus
} from '@shared/tasks'

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  pending: '待办',
  in_progress: '进行中',
  done: '已完成',
  blocked: '已阻塞'
}

export interface TaskProgress {
  done: number
  total: number
  inProgress: number
  blocked: number
  allDone: boolean
}

export function taskProgress(snapshot: TaskSnapshot | null): TaskProgress {
  const items = snapshot?.items ?? []
  const done = items.filter((item) => item.status === 'done').length
  return {
    done,
    total: items.length,
    inProgress: items.filter((item) => item.status === 'in_progress').length,
    blocked: items.filter((item) => item.status === 'blocked').length,
    allDone: items.length > 0 && done === items.length
  }
}

export interface TaskHistoryProjection {
  revision: number
  progress: TaskProgress
  summary: string
  items: Array<{
    id: string
    title: string
    status: TaskStatus
    statusLabel: string
    note?: string
  }>
  updatedAt: string | null
}

export function projectTaskSnapshot(raw: unknown): TaskHistoryProjection | null {
  const parsed = taskSnapshotSchema.safeParse(raw)
  if (!parsed.success) return null
  const snapshot = parsed.data
  const progress = taskProgress(snapshot)
  return {
    revision: snapshot.revision,
    progress,
    summary: `任务 ${progress.done}/${progress.total}${progress.allDone ? ' · 全部完成' : ''}${progress.inProgress ? ' · 进行中' : ''}${progress.blocked ? ` · ${progress.blocked} 项阻塞` : ''}`,
    items: snapshot.items.map(({ id, title, status, note }) => ({
      id,
      title,
      status,
      statusLabel: TASK_STATUS_LABELS[status],
      ...(note === undefined ? {} : { note })
    })),
    updatedAt: snapshot.updatedAt
  }
}

export function projectTodoOutput(
  raw: unknown
): (TaskHistoryProjection & { conflict: boolean }) | null {
  const parsed = todoOutputSchema.safeParse(raw)
  if (!parsed.success) return null
  const projection = projectTaskSnapshot(parsed.data.snapshot)
  return projection === null ? null : { ...projection, conflict: parsed.data.status === 'conflict' }
}
