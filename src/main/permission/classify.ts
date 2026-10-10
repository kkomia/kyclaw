/**
 * 工具分级（spec §5.2 权限模型）：只读默认放行、写类默认询问、移动/删除永远默认问。
 *
 * 分类**只看工具名**：内置工具在 T11 定名（read/glob/grep、write/edit），MCP 工具名是
 * `mcp__<server>__<tool>`（T12），所以先按 `__` 取最后一段，再查这张表。
 * 未知名字保守地落在 **write**：那是"默认询问"的一档，不会静默放行；
 * 唯一的静默放行口子是用户在工作区上显式打开的 Full access（T13）。
 *
 * `input` 是 T11/T12 的调用点要求带的工具入参（分类将来若需要按参数细分，就从这里读），
 * 现在不含任何判定 —— 显式 `void` 掉，免得后来人以为它"本该被用上"。
 */
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
  return TOOL_CLASSES[baseToolName(tool)] ?? DEFAULT_CLASS
}

/** 工具名归一：`mcp__server__tool` 取最后一段；去空白、小写 */
function baseToolName(tool: string): string {
  const trimmed = tool.trim()
  const last = trimmed.includes('__') ? (trimmed.split('__').at(-1) ?? trimmed) : trimmed
  return last.trim().toLowerCase()
}
