/**
 * kyclaw agent 的装配（身份 + 模型 + 工具集 + 记忆）。
 *
 * 工具集（T11）：五个文件工具（read/write/edit/glob/grep），全部经 guard 装配——
 * 路径只认授权工作区（T10 的 realpath 引擎）、写类按 spec §5.2 挂审批（requireApproval）。
 * 工作区列表与"永久允许"规则（T13）都用**取值函数**传（现读设置）：用户中途加工作区、
 * 批准一条永久规则，下一轮工具就能用，不必重启服务。
 *
 * 工具的根（T18）：**按会话**取 —— 会话属于某项目就用那个项目的路径，没项目用默认工作区，
 * 都没有才用整份授权列表（口径与判据见 main/projects.ts 的 sessionRoots；会话→项目 的映射
 * 由 libsql 的 session_projects 表给，经 projectOf 同步读内存镜像）。工具执行时把
 * `sessionKey(context)`（agent 线程 id）传给 guard；**审批那一层拿不到会话**，用的是整份
 * 授权列表（超集，见 guard 的 WorkspaceRoots / needsApproval 头注）。
 *
 * MCP 外部工具（T12）：`tools` 用 Mastra 支持的**函数形态**（每轮现取），把
 * `mcpTools(gate)` 给的 `mcp__<server>__<tool>` 并进同一张工具表。审批走同一个 gate
 * （guard.needsApproval）：MCP 工具未标只读一律按写类询问；分级由 createMcpClassify 叠加
 * 设置里的"只读"标记（见 mastra/mcp.ts）。
 *
 * 模型走 Mastra 的 **DynamicArgument**（函数形式）：每次对话重新解析（读 settings + secrets），
 * 所以用户配好 provider/密钥后**不用重启**，下一轮就是真模型；配置半截时解析抛错，
 * 这一轮以错误卡收场——不静默回落 mock（T8 裁决）。
 *
 * memory（T9）：由 index.ts 建好注入（存储挂在 Mastra 实例上的 libsql）。
 * 工具的"未读先改"记录按会话（agent 线程）隔离，见 tools/guard.ts。
 *
 * Agent 类是 ESM-only（@mastra/core），所以工厂是异步的：运行时靠动态 import() 拿。
 */
import type { Agent } from '@mastra/core/agent'
import type { Tool } from '@mastra/core/tools'
import type { MastraMemory } from '@mastra/core/memory'
import type { Project } from '../../shared/projects'
import type { PermissionRule, McpServerConfig, Workspace } from '../../shared/settings'
import { sessionRoots } from '../../main/projects'
import { createToolContext, needsApproval } from '../tools/guard'
import { createEditTool } from '../tools/edit'
import { createGlobTool } from '../tools/glob'
import { createGrepTool } from '../tools/grep'
import { createReadTool } from '../tools/read'
import { createWriteTool } from '../tools/write'
import { createMcpClassify, type McpToolGate } from '../mcp'
import type { KyclawModel } from '../model'

/** agent id：chat 路由 /chat/kyclaw-agent 与 IPC 契约里都用它 */
export const KYCLAW_AGENT_ID = 'kyclaw-agent'

/** 每轮对话取一次模型（实现方自己决定读谁、怎么缓存） */
export type ModelResolver = () => Promise<KyclawModel>

/** 工具集需要的运行时信息（工作区/MCP 都现读；T12 的 MCP 工具并进同一份装配） */
export interface KyclawAgentTools {
  /** 授权工作区（缺省 = 没有工作区：文件工具会明确报"先去设置里添加"） */
  workspaces?: () => readonly Workspace[]
  /** T18：默认工作区（缺省 = 没指认：没项目的会话用整份授权列表） */
  defaultWorkspace?: () => string | null
  /** T18：项目清单（缺省 = 没有项目） */
  projects?: () => readonly Project[]
  /** T18：会话 → 项目 id（同步；缺省 = 没有映射） */
  projectOf?: (threadId: string) => string | null
  /** "永久允许"规则（缺省 = 没有规则：写类除 full 工作区外一律问） */
  permissionRules?: () => readonly PermissionRule[]
  /** MCP server 设置（缺省 = 没有：分级只看名字证据；只读标记来自这里） */
  mcpServers?: () => readonly McpServerConfig[]
  /**
   * 每轮现取的 MCP 工具（缺省 = 没有 MCP 工具）：由 lifecycle 提供，
   * 传进去的 gate 就是 guard.needsApproval 本身——内置与外部工具一条审批路径。
   */
  mcpTools?: (gate: McpToolGate) => Promise<Record<string, Tool>>
}

/** kyclaw 的身份与行为底线 */
export const KYCLAW_INSTRUCTIONS = `你是 kyclaw，运行在用户自己电脑上的个人 AI agent。
- 默认用用户的语言回答（中文提问就用中文），先给结论，再给必要的细节。
- 你只能看到用户在这个对话里给你的内容；不确定就直说，不要编造事实或执行结果。
- 文件工具（read / write / edit / glob / grep）只能在当前会话的工作区里使用（用户在侧栏给它指定的项目文件夹，或是默认工作区）。越界会直接失败：如实告诉用户，让他换个路径、把文件夹建/开成项目，或到「设置 → 工作区」里指定默认工作区，不要尝试绕过。
- 改文件前先用 read 看原文；write / edit 是写操作，执行前会弹给用户审批（也可能被拒绝）——被拒绝就说清原因、换个做法，不要反复重试同一处改动。`

export async function createKyclawAgent(
  resolveModel: ModelResolver,
  memory?: MastraMemory,
  toolOptions?: KyclawAgentTools
): Promise<Agent> {
  const { Agent: AgentClass } = await import('@mastra/core/agent')

  const serversFor = toolOptions?.mcpServers ?? (() => [])
  const workspacesFor = toolOptions?.workspaces ?? (() => [])
  const projectsFor = toolOptions?.projects ?? (() => [])
  const defaultWorkspaceFor = toolOptions?.defaultWorkspace ?? (() => null)
  const projectOf = toolOptions?.projectOf ?? (() => null)

  /**
   * 会话根（T18）：session 有值 = 工具执行口径（项目 → 默认工作区 → 授权列表）；
   * `session === undefined` = 审批口径（整份授权列表，见 guard.WorkspaceRoots 头注）。
   */
  const roots = (session: string | undefined): readonly Workspace[] => {
    if (session === undefined) return workspacesFor()
    return sessionRoots({
      workspaces: workspacesFor(),
      defaultWorkspace: defaultWorkspaceFor(),
      projects: projectsFor(),
      projectId: projectOf(session)
    })
  }

  const ctx = createToolContext({
    roots,
    // MCP 名走"只读标记"那一层（未标按写类询问）；其余名字与 T11 同一口径
    classify: createMcpClassify(serversFor),
    permissionRules: toolOptions?.permissionRules
  })
  const tools = {
    read: await createReadTool(ctx),
    write: await createWriteTool(ctx),
    edit: await createEditTool(ctx),
    glob: await createGlobTool(ctx),
    grep: await createGrepTool(ctx)
  }

  // 内置与 MCP 共用同一个 gate：requireApproval 的判定是同一份 needsApproval
  const gate: McpToolGate = (tool, input) => needsApproval(ctx, tool, input)
  const mcpToolsFor = toolOptions?.mcpTools

  return new AgentClass({
    id: KYCLAW_AGENT_ID,
    name: KYCLAW_AGENT_ID,
    instructions: KYCLAW_INSTRUCTIONS,
    model: () => resolveModel(),
    // 函数形态：每轮现取（MCP 设置改了、server 掉线重连，下一轮就反映出来）
    tools: async () => ({
      ...tools,
      ...((await mcpToolsFor?.(gate)) ?? {})
    }),
    ...(memory === undefined ? {} : { memory })
  })
}
