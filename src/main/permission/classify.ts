/**
 * 工具分级（spec §5.2 权限模型）：只读默认放行、写类默认询问、移动/删除永远默认问。
 *
 * 分类**只看工具名**（T11 定名、T12 的 MCP 名字是 `mcp__<server>__<tool>`），按 `__` 取最后一段
 * （`toolBasename`）再查表：`mcp__shell__delete` 仍会落到"危险类"这一保守档。
 *
 * round28 模块 1 新增：`bash` / `fetch` 按**写类**（默认问；它们能碰工作区之外的东西，read 档太松）；
 * `git_status` / `git_diff` / `git_log` 只读（git 自己不写索引）；`git_add` / `git_commit` 写类。
 *
 * 模块 4 新增：产出物五件（create_report / create_pdf / create_excel / create_ppt / create_docx）
 * 按**写类**，且与内置文件工具同属"执行必过引擎"那一档（见下面的 WORKSPACE_FILE_TOOLS）。
 *
 * 这个函数不认识设置（纯名字 → 三档），所以它对 MCP 名字的分级只是**名字证据**：
 * 末段是 read/glob/grep 也照样回 'read'。MCP 工具"未标只读默认按写类询问"的口径由
 * `mastra/mcp.ts` 的 `createMcpClassify` 叠加（标了只读才 read；未标按写，末段是 delete/move 保留危险档）。
 *
 * 未知名字保守地落在 **write**：那是"默认询问"的一档，不会静默放行；
 * 静默放行只来自用户的显式动作 —— 工作区上的 Full access、审批卡里"永久允许"落下的规则（T13）、
 * 或 MCP 设置里对单个工具的"只读"标记（T12）。
 *
 * `input` 是 T11/T12 的调用点要求带的工具入参（分类将来若需要按参数细分，就从这里读），
 * 现在不含任何判定 —— 显式 `void` 掉，免得后来人以为它"本该被用上"。
 */
import { toolBasename } from '../../shared/permissions'

export type ToolClass = 'read' | 'write' | 'dangerous'

const TOOL_CLASSES: Record<string, ToolClass> = {
  read: 'read',
  glob: 'read',
  grep: 'read',
  write: 'write',
  edit: 'write',
  delete: 'dangerous',
  move: 'dangerous',
  // round28 模块 1：命令 / 网络 / git 四档。bash 与 fetch 都按**写类**（默认问）——
  // bash 能碰机器上的任何东西、fetch 能把数据发到任何地址，read 档意味着静默放行，
  // 对这两件能力都太松（保守优先，报告里有取舍说明）。
  bash: 'write',
  fetch: 'write',
  // git 只读三件套是真只读（git 自己不写索引）；add / commit 动仓库，按写类
  git_status: 'read',
  git_diff: 'read',
  git_log: 'read',
  git_add: 'write',
  git_commit: 'write',
  // 模块 4：产出物五件（报告 / PDF / Excel / PPT / Word）。都是"往工作区落一个文件"，
  // 与 write 同档（默认问；目标工作区 full 或命中"永久允许"规则才免审）
  create_report: 'write',
  create_pdf: 'write',
  create_excel: 'write',
  create_ppt: 'write',
  create_docx: 'write'
}

/** 没在表里的工具（含 MCP 里未标只读的那些）按写类处理：默认问一次，不静默放行 */
const DEFAULT_CLASS: ToolClass = 'write'

/**
 * 内置文件工具五件套（T11）：执行路径**必过引擎**（guard.toolTarget/scanRoot）——
 * 目标解析不到时执行即拒（fail closed），所以 guard 对"写类 + 目标不可解析"的不问策略
 * 只对它们成立。判身份用**整名**：`mcp__a__write` 末段虽是 write，也不在这里。
 *
 * 模块 4 的产出物五件同属这一档：它们只写"guard 解析出来的那个绝对路径"，
 * 目标不可解析时执行同样 fail closed（工具层先 toolTarget 再渲染/落盘），所以按同一口径判审批
 * —— 否则 `mode='full'` 的工作区里写文件免审、生成报告却要弹卡，同一件事两套规则说不通。
 */
const WORKSPACE_FILE_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'write',
  'edit',
  'create_report',
  'create_pdf',
  'create_excel',
  'create_ppt',
  'create_docx'
])

export function classifyToolCall(tool: string, input?: unknown): ToolClass {
  void input
  return TOOL_CLASSES[toolBasename(tool)] ?? DEFAULT_CLASS
}

/** 是不是内置工作区文件工具（整名判定；`mcp__server__tool` 一概不是） */
export function isWorkspaceFileTool(tool: string): boolean {
  return WORKSPACE_FILE_TOOLS.has(tool.trim().toLowerCase())
}
