/**
 * kyclaw agent 的装配（身份 + 模型 + 工具集 + 记忆）。
 *
 * 工具集（T11 + round28 模块 1 + 模块 4）：文件工具五件套（read/write/edit/glob/grep）+
 * bash / fetch / delete / move + git 五件套（git_status/git_diff/git_log/git_add/git_commit）
 * + 产出物五件（create_report/create_pdf/create_excel/create_ppt/create_docx），
 * 全部经 guard 装配——文件工具与产出物路径只认授权工作区（T10 的 realpath 引擎）；bash / fetch / git
 * 的"能力"审批在 guard.needsApproval 的 capability 分支（默认问；(工具×工作区) 规则与
 * mode='full' 工作区都可豁免 —— round28 用户口径：开了「完全访问」就不再为 bash/fetch 弹卡）；
 * 写类按 spec §5.2 挂审批（requireApproval）。
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
 * shell 口径（round 33）：bash 工具的**描述**与系统指令末尾那行 shell 说明都按当前解析出来的
 * shell 现算（Git Bash 优先，没有就回落 PowerShell，见 main/git-bash.ts 的 resolveShell）——
 * 所以 bash 工具在下面的 `tools` 函数里创建、instructions 用函数形态（都是每轮现取）。
 *
 * Agent 类是 ESM-only（@mastra/core），所以工厂是异步的：运行时靠动态 import() 拿。
 */
import type { Agent } from '@mastra/core/agent'
import type { Tool } from '@mastra/core/tools'
import type { MastraMemory } from '@mastra/core/memory'
import type { Project } from '../../shared/projects'
import type { PermissionRule, McpServerConfig, Workspace } from '../../shared/settings'
import { sessionRoots } from '../../main/projects'
import { currentShell, type ResolvedShell } from '../../main/git-bash'
import { createToolContext, needsApproval } from '../tools/guard'
import { createBashTool, shellGuidance } from '../tools/bash'
import { createDeleteTool } from '../tools/delete'
import { createDocxTool } from '../tools/docx'
import { createEditTool } from '../tools/edit'
import { createExcelTool } from '../tools/excel'
import { createFetchTool } from '../tools/fetch'
import { createGitTools } from '../tools/git'
import { createGlobTool } from '../tools/glob'
import { createGrepTool } from '../tools/grep'
import { createMoveTool } from '../tools/move'
import { createPptTool } from '../tools/ppt'
import { createReadTool } from '../tools/read'
import { createPdfTool, createReportTool } from '../tools/report'
import { createWriteTool } from '../tools/write'
import type { PdfPrinter } from '../tools/artifacts'
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
  /**
   * 模块 4：PDF 打印钩子（HTML → PDF 字节）。**缺省 = 没有**（create_pdf 报"环境不支持"，
   * 其余产出物照常）。生产由 main/index.ts 注入 Electron printToPDF 的实现，测试注入 stub
   * —— 工具层不 import electron，这一层是唯一的注入点。
   */
  printPdf?: PdfPrinter
}

/** kyclaw 的身份与行为底线（与 shell 无关的部分；shell 口径见 shellGuidance） */
export const KYCLAW_INSTRUCTIONS = `你是 kyclaw，运行在用户自己电脑上的个人 AI agent。
- 默认用用户的语言回答（中文提问就用中文），先给结论，再给必要的细节。
- 你只能看到用户在这个对话里给你的内容；不确定就直说，不要编造事实或执行结果。
- 文件工具（read / write / edit / glob / grep / delete / move）与 git 工具只作用于当前会话的工作区（项目文件夹或默认工作区）。越界会直接失败：如实告诉用户失败原因，并给出下一步（改用 bash、把文件夹加进「设置 → 工作区」），不要反复换写法重试。
- bash 工具执行 shell 命令：默认在会话工作区里运行，可用 cwd 指向别处；适合跑测试、装依赖、编译、命令行操作。命令会占住调用直到结束，长驻服务请放到后台，不要前台常驻。
- 联网用 fetch 工具（GET/POST、自定义请求头）；要保存响应就带 save_to（落进工作区）。
- git 用 git_status / git_diff / git_log 查看（只读）；git_add / git_commit 提交改动；不做 push，需要推远端时请用户自己操作。
- 产出物按成品形态选工具，都落到当前会话工作区（相对路径；不给 path 就按标题派生文件名），返回文件路径与字节数：
  · create_report：排版好的单文件 HTML 报告（自带样式、离线可看、可打印）——说明性长文、方案、总结、带表格的盘点首选；
  · create_pdf：同样内容的 PDF（A4，走本机 Electron 排版导出）——要外发、打印或归档时用；
  · create_excel：.xlsx 工作簿（sheets[].rows 是二维单元格数组，数字保持数字）；
  · create_ppt：.pptx 演示文稿（每页标题 + 要点条目）；
  · create_docx：Word 文档（heading / paragraph / bullets / table 四种块，按顺序排）。
  报告与 PDF 的 html 是**真 HTML 片段**（不是 Markdown）：用 h2/h3、p、ul/ol、table、pre/code 写正文，
  不要写 <html>/<head>/<style> 外壳、不要重复一级标题（模板已经带上标题与样式）。
- 写类操作（write / edit / delete / move / bash / fetch / git_add / git_commit / create_report / create_pdf / create_excel / create_ppt / create_docx）执行前会弹给用户审批（工作区被设为「完全访问」时免审），也可能被拒绝——被拒绝就说清原因、换个做法，不要反复重试。删除 / 移动是危险操作，每次都会请求审批。
- 改文件前先用 read 看原文；替换局部内容用 edit，整文件重写用 write。`

/**
 * 每轮现算的完整系统指令（round 33）：静态底线 + **当前 shell 的口径**（`shellGuidance`）。
 * 本机装/卸 Git Bash 不该让助手一直拿错语法 —— 每轮重解析（探测成功才缓存），指令跟着走。
 */
export function kyclawInstructions(shell: ResolvedShell | null): string {
  return `${KYCLAW_INSTRUCTIONS}\n${shellGuidance(shell)}`
}

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
    grep: await createGrepTool(ctx),
    // bash 刻意不在这里建：它的描述要按"当前解析出来的 shell"给（Git Bash / 回落 PowerShell），
    // 所以放进下面每轮现取的 tools 函数里（round 33，与指令的现算口径一致）
    fetch: await createFetchTool(ctx),
    delete: await createDeleteTool(ctx),
    move: await createMoveTool(ctx),
    // 模块 4：产出物五件（报告 / PDF / Excel / PPT / Word）。printPdf 是主进程注入的钩子，
    // 没注入时 create_pdf 报"环境不支持"，其余四件不受影响（见 tools/artifacts.ts 头注）
    create_report: await createReportTool(ctx),
    create_pdf: await createPdfTool(ctx, toolOptions?.printPdf),
    create_excel: await createExcelTool(ctx),
    create_ppt: await createPptTool(ctx),
    create_docx: await createDocxTool(ctx),
    ...(await createGitTools(ctx))
  }

  // 内置与 MCP 共用同一个 gate：requireApproval 的判定是同一份 needsApproval
  const gate: McpToolGate = (tool, input) => needsApproval(ctx, tool, input)
  const mcpToolsFor = toolOptions?.mcpTools

  return new AgentClass({
    id: KYCLAW_AGENT_ID,
    name: KYCLAW_AGENT_ID,
    // 现算（round 33）：末尾那行"当前 shell 是什么、该怎么写"跟着解析结果走（装了 Git 就换口径）
    instructions: () => kyclawInstructions(currentShell()),
    model: () => resolveModel(),
    // 函数形态：每轮现取（MCP 设置改了、server 掉线重连，下一轮就反映出来；
    // bash 也在这一层建 —— 它的描述按当前 shell 给，见上）
    tools: async () => ({
      ...tools,
      bash: await createBashTool(ctx),
      ...((await mcpToolsFor?.(gate)) ?? {})
    }),
    ...(memory === undefined ? {} : { memory })
  })
}
