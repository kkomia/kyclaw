/**
 * 工具 part 的读取、状态文案与格式化（纯逻辑；渲染组件在 ToolCard.tsx）。
 *
 * 单独成模块的原因：react-refresh 要求组件文件只导出组件（T18 起就是这条纪律）。
 * 状态文案与语气口径见 ToolCard 头注（AI SDK 的 tool part 状态机，spec §7.1）。
 *
 * round 75：MCP 工具改成每台 server 一个元工具（`mcp__<serverId>__meta`）之后，工具卡要认的是
 * **被调用的真名与真入参**，壳由 `toToolCardPart` 剥掉（原读取逻辑原样留在 rawToolCardPart）。
 */
import { resolveMcpToolCallInput, resolveMcpToolCallName } from '@shared/mcp'
import type { ApprovalOutcome } from '../b3-5/approval-outcome'
import type { AskUserState } from '../b3-5/ask-user-state'

export interface ToolCardPart {
  toolName: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
  /** B3.5：内核审批四态（有才渲染结果行；旧消息没有该字段 → 行为与现在一致） */
  approvalOutcome?: ApprovalOutcome
  approvalCause?: string
  approvalAt?: number
  approvalAppClosed?: boolean
  /** B3.5：提问侧状态（等待/超时仍可答/迟到回答/已 settle） */
  askUserState?: AskUserState
  askUserRemainingMs?: number
  askUserAnswerSummary?: string
}

/** 结果预览上限（文档《对话UI-工具链与显示口径 v0.1》§5.1：600 字，超了只切、不提示） */
export const RESULT_PREVIEW_CHARS = 600

/** 逐档状态文案（input-available 分开合两种说法：轮次结束后还停在这是"调用过没回执"） */
export const STATE_LABELS: Record<string, string> = {
  'input-streaming': '准备参数',
  'input-available': '调用中',
  'approval-requested': '等待审批',
  'approval-responded': '审批已回应',
  'output-available': '已完成',
  'output-error': '出错',
  'output-denied': '已拒绝'
}

/** 状态语气（决定状态签的取色）：进行中=中性、等审批=警告、出错/被拒=危险、完成=中性 */
export type ToolTone = 'pending' | 'waiting' | 'error'

export const STATE_TONES: Record<string, ToolTone> = {
  'approval-requested': 'waiting',
  'approval-responded': 'waiting',
  'output-error': 'error',
  'output-denied': 'error'
}

export const TONE_CLASS: Record<ToolTone, string> = {
  pending: 'text-ink-tertiary',
  waiting: 'text-warning',
  error: 'text-danger'
}

/** 从工具输出/错误文本解析命令退出码（bash/git 尾部 `[退出码 N]`；`[退出码 未知]` 也认）。 */
export function toolExitCodeOf(text: unknown): number | 'unknown' | null {
  if (typeof text !== 'string') return null
  const match = /\[退出码\s*([^\]]+)\]/.exec(text)
  if (match === null) return null
  const raw = (match[1] ?? '').trim()
  if (raw === '' || raw === '未知') return 'unknown'
  const code = Number(raw)
  return Number.isFinite(code) ? code : 'unknown'
}

export interface ToolStatusLabel {
  label: string
  tone: ToolTone
  show: boolean
}

/**
 * task-115：成功完成不显示状态签；进行中/等待态照旧；失败（output-error/denied，或
 * output-available 但退出码非 0/未知）才显示危险色签，优先用「退出码 N」。
 */
export function toolStatusLabelOf(part: {
  state: string
  output?: unknown
  errorText?: string
}): ToolStatusLabel {
  const state = part.state
  if (state === 'output-denied') return { label: '已拒绝', tone: 'error', show: true }
  if (state === 'output-error') {
    const code = toolExitCodeOf(part.errorText) ?? toolExitCodeOf(part.output)
    return code === null
      ? { label: '出错', tone: 'error', show: true }
      : { label: `退出码 ${String(code)}`, tone: 'error', show: true }
  }
  if (state === 'output-available') {
    const code = toolExitCodeOf(part.output)
    if (code !== null && code !== 0) {
      return { label: `退出码 ${String(code)}`, tone: 'error', show: true }
    }
    return { label: '', tone: 'pending', show: false }
  }
  return { label: STATE_LABELS[state] ?? state, tone: STATE_TONES[state] ?? 'pending', show: true }
}

type MessagePart = {
  type?: unknown
  toolName?: unknown
  state?: unknown
  input?: unknown
  output?: unknown
  errorText?: unknown
  /** B3.5（内核 seam）：审批四态与提问状态由适配层塞进 part，旧 part 没有这些字段 */
  approvalOutcome?: unknown
  approvalCause?: unknown
  approvalAt?: unknown
  approvalAppClosed?: unknown
  askUserState?: unknown
  askUserRemainingMs?: unknown
  askUserAnswerSummary?: unknown
}

const OUTCOME_VALUES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const
const ASK_STATE_VALUES = ['waiting', 'timed-out', 'late-answer', 'settled', 'unavailable'] as const

/** B3.5 可选字段透传（形状不对就当没有，不猜） */
function b35FieldsOf(part: MessagePart): Partial<ToolCardPart> {
  const fields: Partial<ToolCardPart> = {}
  if (
    typeof part.approvalOutcome === 'string' &&
    (OUTCOME_VALUES as readonly string[]).includes(part.approvalOutcome)
  ) {
    fields.approvalOutcome = part.approvalOutcome as ToolCardPart['approvalOutcome']
  }
  if (typeof part.approvalCause === 'string' && part.approvalCause !== '')
    fields.approvalCause = part.approvalCause
  if (typeof part.approvalAt === 'number' && Number.isFinite(part.approvalAt))
    fields.approvalAt = part.approvalAt
  if (part.approvalAppClosed === true) fields.approvalAppClosed = true
  if (
    typeof part.askUserState === 'string' &&
    (ASK_STATE_VALUES as readonly string[]).includes(part.askUserState)
  ) {
    fields.askUserState = part.askUserState as ToolCardPart['askUserState']
  }
  if (typeof part.askUserRemainingMs === 'number' && Number.isFinite(part.askUserRemainingMs)) {
    fields.askUserRemainingMs = part.askUserRemainingMs
  }
  if (typeof part.askUserAnswerSummary === 'string' && part.askUserAnswerSummary !== '') {
    fields.askUserAnswerSummary = part.askUserAnswerSummary
  }
  return fields
}

/** 静态工具 part（tool-<name>）与动态工具 part（dynamic-tool）都算工具调用 */
export function isToolPart(part: { type?: unknown }): boolean {
  if (part.type === 'dynamic-tool') return true
  return typeof part.type === 'string' && part.type.startsWith('tool-')
}

/**
 * 原始读取（未解包）：把 AI SDK 的 tool part 收成 ToolCard 认的形状
 * （toolName / state / input / output / errorText）。round 75 拆出来时**逻辑一字未改**，
 * 只让 toToolCardPart 在外面套一层元工具解包。
 */
function rawToolCardPart(part: MessagePart): ToolCardPart | null {
  if (part.type === 'dynamic-tool') {
    if (typeof part.toolName !== 'string' || part.toolName === '') return null
    return {
      toolName: part.toolName,
      state: typeof part.state === 'string' ? part.state : 'unknown',
      input: part.input,
      output: part.output,
      errorText: typeof part.errorText === 'string' ? part.errorText : undefined,
      ...b35FieldsOf(part)
    }
  }
  if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) return null
  return {
    toolName: part.type.slice('tool-'.length),
    state: typeof part.state === 'string' ? part.state : 'unknown',
    input: part.input,
    output: part.output,
    errorText: typeof part.errorText === 'string' ? part.errorText : undefined,
    ...b35FieldsOf(part)
  }
}

/**
 * 工具卡认的形状：MCP 元工具（`mcp__<serverId>__meta`，round 75「渐进披露」）的 `call` 剥成
 * **被调用的真名与真入参**。工具卡按工具名判图标、显「服务名 · 工具名」、算行详情与入参面板，
 * 用户不该看见"一个 server 一个壳"这层内部结构 —— 服务端的闸门本来就在真名上工作
 * （见 shared/mcp 的 resolveMcpToolCallName / resolveMcpToolCallInput）。
 * 不是元工具 / 不是 call / 形状不对 → 原样返回（认不出就不猜）。
 */
export function toToolCardPart(part: MessagePart): ToolCardPart | null {
  const raw = rawToolCardPart(part)
  if (raw === null) return null
  return {
    ...raw,
    toolName: resolveMcpToolCallName(raw.toolName, raw.input),
    input: resolveMcpToolCallInput(raw.toolName, raw.input)
  }
}

/** 状态是不是"进行中的调用"（决定 input-available 显示"调用中"还是"已调用"、要不要流光） */
export function toolStateRunning(state: string): boolean {
  return state === 'input-streaming' || state === 'input-available'
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 行详情：入参里最像"目标"的那个字符串（path → pattern → query），单行省略展示 */
export function toolDetailOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const record = input as { path?: unknown; pattern?: unknown; query?: unknown }
  for (const key of ['path', 'pattern', 'query'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return null
}

/**
 * 结果预览：格式化后的文本恒定切 600 **码点**（超了只切、不提示、无出口）。
 * 用码点而不是 UTF-16 码元切（T16 小修批）：否则第 600 位正好是星平面字符时会吐半个代理对。
 */
export function previewOutput(value: unknown): string {
  const text = formatValue(value)
  // 码元都不超上限 → 码点更不超，直接返回（省掉一次码点数组）
  if (text.length <= RESULT_PREVIEW_CHARS) return text
  return Array.from(text).slice(0, RESULT_PREVIEW_CHARS).join('')
}

export { formatValue }
