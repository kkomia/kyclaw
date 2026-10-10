/**
 * kyclaw agent 的装配（身份 + 模型 + 工具集 + 记忆）。
 *
 * 工具集（T11）：五个文件工具（read/write/edit/glob/grep），全部经 guard 装配——
 * 路径只认授权工作区（T10 的 realpath 引擎）、写类按 spec §5.2 挂审批（requireApproval）。
 * 工作区列表与"永久允许"规则（T13）都用**取值函数**传（现读设置）：用户中途加工作区、
 * 批准一条永久规则，下一轮工具就能用，不必重启服务。
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
import type { MastraMemory } from '@mastra/core/memory'
import type { PermissionRule, Workspace } from '../../shared/settings'
import { classifyToolCall } from '../../main/permission/classify'
import { createToolContext } from '../tools/guard'
import { createEditTool } from '../tools/edit'
import { createGlobTool } from '../tools/glob'
import { createGrepTool } from '../tools/grep'
import { createReadTool } from '../tools/read'
import { createWriteTool } from '../tools/write'
import type { KyclawModel } from '../model'

/** agent id：chat 路由 /chat/kyclaw-agent 与 IPC 契约里都用它 */
export const KYCLAW_AGENT_ID = 'kyclaw-agent'

/** 每轮对话取一次模型（实现方自己决定读谁、怎么缓存） */
export type ModelResolver = () => Promise<KyclawModel>

/** 工具集需要的运行时信息（工作区现读；T12 的 MCP 工具会并进同一份装配） */
export interface KyclawAgentTools {
  /** 授权工作区（缺省 = 没有工作区：文件工具会明确报"先去设置里添加"） */
  workspaces?: () => readonly Workspace[]
  /** "永久允许"规则（缺省 = 没有规则：写类除 full 工作区外一律问） */
  permissionRules?: () => readonly PermissionRule[]
}

/** kyclaw 的身份与行为底线 */
export const KYCLAW_INSTRUCTIONS = `你是 kyclaw，运行在用户自己电脑上的个人 AI agent。
- 默认用用户的语言回答（中文提问就用中文），先给结论，再给必要的细节。
- 你只能看到用户在这个对话里给你的内容；不确定就直说，不要编造事实或执行结果。
- 文件工具（read / write / edit / glob / grep）只能在用户授权的工作区内使用。越界会直接失败：如实告诉用户，请他在「设置 → 工作区」里添加文件夹，不要尝试绕过。
- 改文件前先用 read 看原文；write / edit 是写操作，执行前会弹给用户审批（也可能被拒绝）——被拒绝就说清原因、换个做法，不要反复重试同一处改动。`

export async function createKyclawAgent(
  resolveModel: ModelResolver,
  memory?: MastraMemory,
  toolOptions?: KyclawAgentTools
): Promise<Agent> {
  const { Agent: AgentClass } = await import('@mastra/core/agent')

  const ctx = createToolContext({
    roots: toolOptions?.workspaces ?? (() => []),
    classify: classifyToolCall,
    permissionRules: toolOptions?.permissionRules
  })
  const tools = {
    read: await createReadTool(ctx),
    write: await createWriteTool(ctx),
    edit: await createEditTool(ctx),
    glob: await createGlobTool(ctx),
    grep: await createGrepTool(ctx)
  }

  return new AgentClass({
    id: KYCLAW_AGENT_ID,
    name: KYCLAW_AGENT_ID,
    instructions: KYCLAW_INSTRUCTIONS,
    model: () => resolveModel(),
    tools,
    ...(memory === undefined ? {} : { memory })
  })
}
