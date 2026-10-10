/**
 * 工具 part 的读取、状态文案与格式化（纯逻辑；渲染组件在 ToolCard.tsx）。
 *
 * 单独成模块的原因：react-refresh 要求组件文件只导出组件（T18 起就是这条纪律）。
 * 状态文案与语气口径见 ToolCard 头注（AI SDK 的 tool part 状态机，spec §7.1）。
 */
export interface ToolCardPart {
  toolName: string
  state: string
  input?: unknown
  output?: unknown
  errorText?: string
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

type MessagePart = {
  type?: unknown
  toolName?: unknown
  state?: unknown
  input?: unknown
  output?: unknown
  errorText?: unknown
}

/** 静态工具 part（tool-<name>）与动态工具 part（dynamic-tool）都算工具调用 */
export function isToolPart(part: { type?: unknown }): boolean {
  if (part.type === 'dynamic-tool') return true
  return typeof part.type === 'string' && part.type.startsWith('tool-')
}

/** 把 AI SDK 的 tool part 收成 ToolCard 认的形状（toolName / state / input / output / errorText） */
export function toToolCardPart(part: MessagePart): ToolCardPart | null {
  if (part.type === 'dynamic-tool') {
    if (typeof part.toolName !== 'string' || part.toolName === '') return null
    return {
      toolName: part.toolName,
      state: typeof part.state === 'string' ? part.state : 'unknown',
      input: part.input,
      output: part.output,
      errorText: typeof part.errorText === 'string' ? part.errorText : undefined
    }
  }
  if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) return null
  return {
    toolName: part.type.slice('tool-'.length),
    state: typeof part.state === 'string' ? part.state : 'unknown',
    input: part.input,
    output: part.output,
    errorText: typeof part.errorText === 'string' ? part.errorText : undefined
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
