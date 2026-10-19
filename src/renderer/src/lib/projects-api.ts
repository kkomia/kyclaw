/**
 * 项目映射 API 客户端（渲染端，T18）：直连主进程内嵌的 agent 服务（同 chat transport / 线程 API 的路）。
 *
 * 为什么走 HTTP 而不是 IPC：映射表在 agent 服务那一侧（libsql 的 session_projects，与线程同库），
 * 服务端才是读写它的单写者（内存镜像与表要一致）。渲染端只经这两条口子读写：
 *   GET  /api/projects/mappings   读全部映射（侧栏按项目分组）
 *   PUT  /api/projects/mappings   写一条（新建会话归属项目 / 把会话从项目里摘出来）
 *
 * 回包过 shared/projects 的 schema（边界纪律同线程 API）：格式不对就抛，由 store 落到错误态。
 */
import type { z } from 'zod'
import { isFeatureDisabled, featureDisabledError } from './feature-disabled'
import {
  sessionProjectListSchema,
  sessionProjectRequestSchema,
  type SessionProjectEntry
} from '@shared/projects'

async function authorized(path: string, init: RequestInit = {}): Promise<Response> {
  const { baseUrl, token } = await window.kyclaw.agent.endpoint()
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...init.headers
    }
  })
}

async function json<T>(response: Response, schema: z.ZodType<T>, what: string): Promise<T> {
  if (isFeatureDisabled(response)) throw featureDisabledError()
  if (!response.ok) throw new Error(`${what}服务返回 ${response.status}`)
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error(`${what}服务回包格式不对：${parsed.error.issues[0]?.message ?? '未知'}`)
  }
  return parsed.data
}

/** 全部会话↔项目映射（服务端是权威；侧栏每次进"项目"区都从这里取） */
export async function fetchSessionProjects(): Promise<SessionProjectEntry[]> {
  const response = await authorized('/api/projects/mappings')
  const { sessions } = await json(response, sessionProjectListSchema, '项目映射')
  return sessions
}

/** 写一条映射（projectId=null = 把会话从项目里摘出来）；调用方负责错误展示 */
export async function putSessionProject(threadId: string, projectId: string | null): Promise<void> {
  const body = sessionProjectRequestSchema.parse({ threadId, projectId })
  const response = await authorized('/api/projects/mappings', {
    method: 'PUT',
    body: JSON.stringify(body)
  })
  if (isFeatureDisabled(response)) throw featureDisabledError()
  if (!response.ok) throw new Error(`项目映射服务返回 ${response.status}`)
}
