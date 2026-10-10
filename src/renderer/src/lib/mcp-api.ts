/**
 * MCP 管理 API 客户端（渲染端）：直连主进程内嵌的 agent 服务（和 chat / 线程同一条路）。
 *
 * 与 IPC 的 settings 面分工：MCP 配置的写入口在服务端（PUT /api/mcp/servers，带着
 * "启用必须完整"的校验），读回来的列表就是落盘真相；settings:update 的补丁 schema 里
 * 没有 mcpServers 这个字段，所以这里不是"另一条路"，是唯一那条。
 */
import type { z } from 'zod'
import { mcpServersResponseSchema, mcpTestResultSchema, type McpTestResult } from '@shared/mcp'
import type { McpServerConfig } from '@shared/settings'

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

/** 失败时尽量把服务端那句人话带出来（400 的 invalid-input 详情就在 body 里） */
async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    const detail = typeof body?.error === 'string' ? body.error : `MCP 服务返回 ${response.status}`
    throw new Error(detail.replace(/^invalid-input:\s*/, ''))
  }
  const parsed = schema.safeParse(await response.json())
  if (!parsed.success) {
    throw new Error(`MCP 服务回包格式不对：${parsed.error.issues[0]?.message ?? '未知'}`)
  }
  return parsed.data
}

/** 当前 MCP server 列表（服务端是权威） */
export async function fetchMcpServers(): Promise<McpServerConfig[]> {
  const response = await authorized('/api/mcp/servers')
  const { servers } = await json(response, mcpServersResponseSchema)
  return servers
}

/** 整表保存（返回落盘后的列表；校验失败抛带原因的错） */
export async function saveMcpServers(
  servers: readonly McpServerConfig[]
): Promise<McpServerConfig[]> {
  const response = await authorized('/api/mcp/servers', {
    method: 'PUT',
    body: JSON.stringify({ servers })
  })
  const parsed = await json(response, mcpServersResponseSchema)
  return parsed.servers
}

/** 测试连接：连一次、列工具、断开（成功给工具清单，失败给分类与一句人话） */
export async function testMcpServer(id: string): Promise<McpTestResult> {
  const response = await authorized(`/api/mcp/servers/${encodeURIComponent(id)}/test`, {
    method: 'POST'
  })
  return json(response, mcpTestResultSchema)
}
