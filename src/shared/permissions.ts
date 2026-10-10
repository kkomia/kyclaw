/**
 * 权限规则（T13）："永久允许"的落点 —— 一条规则 = 某工具在某工作区里不再逐次询问。
 *
 * 归一与匹配放在 shared：**主进程**（guard.needsApproval 判要不要弹审批）与**渲染端**
 * （审批卡写设置、判按钮状态）必须用同一把尺，否则会出现"UI 说已永久允许、服务端还在问"。
 * 粒度就是 spec §5.2 的"工具 + 工作区"；危险类工具（删除/移动）不受规则影响（永远默认问，
 * 那条判断在 guard 里）。
 *
 * 工具名两把尺（T12 重审）：
 *   - `normalizeToolName` = **整名**（trim + 小写）：规则匹配与会话记忆用它。v1 曾取 `__` 最后一段，
 *     于是 `mcp__a__write` 与 `mcp__b__write` 会共享同一条规则、也和内置 `write` 混为一谈 ——
 *     一个外部工具能吃到用户给另一个工具（或内置工具）的"永久允许"，是实打实的越权。整名匹配后
 *     `mcp__<server>__<tool>` 只与它自己（及同一 server 的同名工具）相等。
 *   - `toolBasename` = `__` 最后一段：只给**分级**用（permission/classify），让 `mcp__shell__delete`
 *     仍能靠名字拿到达"危险类"这一保守信号；它不参与匹配，`mcp__a__write` 不会因为末段是 write
 *     就被当成内置 write 工具（工具身份判定见 main/permission/classify.isWorkspaceFileTool）。
 */
import type { PermissionRule } from './settings'

/** 规则匹配 / 会话记忆的工具名归一：整名，去空白、小写 */
export function normalizeToolName(tool: string): string {
  return tool.trim().toLowerCase()
}

/** 分级用的工具名末段：`mcp__server__tool` 取 `tool`；不含 `__` 的名字原样返回 */
export function toolBasename(tool: string): string {
  const trimmed = tool.trim()
  const last = trimmed.includes('__') ? (trimmed.split('__').at(-1) ?? trimmed) : trimmed
  return last.trim().toLowerCase()
}

/**
 * 工作区路径归一：分隔符统一成 `/`、去尾部分隔符、大小写归一。
 * 大小写不敏感是 Windows 口径（工作区路径进列表前已经过 realpath，写法差异只可能来自
 * 手改配置或渲染端的字符串拼接）；Linux 上同盘不同大小写的两个目录会判等，可接受。
 */
export function normalizeWorkspacePath(path: string): string {
  const slashed = path.trim().replace(/\\/g, '/')
  const withoutTail = slashed.replace(/\/+$/, '')
  return withoutTail.toLowerCase()
}

/** 一条规则是否覆盖这次调用（工具名归一后相等 + 工作区路径归一后相等） */
export function ruleMatches(rule: PermissionRule, tool: string, workspace: string): boolean {
  return (
    normalizeToolName(rule.tool) === normalizeToolName(tool) &&
    normalizeWorkspacePath(rule.workspace) === normalizeWorkspacePath(workspace)
  )
}

/** 授权规则表里有没有一条覆盖这次调用的允许规则 */
export function isAllowedByRules(
  rules: readonly PermissionRule[],
  tool: string,
  workspace: string
): boolean {
  return rules.some((rule) => ruleMatches(rule, tool, workspace))
}

/** 追加一条允许规则（已覆盖就不重复加）；返回新数组，不改入参 */
export function withAllowedRule(
  rules: readonly PermissionRule[],
  tool: string,
  workspace: string
): PermissionRule[] {
  if (rules.some((rule) => ruleMatches(rule, tool, workspace))) return [...rules]
  return [...rules, { tool: normalizeToolName(tool), workspace, mode: 'allow' }]
}
