/**
 * 会话↔PPT 模板映射 API 客户端（渲染端，round 66）：直连主进程内嵌的 agent 服务
 * （同 chat transport / 线程 API / 项目映射的路）。
 *
 * 为什么走 HTTP 而不是 IPC：映射表在 agent 服务那一侧（libsql 的 `session_ppt_templates`），
 * 服务端才是读写它的单写者（内存镜像与表要一致，见 mastra/session-ppt-templates.ts），
 * 而且 `create_ppt` 的缺省模板直接读这份镜像 —— 渲染端写完，同一轮工具调用就看得到。
 * 渲染端只经这两条口子读写：
 *   GET  /api/ppt/templates   读全部映射（启动时拉一遍，切会话当场就有）
 *   PUT  /api/ppt/templates   写一条（选一个模板 / 空串清回自动）
 *
 * 回包过 shared/session-ppt-templates 的 schema（边界纪律同线程 API）：格式不对就抛，由 store 落到错误态。
 *
 * 端点可以**由调用方传进来**（`fetchSessionPptTemplates(endpoint)`）：对话页在拼 chat 传输时
 * 已经解析过一份，预取直接复用它，不再多问一次主进程（那一次多余的 IPC 曾经把
 * error-card 那条"端点恰好被解析 2 次"的用例顶穿）。不传就自己解析 —— 本模块单独用也成立。
 */
import type { z } from 'zod'
import type { AgentEndpoint } from '@shared/ipc'
import { isFeatureDisabled, featureDisabledError } from './feature-disabled'
import {
  sessionPptTemplateListSchema,
  sessionPptTemplateRequestSchema,
  type SessionPptTemplateEntry
} from '@shared/session-ppt-templates'

async function authorized(
  path: string,
  init: RequestInit = {},
  endpoint?: AgentEndpoint
): Promise<Response> {
  // 给了就用给的（调用方刚解析出来的那一份）；没给就现取
  const { baseUrl, token } = endpoint ?? (await window.kyclaw.agent.endpoint())
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

/**
 * 全部会话↔模板映射（服务端是权威；渲染端启动拉一次）。
 * `endpoint` = 调用方已经解析过的端点（可选，见文件头注）。
 */
export async function fetchSessionPptTemplates(
  endpoint?: AgentEndpoint
): Promise<SessionPptTemplateEntry[]> {
  const response = await authorized('/api/ppt/templates', {}, endpoint)
  const { sessions } = await json(response, sessionPptTemplateListSchema, 'PPT 模板映射')
  return sessions
}

/** 写一条（template 空串 = 清回自动）；调用方负责错误展示 */
export async function putSessionPptTemplate(threadId: string, template: string): Promise<void> {
  const body = sessionPptTemplateRequestSchema.parse({ threadId, template })
  const response = await authorized('/api/ppt/templates', {
    method: 'PUT',
    body: JSON.stringify(body)
  })
  if (isFeatureDisabled(response)) throw featureDisabledError()
  if (!response.ok) throw new Error(`PPT 模板映射服务返回 ${response.status}`)
}
