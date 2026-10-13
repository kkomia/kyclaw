/**
 * add_mcp_server / remove_mcp_server（round 65）：让模型把用户贴来的 MCP 配置**落进设置并生效**。
 *
 * 复用既有写盘路径（这是硬要求）：落盘走注入的 `saveMcpServers`，而生产实现就是
 * `PUT /api/mcp/servers` 用的那一个函数（`updateSettings(settings.json, { mcpServers })`），
 * 校验走 `shared/mcp.ts` 里同一份 `mcpServersProblems` / `mcpServerProblems` —— 不另起一套，
 * 也就不可能出现"界面里能存的配置，模型写不进去"或反过来的分叉。
 *
 * 口径：
 *   - **id**：给了就按 `MCP_ID_PATTERN` 校验（1-32 位小写字母/数字/短横线——它要进工具名
 *     `mcp__<id>__<tool>`，含 `__` 会让"哪个 server 的工具"变得有歧义）；没给就按 name 派生
 *     （`claimMcpId`：格式化后可用且不重名才用，否则退 `mcp-N`）。同名 id 已存在 = 覆盖更新；
 *   - **transport 两种**：`stdio`（command/args/env，本机起子进程）与 `http`（url/headers，
 *     Streamable HTTP）。字段缺了、url 不是完整 http(s) 地址 → 回人话，不抛异常；
 *   - **enabled 缺省 false**：与界面"新增一律停用"、插件安装同口径 —— 先落盘，用户在设置 → MCP
 *     里点「测试连接/启用」。只有配置**完整**时才允许 `enabled: true`（否则启用即报错的配置不该进列表）；
 *   - **`readOnlyTools` 不给模型**：那是用户对单个 MCP 工具点的"只读"标记（勾了才免审批）。
 *     让模型自己勾等于绕过审批 —— 一律落空数组，要免审由用户在设置里自己点；
 *   - 落盘成功后调 `onMcpServersChanged()`（生产 = lifecycle.refresh）：启停当场生效，
 *     不必等下一次对话。
 *
 * 审批：两个都按写类（classify 的表 + guard.needsApproval 的"无显式目标"档：工作区「完全访问」
 * 时免审，与 bash/fetch/MCP 外部工具同一套 round 36 口径）。写入的 server 会**执行本机命令**
 * （stdio）或**向外部地址发请求**（http），所以审批卡上给的信息必须够用户判断——
 * description 里写明了这一点。
 */
import type { Tool } from '@mastra/core/tools'
import type { McpServerConfig } from '../../shared/settings'
import {
  claimMcpId,
  isHttpUrl,
  MCP_ID_PATTERN,
  mcpServerProblems,
  mcpServersProblems
} from '../../shared/mcp'
import type { AuthoringRuntime } from '../../shared/authoring'
import { z } from '../../shared/zod'
import { approvalSessionOf, needsApproval, type ToolContext } from './guard'

const NO_RUNTIME_MESSAGE =
  '当前运行环境不支持修改 MCP 配置（没有注入设置写入的运行时）：只有桌面端应用里才能改。'

/** id 不合规时的同一句人话 */
const ID_PROBLEM =
  '标识只能用 1-32 位小写字母、数字或短横线（它要进工具名 mcp__<id>__<工具名>，不能含 __）'

export const addMcpServerInputSchema = z.object({
  name: z
    .string()
    .min(1, 'MCP 服务的显示名不能为空（设置 → MCP 面板里看到的那个名字）')
    .max(60, '显示名最长 60 字符')
    .describe('Display name, the one shown on the Settings → MCP panel'),
  transport: z
    .enum(['stdio', 'http'])
    .describe('stdio starts a child process on this machine; http connects to an HTTP address'),
  id: z
    .string()
    .max(32, '标识最长 32 位（1-32 位小写字母/数字/短横线）')
    .optional()
    .describe(
      'Stable identifier of lowercase letters, digits and hyphens, derived from name when omitted. An existing id is overwritten'
    ),
  command: z
    .string()
    .max(500, '命令最长 500 字符')
    .optional()
    .describe('stdio: the launch command, for example npx, uvx or node'),
  args: z
    .array(z.string().max(500))
    .max(50)
    .optional()
    .describe('stdio: command arguments, one array element each rather than one joined string'),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe('stdio: extra environment variables for the child process, as name to value pairs'),
  url: z.string().max(2000).optional().describe('http: the full http(s):// address'),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe('http: custom request headers, for example Authorization to Bearer xxx'),
  enabled: z
    .boolean()
    .optional()
    .describe('Whether to enable it. Defaults to false, which only writes the configuration; true is allowed only for a complete configuration')
})

export type AddMcpServerInput = z.infer<typeof addMcpServerInputSchema>

export const removeMcpServerInputSchema = z.object({
  id: z
    .string()
    .min(1, '要移除的服务标识不能为空')
    .max(32, '标识最长 32 位（1-32 位小写字母/数字/短横线）')
    .describe('Identifier of the MCP server to remove, the id shown on the Settings → MCP panel')
})

export type RemoveMcpServerInput = z.infer<typeof removeMcpServerInputSchema>

/** 输入 → 一条待落盘的配置（形状不对就回人话；不抛） */
function buildServer(
  input: AddMcpServerInput,
  existing: readonly McpServerConfig[]
): { ok: true; server: McpServerConfig } | { ok: false; message: string } {
  const name = input.name.trim()
  const used = new Set(existing.map((server) => server.id))
  const explicitId = input.id?.trim() ?? ''
  if (explicitId !== '' && !MCP_ID_PATTERN.test(explicitId)) {
    return { ok: false, message: `add_mcp_server 失败：${ID_PROBLEM}；「${explicitId}」不可以。` }
  }
  const id = explicitId !== '' ? explicitId : claimMcpId(name, used)

  if (input.transport === 'stdio') {
    const command = input.command?.trim() ?? ''
    if (command === '') {
      return {
        ok: false,
        message:
          'add_mcp_server 失败：stdio 服务要填 command（启动命令，如 npx / uvx / node）。' +
          '如果用户给的是网址，就用 transport: "http" + url。'
      }
    }
    return {
      ok: true,
      server: {
        id,
        name,
        transport: 'stdio',
        command,
        args: [...(input.args ?? [])],
        ...(input.env === undefined ? {} : { env: { ...input.env } }),
        enabled: input.enabled ?? false,
        readOnlyTools: []
      }
    }
  }

  const url = input.url?.trim() ?? ''
  if (url === '' || !isHttpUrl(url)) {
    return {
      ok: false,
      message:
        'add_mcp_server 失败：http 服务要填完整的 http:// 或 https:// 地址。' +
        '如果用户给的是本机命令，就用 transport: "stdio" + command。'
    }
  }
  return {
    ok: true,
    server: {
      id,
      name,
      transport: 'http',
      url,
      ...(input.headers === undefined ? {} : { headers: { ...input.headers } }),
      enabled: input.enabled ?? false,
      readOnlyTools: []
    }
  }
}

export async function createAddMcpServerTool(
  ctx: ToolContext,
  runtime: () => AuthoringRuntime | null
): Promise<Tool<AddMcpServerInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'add_mcp_server',
    description:
      // round 70 瘦身：这里原本还把"stdio 给 command/args/env、http 给 url/headers"和 enabled 的
      // 缺省又说了一遍 —— 那两条各自的字段描述里都有，模型填字段时看得到，顶层不重复
      'Add or overwrite an MCP server by id; written to the saved mcpServers and effective immediately, disabled unless enabled. ' +
      'Use it when the user pastes an MCP configuration to install. stdio starts a local process, http makes outbound requests.',
    inputSchema: addMcpServerInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'add_mcp_server', input, approvalSessionOf(approval)),
    execute: async (input) => {
      const rt = runtime()
      if (rt === null) return NO_RUNTIME_MESSAGE

      const existing = rt.readMcpServers()
      const built = buildServer(input, existing)
      if (!built.ok) return built.message
      const server = built.server

      if (server.enabled) {
        const problems = mcpServerProblems(server)
        if (problems.length > 0) {
          return (
            `add_mcp_server 失败：这份配置还不完整，不能启用（${problems.join('；')}）。` +
            '先按缺的字段补全，或者用 enabled: false 落盘（用户在设置 → MCP 里补完再启用）。'
          )
        }
      }

      const replaced = existing.some((item) => item.id === server.id)
      const merged = replaced
        ? existing.map((item) => (item.id === server.id ? server : item))
        : [...existing, server]

      const problems = mcpServersProblems(merged)
      if (problems.length > 0) {
        return `add_mcp_server 失败：${problems.join('；')}。`
      }

      let saved: readonly McpServerConfig[]
      try {
        saved = rt.saveMcpServers([...merged])
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return `add_mcp_server 失败：配置没能落盘（${detail}）。`
      }
      try {
        rt.onMcpServersChanged?.()
      } catch (error) {
        console.warn('[kyclaw] MCP 配置已落盘，但连接对齐失败（下一轮对话会再对齐）', error)
      }

      const stored = saved.find((item) => item.id === server.id) ?? server
      const state = stored.enabled ? '已启用' : '未启用（enabled: false）'
      const transport =
        stored.transport === 'stdio'
          ? `stdio：${stored.command ?? ''}`
          : `http：${stored.url ?? ''}`
      const nextStep = stored.enabled
        ? '它提供的工具从下一轮对话起以 mcp__' + stored.id + '__<工具名> 出现，调用时仍会按需审批。'
        : '要它可用：让用户在「设置 → MCP」里点测试连接并启用（或者让模型再调一次本工具带 enabled: true —— 前提是配置完整）。'
      return (
        `已${replaced ? '更新' : '添加'} MCP 服务「${stored.name}」（id: ${stored.id}，${transport}，${state}）。` +
        `${nextStep}配置写在设置里的 mcpServers，也可以在设置 → MCP 面板里继续改。`
      )
    }
  })
}

export async function createRemoveMcpServerTool(
  ctx: ToolContext,
  runtime: () => AuthoringRuntime | null
): Promise<Tool<RemoveMcpServerInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'remove_mcp_server',
    description:
      'Remove an MCP server from the saved configuration by id; its tools stop working immediately. ' +
      'To pause one instead, keep the configuration and turn off its switch in Settings.',
    inputSchema: removeMcpServerInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'remove_mcp_server', input, approvalSessionOf(approval)),
    execute: async (input) => {
      const rt = runtime()
      if (rt === null) return NO_RUNTIME_MESSAGE

      const id = input.id.trim()
      const existing = rt.readMcpServers()
      const target = existing.find((server) => server.id === id)
      if (target === undefined) {
        const list =
          existing.length === 0
            ? '（当前一个都没有）'
            : existing.map((server) => `${server.id}（${server.name}）`).join('、')
        return `remove_mcp_server 失败：没有 id 为「${id}」的 MCP 服务。当前配置：${list}。`
      }

      try {
        rt.saveMcpServers(existing.filter((server) => server.id !== id))
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return `remove_mcp_server 失败：配置没能落盘（${detail}）。`
      }
      try {
        rt.onMcpServersChanged?.()
      } catch (error) {
        console.warn('[kyclaw] MCP 配置已落盘，但连接对齐失败（下一轮对话会再对齐）', error)
      }
      return `已移除 MCP 服务「${target.name}」（id: ${id}）；它的工具立刻不再出现。`
    }
  })
}
