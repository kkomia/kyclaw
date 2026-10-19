/**
 * MCP 管理 API（T12）：挂在 agent 服务（service.ts）上的 Hono 子路由，路径前缀 /api/mcp。
 *
 * 三条：
 *   GET  /api/mcp/servers            当前配置（settings.json 里的 mcpServers）
 *   PUT  /api/mcp/servers            整表替换（校验 → 落盘 → 回吐落盘后的列表）
 *   POST /api/mcp/servers/:id/test   测试连接（连一次、列工具、断开；失败给人话分类）
 *
 * 三条纪律（和 threads 路由同一套）：
 *   1. **服务端是权威**：列表直接读写 settings.json；渲染端发来的只是"想要的结果"。
 *   2. 入参全部过 zod（shared/mcp.ts），非法即 400；校验（启用必须完整、id 不重复）在落盘前拦。
 *   3. 写盘只发生在这里（settings:update 的补丁 schema 不收 mcpServers）——一条路一个校验。
 *
 * 测试连接走的是"和运行期同一条解析路径"（mastra/mcp.ts 的 testMcpServer）：配错了在这里就能看见。
 */
import { Hono } from 'hono'
import {
  mcpServersProblems,
  mcpServersResponseSchema,
  mcpTestResultSchema,
  putMcpServersRequestSchema,
  type McpTestResult
} from '../../shared/mcp'
import type { McpServerConfig } from '../../shared/settings'

export interface McpRouterOptions {
  /** 现读配置（生产 = dataDir/settings.json） */
  readServers: () => readonly McpServerConfig[]
  /** 整表落盘并回吐落盘后的列表（生产 = main/settings.updateSettings） */
  saveServers: (servers: McpServerConfig[]) => readonly McpServerConfig[]
  /**
   * 配置写成功后的回调（生产 = lifecycle.refresh）：启停/删除**当场**生效——
   * 停用/删除的 server 子进程随连接断开下线，启用的立刻拉起，不用等下一次对话。
   */
  onServersChanged?: () => void
  /** 测试连接（缺省 = mastra/mcp.ts 的 testMcpServer；测试可注入） */
  testServer?: (config: McpServerConfig) => Promise<McpTestResult>
}

function badRequest(detail: string): { error: string } {
  return { error: `invalid-input: ${detail}` }
}

export function createMcpRouter(options: McpRouterOptions): Hono {
  const router = new Hono()

  const testServer = options.testServer

  router.get('/servers', (context) => {
    return context.json(mcpServersResponseSchema.parse({ servers: options.readServers() }))
  })

  router.put('/servers', async (context) => {
    const body = putMcpServersRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json(badRequest('server 列表形状不对'), 400)

    const problems = mcpServersProblems(body.data.servers)
    if (problems.length > 0) return context.json(badRequest(problems.join('；')), 400)

    const saved = mcpServersResponseSchema.parse({
      servers: options.saveServers([...body.data.servers])
    })
    // 写成功才通知（落盘失败不该动运行期连接）；回调是"尽力而为"，不拦回包
    try {
      options.onServersChanged?.()
    } catch (error) {
      console.warn('[kyclaw] MCP 配置已落盘，但连接对齐失败（下一轮对话会再对齐）', error)
    }
    return context.json(saved)
  })

  router.post('/servers/:id/test', async (context) => {
    const id = context.req.param('id')
    const config = options.readServers().find((server) => server.id === id)
    if (config === undefined) return context.json({ error: 'not-found' }, 404)
    // PB-022：生产 mount 已整体 501；这里不再临时 import ../mcp（旧路径 import=0）。
    // 旧测试若注入 testServer 仍可覆盖 handler；未注入时明确 disabled，不落回旧实现。
    if (testServer === undefined) {
      return context.json({ error: 'feature-disabled', feature: 'mcp', availableIn: '0.2.x' }, 501)
    }

    const result = await testServer(config)
    return context.json(mcpTestResultSchema.parse(result))
  })

  return router
}
