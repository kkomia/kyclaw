import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  taskSnapshotSchema,
  taskWriteSchema,
  type TaskSnapshot,
  type TaskStatus,
  type TaskWrite
} from '@shared/tasks'
import { tasksApi, type TasksApi } from './tasks-api'

export interface TaskSessionState {
  snapshot: TaskSnapshot | null
  loading: boolean
  saving: boolean
  error: string | null
  conflict: string | null
  /** 详情是否收起（round 81：**默认收起** —— 输入框上方只铺紧凑摘要，点摘要才看详情） */
  collapsed: boolean
}

export const EMPTY_TASK_SESSION: TaskSessionState = {
  snapshot: null,
  loading: false,
  saving: false,
  error: null,
  conflict: null,
  collapsed: true
}

export type TaskMutationResult = 'ok' | 'conflict' | 'error' | 'ignored'

export interface TasksState {
  sessions: Readonly<Record<string, TaskSessionState | undefined>>
  load(threadId: string): Promise<void>
  write(threadId: string, input: TaskWrite): Promise<TaskMutationResult>
  setStatus(
    threadId: string,
    id: string,
    status: TaskStatus,
    note?: string
  ): Promise<TaskMutationResult>
  clear(threadId: string): Promise<TaskMutationResult>
  setCollapsed(threadId: string, collapsed: boolean): void
  forget(threadId: string): void
}

export function taskSession(state: TasksState, threadId: string): TaskSessionState {
  return Object.prototype.hasOwnProperty.call(state.sessions, threadId)
    ? (state.sessions[threadId] ?? EMPTY_TASK_SESSION)
    : EMPTY_TASK_SESSION
}

export function createTasksStore(api: TasksApi = tasksApi): StoreApi<TasksState> {
  let serial = 0
  const requests = new Map<string, number>()
  return createStore<TasksState>()((set, get) => {
    const session = (threadId: string): TaskSessionState => taskSession(get(), threadId)
    const patch = (threadId: string, changes: Partial<TaskSessionState>): void => {
      set((state) => ({
        sessions: { ...state.sessions, [threadId]: { ...taskSession(state, threadId), ...changes } }
      }))
    }
    const start = (threadId: string): number => {
      const ticket = ++serial
      requests.set(threadId, ticket)
      return ticket
    }
    const current = (threadId: string, ticket: number): boolean => requests.get(threadId) === ticket
    const invalid = (threadId: string, message: string): TaskMutationResult => {
      patch(threadId, { error: message })
      return 'error'
    }

    return {
      sessions: {},
      async load(threadId) {
        if (session(threadId).saving) return
        const ticket = start(threadId)
        patch(threadId, { loading: true, error: null })
        try {
          const snapshot = taskSnapshotSchema.parse(await api.get(threadId))
          if (!current(threadId, ticket)) return
          const previous = session(threadId).snapshot
          patch(threadId, {
            snapshot:
              previous !== null && previous.revision > snapshot.revision ? previous : snapshot,
            loading: false
          })
        } catch {
          if (current(threadId, ticket))
            patch(threadId, { loading: false, error: '任务加载失败，请重试' })
        }
      },
      async write(threadId, input) {
        const before = session(threadId)
        if (before.saving) return 'ignored'
        if (before.snapshot === null || before.loading)
          return invalid(threadId, '请先加载最新任务再修改')
        const checked = taskWriteSchema.safeParse(input)
        if (!checked.success) return invalid(threadId, '任务修改参数无效，请检查状态和原因')
        if (checked.data.expectedRevision !== before.snapshot.revision) {
          patch(threadId, { conflict: '任务已变化，请查看最新清单后重新操作' })
          return 'conflict'
        }
        const ticket = start(threadId)
        patch(threadId, { saving: true, loading: false, error: null, conflict: null })
        try {
          const result = await api.put(threadId, checked.data)
          const snapshot = taskSnapshotSchema.parse(result.snapshot)
          if (!current(threadId, ticket)) return 'ignored'
          if (snapshot.revision < before.snapshot.revision) throw new Error('旧任务回包')
          patch(threadId, {
            snapshot,
            saving: false,
            conflict:
              result.status === 'conflict'
                ? '任务已被其它操作修改，已加载最新清单；本次修改未保存，请检查后重新操作'
                : null
          })
          return result.status
        } catch {
          if (!current(threadId, ticket)) return 'ignored'
          patch(threadId, { saving: false, error: '任务修改失败，未确认保存；请刷新后重试' })
          return 'error'
        }
      },
      async setStatus(threadId, id, status, note) {
        const before = session(threadId)
        if (before.saving) return 'ignored'
        const item = before.snapshot?.items.find((task) => task.id === id)
        if (!item) return invalid(threadId, '任务已不存在，请刷新清单')
        if (status === 'blocked' && !note?.trim()) return invalid(threadId, '请填写阻塞原因')
        if (note !== undefined && note.length > 1000)
          return invalid(threadId, '原因不能超过 1000 字')
        if (
          status === 'in_progress' &&
          before.snapshot?.items.some((task) => task.id !== id && task.status === 'in_progress')
        ) {
          return invalid(threadId, '已有进行中的任务，请先修改其状态')
        }
        return get().write(threadId, {
          action: 'update',
          expectedRevision: before.snapshot!.revision,
          changes: [{ id, status, ...(note === undefined ? {} : { note }) }]
        })
      },
      async clear(threadId) {
        const before = session(threadId)
        if (before.snapshot === null) return invalid(threadId, '请先加载任务再清空')
        return get().write(threadId, {
          action: 'replace',
          expectedRevision: before.snapshot.revision,
          items: []
        })
      },
      setCollapsed(threadId, collapsed) {
        patch(threadId, { collapsed })
      },
      forget(threadId) {
        requests.delete(threadId)
        set((state) => {
          const sessions = { ...state.sessions }
          delete sessions[threadId]
          return { sessions }
        })
      }
    }
  })
}

export type TasksStore = ReturnType<typeof createTasksStore>
export const tasksStore = createTasksStore()
