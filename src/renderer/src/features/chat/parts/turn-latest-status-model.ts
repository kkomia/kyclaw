import { isToolPart } from './tool-part'
import type { TurnProcessEntry } from './TurnProcess'
import type { ApprovalOutcome } from '../b3-5/approval-outcome'

export function formatChineseDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${String(hours)}小时${String(minutes)}分${String(seconds)}秒`
  if (minutes > 0) return `${String(minutes)}分${String(seconds)}秒`
  return `${String(seconds)}秒`
}

/** DSH 装载指示器的三种 motion（bounce 3 点 / line 3 点 / orbit 4 点） */
export type StatusMotion = 'bounce' | 'line' | 'orbit'

/**
 * 状态行能看到的**真实阶段**（PB-032）。
 *
 * 只从 `TurnProcessEntry` 的 reasoning / tool part state 派生，不新增数据源、不编阶段：
 *   reasoning            → 正在分析请求
 *   input-streaming      → 正在准备工具调用
 *   input-available      → 正在调用工具
 *   approval-requested   → 等待审批
 *   approval-responded   → 审批已回应，继续处理
 *   output-available     → 正在处理工具结果
 *   output-error         → 工具出错，正在继续
 *   output-denied        → 工具被拒绝，正在继续
 * 无条目 → 正在处理；10s 无新输出 → 暂未响应（由组件层覆盖，不入本函数）。
 * `goal-round` 是 PB-039 落地后的条件档：调用方传入轮次才出现，当前无调用方 → 不渲染。
 */
export type StatusStageKey =
  | 'reasoning'
  | 'tool-preparing'
  | 'tool-running'
  | 'tool-approval'
  | 'tool-approval-done'
  | 'tool-result'
  | 'tool-error'
  | 'tool-denied'
  /** B3.5：审批四态（结果行同源；只有 rejected 可表达「你拒绝」） */
  | 'approval-allowed'
  | 'approval-rejected'
  | 'approval-cancelled'
  | 'approval-unavailable'
  | 'goal-round'
  | 'idle'

export interface StatusStage {
  key: StatusStageKey
  label: string
  /** 该阶段进入时的 motion（DSH：思维=bounce、工作=line、等待=orbit） */
  entryMotion: StatusMotion
}

const IDLE: StatusStage = { key: 'idle', label: '正在处理', entryMotion: 'bounce' }
const REASONING: StatusStage = {
  key: 'reasoning',
  label: '正在分析请求',
  entryMotion: 'bounce'
}

/** tool part 的真实 state → 阶段（只列 AI SDK 真实状态机里存在的档） */
const TOOL_STAGES: Record<string, StatusStage> = {
  'input-streaming': { key: 'tool-preparing', label: '正在准备工具调用', entryMotion: 'line' },
  'input-available': { key: 'tool-running', label: '正在调用工具', entryMotion: 'line' },
  'approval-requested': { key: 'tool-approval', label: '等待审批', entryMotion: 'orbit' },
  'approval-responded': {
    key: 'tool-approval-done',
    label: '审批已回应，继续处理',
    entryMotion: 'line'
  },
  'output-available': { key: 'tool-result', label: '正在处理工具结果', entryMotion: 'line' },
  'output-error': { key: 'tool-error', label: '工具出错，正在继续', entryMotion: 'line' },
  'output-denied': { key: 'tool-denied', label: '工具被拒绝，正在继续', entryMotion: 'line' }
}

/** B3.5：内核审批四态 → 状态行阶段（结果行同源；只要 rejected 可出现「你拒绝」） */
const APPROVAL_OUTCOME_STAGES: Record<ApprovalOutcome, StatusStage> = {
  'allowed-once': { key: 'approval-allowed', label: '已允许一次', entryMotion: 'line' },
  rejected: { key: 'approval-rejected', label: '你拒绝了这次操作', entryMotion: 'line' },
  cancelled: { key: 'approval-cancelled', label: '审批已取消', entryMotion: 'line' },
  unavailable: { key: 'approval-unavailable', label: '审批被自动拒绝', entryMotion: 'line' }
}

/** 工具 part 的状态（静态 `tool-*` 与 `dynamic-tool` 都有 state 字段） */
function toolStateOf(part: TurnProcessEntry['part']): string | null {
  if (!isToolPart(part)) return null
  const state = (part as { state?: unknown }).state
  return typeof state === 'string' ? state : null
}

/**
 * 最新一步阶段：从过程 entries 尾部向前找第一个 reasoning / tool。
 * @param entries 过程条目（TurnProcess 的输出）
 * @param goalRound 条件档：当前轮若是 goal 自动续跑，传轮次（PB-039 落地后接线）
 */
export function latestStepStage(
  entries: readonly TurnProcessEntry[],
  goalRound?: number
): StatusStage {
  if (goalRound !== undefined && goalRound > 0) {
    return {
      key: 'goal-round',
      label: `目标续跑 · 第 ${String(goalRound)} 轮`,
      entryMotion: 'line'
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const part = entries[index]?.part
    if (part === undefined) continue
    if (part.type === 'reasoning') return REASONING
    // B3.5：审批结果优先于工具 state（同一 part 既有 outcome 又有 approval-responded）
    const outcome = (part as { approvalOutcome?: ApprovalOutcome }).approvalOutcome
    if (outcome !== undefined) return APPROVAL_OUTCOME_STAGES[outcome]
    const state = toolStateOf(part)
    if (state === null) continue
    return TOOL_STAGES[state] ?? TOOL_STAGES['input-available']!
  }
  return IDLE
}

/** 兼容旧入口：只取文案（测试/其他地方仍可用） */
export function latestStepLabel(entries: readonly TurnProcessEntry[]): string {
  return latestStepStage(entries).label
}

/**
 * entries 的「新输出」签名：stage + 条数 + 末条文本长度 / 工具状态。
 * 用途：10s「暂未响应」的超时只在「签名不变」时成立（流式增长会不断改签名）。
 */
export function entriesSignature(entries: readonly TurnProcessEntry[]): string {
  const last = entries[entries.length - 1]?.part as
    { type?: string; text?: string; state?: string } | undefined
  const text = typeof last?.text === 'string' ? last.text.length : 0
  return `${String(entries.length)}:${last?.type ?? ''}:${last?.state ?? ''}:${String(text)}`
}
