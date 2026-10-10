/**
 * 工具分级（spec §5.2 权限模型）：只读默认放行、写类默认询问、移动/删除永远默认问。
 *
 * 分类**只看工具名**（T11 定名、T12 的 MCP 名字是 `mcp__<server>__<tool>`），按 `__` 取最后一段
 * （`toolBasename`）再查表：`mcp__shell__delete` 仍会落到"危险类"这一保守档。
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
  move: 'dangerous'
}

/** 没在表里的工具（含 MCP 里未标只读的那些）按写类处理：默认问一次，不静默放行 */
const DEFAULT_CLASS: ToolClass = 'write'

/**
 * 内置文件工具五件套（T11）：执行路径**必过引擎**（guard.toolTarget/scanRoot）——
 * 目标解析不到时执行即拒（fail closed），所以 guard 对"写类 + 目标不可解析"的不问策略
 * 只对它们成立。判身份用**整名**：`mcp__a__write` 末段虽是 write，也不在这里。
 */
const WORKSPACE_FILE_TOOLS = new Set(['read', 'glob', 'grep', 'write', 'edit'])

export function classifyToolCall(tool: string, input?: unknown): ToolClass {
  void input
  return TOOL_CLASSES[toolBasename(tool)] ?? DEFAULT_CLASS
}

/** 是不是内置工作区文件工具（整名判定；`mcp__server__tool` 一概不是） */
export function isWorkspaceFileTool(tool: string): boolean {
  return WORKSPACE_FILE_TOOLS.has(tool.trim().toLowerCase())
}
