import type { AgentEndpoint } from '@shared/ipc'
import {
  taskThreadIdSchema,
  taskWriteSchema,
  taskSnapshotSchema,
  taskHistorySchema,
  type TaskHistory,
  type TaskSnapshot,
  type TaskWrite,
  type TodoOutput
} from '@shared/tasks'
import { resolveAgentEndpoint } from './agent'
import { featureDisabledError } from './feature-disabled'

export interface TasksApi {
  get(threadId: string): Promise<TaskSnapshot>
  put(threadId: string, input: TaskWrite): Promise<TodoOutput>
}

async function request(
  threadId: string,
  input?: TaskWrite,
  endpoint?: AgentEndpoint
): Promise<Response> {
  const id = taskThreadIdSchema.parse(threadId)
  const body = input === undefined ? undefined : JSON.stringify(taskWriteSchema.parse(input))
  const { baseUrl, token } = endpoint ?? (await resolveAgentEndpoint())
  return fetch(`${baseUrl}/api/tasks/${encodeURIComponent(id)}`, {
    method: input === undefined ? 'GET' : 'PUT',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body })
  })
}

function snapshot(value: unknown): TaskSnapshot {
  const parsed = taskSnapshotSchema.safeParse(value)
  if (!parsed.success) throw new Error('任务服务回包格式不对，请刷新后重试')
  return parsed.data
}

function serviceError(status: number): Error {
  if (status === 501) return featureDisabledError()
  return new Error(
    status === 404 ? '当前会话不存在或不可访问' : `任务服务返回 ${status}，请稍后重试`
  )
}

export async function fetchTasks(
  threadId: string,
  endpoint?: AgentEndpoint
): Promise<TaskSnapshot> {
  const response = await request(threadId, undefined, endpoint)
  if (!response.ok) throw serviceError(response.status)
  return snapshot(await response.json())
}

export async function writeTasks(
  threadId: string,
  input: TaskWrite,
  endpoint?: AgentEndpoint
): Promise<TodoOutput> {
  const response = await request(threadId, input, endpoint)
  if (response.status === 409) {
    const body: unknown = await response.json()
    if (
      typeof body !== 'object' ||
      body === null ||
      !('snapshot' in body) ||
      !('error' in body) ||
      body.error !== 'revision-conflict'
    ) {
      throw new Error('任务冲突回包格式不对，请刷新后重试')
    }
    return { status: 'conflict', snapshot: snapshot(body.snapshot) }
  }
  if (!response.ok) throw serviceError(response.status)
  return { status: 'ok', snapshot: snapshot(await response.json()) }
}

export async function fetchTaskHistory(threadId: string): Promise<TaskHistory> {
  const id = taskThreadIdSchema.parse(threadId)
  const { baseUrl, token } = await resolveAgentEndpoint()
  const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(id)}/history`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!response.ok) throw serviceError(response.status)
  const result = taskHistorySchema.safeParse(await response.json())
  if (!result.success) throw new Error('任务历史回包格式不对，请刷新后重试')
  return result.data
}

export const tasksApi: TasksApi = { get: fetchTasks, put: writeTasks }
