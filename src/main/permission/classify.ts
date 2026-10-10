/**
 * 工具分级（spec §5.2 权限模型）：只读默认放行、写类默认询问、移动/删除永远默认问。
 *
 * 分类**只看工具名**：内置工具在 T11 定名（read/glob/grep、write/edit），MCP 工具名是
 * `mcp__<server>__<tool>`（T12），所以先按 `__` 取最后一段（normalizeToolName，和审批规则的
 * 匹配共用同一把尺），再查这张表。
 * 未知名字保守地落在 **write**：那是"默认询问"的一档，不会静默放行；
 * 静默放行只来自用户的显式动作 —— 工作区上的 Full access 或审批卡里"永久允许"落下的规则（T13）。
 *
 * `input` 是 T11/T12 的调用点要求带的工具入参（分类将来若需要按参数细分，就从这里读），
 * 现在不含任何判定 —— 显式 `void` 掉，免得后来人以为它"本该被用上"。
 */
import { normalizeToolName } from '../../shared/permissions'

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

export function classifyToolCall(tool: string, input?: unknown): ToolClass {
  void input
  return TOOL_CLASSES[normalizeToolName(tool)] ?? DEFAULT_CLASS
}
