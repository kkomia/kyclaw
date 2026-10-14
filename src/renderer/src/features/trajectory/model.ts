/**
 * 轨迹投影（纯函数）：把**存储消息 + 逐轮用量 + 压缩记录**折成一张可看、可点、可导出的
 * 「步骤表 + 时间轴」数据面。
 *
 * ## 原料里到底有什么（先查实现再写，见报告）
 *
 * `mastra_messages.content` 是 `{ format, parts[] }`，每个 part 实测都带数字时间戳
 * （本机 477 个 part 全有，无一例外）：
 *   - `step-start`  → `{ createdAt, model }`：**一步的起点**（Mastra 在下一步开始时写它）
 *   - `text` / `reasoning` → `{ createdAt }`：模型这一块输出落下的时刻
 *   - `tool-invocation` → `{ toolInvocation: { state, args, result, toolName, toolCallId, isError } , updatedAt }`
 *                        —— **入参与结果都是完整的**，`updatedAt` = 这一 part 最后一次写入的时刻。
 *                        round 75：MCP 元工具（`mcp__<serverId>__meta`）的 `call` 在这里就解包成
 *                        真名与真入参（否则行与导出里全是元工具名 + `{action,tool,args}` 这层壳）
 *   - `file` → 附件
 *   消息行的 `createdAt` 是**这一条消息写完的时刻**（≈ 该次 run 收尾）。
 *   消息 `metadata` 里有 `modelId` / `provider`（部分有 `traceId`）。
 *
 * `usage_runs` 一行 = 一次 run 的账（`created_at` 是**落账时刻**，落在该轮的时间窗内）。
 *
 * ## 时刻与时长是怎么算的（**推导口径**，不是从服务端要来的新字段）
 *
 * 存储里没有"请求发出时刻 / 首 token 时刻"这两种点，只有**内容落下的时刻**。所以：
 *   - 一轮（turn）= 一条用户消息起，到下一轮用户消息前；
 *   - 一步（step）= 一条助手消息里的 `step-start` 切出来的一段；**步起点** = 本步的
 *     `step-start.createdAt`（第 1 步没有这个标记时，取**上一个事件的时刻**——用户消息或
 *     上一条助手消息写完的时刻）；**步终点** = 下一步 `step-start` 的时刻，最后一步取本消息
 *     的 `createdAt`。两端都在手才算时长；
 *   - 工具调用：**起点** = 同一段里紧挨在它前面那个带时间戳的 part（模型把这次调用吐出来的
 *     时刻），**终点** = 这一 part 的 `updatedAt`（结果落下的时刻）。两端都在手才算时长；
 *   - 时间戳缺一个就不算时长（`durationMs = null`）——**不填 0 冒充"瞬间完成"**，界面上显示"未记录"。
 *
 * 于是 `timingSource` 只有两种取值，说的是**这一行的时间信息从哪来**：
 *   - `'session'`：至少有一头是记录下来的时刻（"会话时间戳"口径 —— 不是 provider 报的请求计时）；
 *   - `'none'`：两头都没有。
 * 它与"有没有时长"是**两件事**：用户消息、还没收尾的调用都落在 `'session'` 上（时刻记录了），
 * 但没时长（一个是瞬时事件，一个还没结束）—— `durationMs` 为 null，界面照实写"未记录"。
 *
 * ## 两条实测校正（真库跑出来才发现的，写在这里免得回退）
 *
 *   - **步号在轮内连续**：一轮可能落成好几条助手消息（Mastra 的 response boundary），
 *     编号按消息各自从 1 起会让同一轮出现两组"步骤 1 / 步骤 2"，与折叠摘要里数的步骤数对不上；
 *   - **消息的结束时刻取"最后一个 part 的时刻"**：`mastra_messages.createdAt` 是**行插入时刻**，
 *     后续 part 还会写进这一行（实测比它内部的 step-start 还早），拿它当"写完的时刻"会把时长
 *     算成 0 甚至负数。行时刻只在整条消息一个带时间戳的 part 都没有时才当兜底。
 *
 * ## 不编造的两处
 *
 *   - **系统提示词**：存储里没有它（Mastra 只存 user/assistant 消息，实测 role 只有这两种），
 *     所以投影里**不生成 `系统` 行**——`textKind` 支持它只是为了让"将来真有这种 part"时不必改结构；
 *   - **TTFT / 逐请求 token**：没有首 token 时刻、也没有逐 step 的 usage，明细里如实留白。
 */
import type { CompactionLevel, StoredMessage, ThreadCompaction } from '@shared/threads'
import type { TrajectoryUsageRun } from '@shared/trajectory'
import { resolveMcpToolCallInput, resolveMcpToolCallName } from '@shared/mcp'
import { projectTodoOutput } from '../chat/task-history'

/** 行的类型（取值口径对齐 dsh 的 kind 词汇；`system` 见头注的"不编造"） */
export type TrajectoryKind = 'system' | 'user' | 'context' | 'compacted' | 'message' | 'tool'

/** 行的类型 → 界面上的词（列表标签、搜索、导出共用一处口径） */
export const KIND_LABEL: Readonly<Record<TrajectoryKind, string>> = {
  system: '系统',
  user: '用户',
  context: '上下文',
  compacted: '已压缩',
  message: '助手',
  tool: '工具'
}

/**
 * 压缩记录的档位（round 76 起四档；缺 level = round 75 之前的老记录 = 摘要档，
 * 与 src/mastra/compaction.ts 的读侧归一同一口径）。
 */
function compactionLevelOf(compaction: ThreadCompaction): CompactionLevel {
  return compaction.level ?? 'summary'
}

/** 档位 → 轨迹行里"对那几条做了什么"的说法（列表第二列与导出共用） */
export const COMPACT_VERB: Readonly<Record<CompactionLevel, string>> = {
  snip: '已精简',
  dedupe: '已去重',
  fold: '已折叠',
  summary: '已摘要'
}

/** 档位 → 明细「来源」一栏的说法 */
export const COMPACT_SOURCE: Readonly<Record<CompactionLevel, string>> = {
  snip: '精简',
  dedupe: '去重',
  fold: '折叠',
  summary: '压缩'
}

/** 时长是不是"从记录下来的时刻倒推"的（界面据此标注计时来源） */
export type TrajectoryTimingSource = 'session' | 'none'

/** 轮级用量（一轮可能落了好几行账，这里合起来给界面看） */
export interface TrajectoryUsage {
  /** 该轮**所有模型调用**的输入合计（= 计费口径的输入，不是上下文大小） */
  input: number
  output: number
  total: number
  /** provider 报的缓存命中输入；一行都没报 = null（**不是 0**） */
  cachedInput: number | null
  /**
   * 该轮结束时**真实的上下文大小**（最后一次调用的输入 tokens）。
   * 记账线没有这一列 / 老记录 → null（**不拿 input 顶替**）。
   */
  contextInput: number | null
  /** 该轮一共调了几次模型；没有 → null */
  steps: number | null
  /** 有价部分的合计；一行都没价 = null */
  cost: number | null
  /** 参与合计的模型 id（去重，按出现顺序） */
  models: string[]
  /** 这一轮落了几行账（>1 = 这一轮跑了不止一次 run） */
  runs: number
}

export interface TrajectoryRow {
  /** 稳定序号（0 起，时间序）——列表、时间轴、选中态都用它 */
  index: number
  kind: TrajectoryKind
  /** 轮次号（1 起）；不属于任何轮（首条用户消息之前的记录）= null */
  turn: number | null
  /** 该轮内的步骤号（1 起）；不属于任何步（用户消息、压缩记录）= null */
  step: number | null
  /** 列表第二列的正文摘要（一行） */
  text: string
  /** 预览用的正文原文（助手 / 用户 / 压缩摘要）；没有 = null */
  body: string | null
  /** 思考原文（助手行）；没有 = null */
  thinking: string | null
  toolName: string | null
  toolCallId: string | null
  /** 工具入参原文（pretty JSON）；没捕获 = null */
  inputRaw: string | null
  /** 工具结果原文（字符串结果原样；结构化结果转 pretty JSON）；没捕获 = null */
  outputRaw: string | null
  isError: boolean
  /** 这一步还没收尾（等审批 / 半截）——界面显示"进行中"且**不给时长** */
  pending: boolean
  interactionStatus?: 'waiting' | 'answered' | 'cancelled'
  taskRevision?: number
  /** 模型 id（助手行 / 工具行所属的步）；没有 = null */
  modelId: string | null
  /** 记录到的开始 / 结束时刻（epoch ms）；拿不到 = null */
  startedAt: number | null
  endedAt: number | null
  /** 时长（ms）；两端缺一即 null */
  durationMs: number | null
  timingSource: TrajectoryTimingSource
  /** 本轮用量（同一轮的行拿的是同一份，界面按"本轮用量"标注） */
  usage: TrajectoryUsage | null
  /** 这一行的原始条目 JSON（明细「原始内容」用） */
  raw: string | null
  /** 数据来源的人话标签（明细「概述」的"来源"一栏） */
  source: string
}

export interface TrajectoryTurn {
  /** 轮次号（1 起） */
  turn: number
  /** 该轮第一条用户消息的原文（列表表头 / 折叠摘要的素材） */
  prompt: string
  startedAt: number | null
  endedAt: number | null
  /** 去重后的步骤数（折叠摘要的"N 个步骤"） */
  steps: number
  /** 工具调用条数（折叠摘要的"M 个工具调用"） */
  toolCalls: number
  usage: TrajectoryUsage | null
  /** 该轮的行序号（升序） */
  rowIndexes: number[]
}

export interface TrajectoryDoc {
  rows: TrajectoryRow[]
  turns: TrajectoryTurn[]
  /** 压缩记录折成的行数（>0 = 该会话被压过） */
  compactions: number
  /**
   * 没归属进任何轮的用量行（时间落在首条用户消息之前 —— 现实里只有"记账有了、消息被截掉"这种情况）。
   * 界面不渲染它（无轮可挂），导出里带着（不丢数据）。
   */
  unattributedUsage: TrajectoryUsageRun[]
  /** 数据面里有没有可用时刻（决定时间轴能不能画） */
  hasTiming: boolean
}

export interface BuildTrajectoryInput {
  /** 存储消息（GET /api/threads/:id/messages 的原样回包） */
  messages: readonly StoredMessage[]
  /** 该会话的用量行（时间升序；没有 = 没记过账） */
  usageRuns?: readonly TrajectoryUsageRun[]
  /** 压缩记录（没有 = 没压过） */
  compaction?: ThreadCompaction | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 认数才是数（时间戳一律走这里，字符串时间戳不当数用） */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 结构化值 → 可复制的原文：字符串原样（工具结果多是字符串），其余转 pretty JSON */
function rawOf(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value === '' ? null : value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** 一律 pretty JSON（「参数」页要的就是 JSON 文本） */
function jsonOf(value: unknown): string | null {
  if (value === undefined) return null
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return null
  }
}

/** 一行摘要：折叠换行、截断（长文本不撑破行） */
export function summarize(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

/** 时间戳 → "HH:MM:SS.mmm"（明细「计时」用；本地时区） */
export function formatClock(at: number | null): string | null {
  if (at === null) return null
  const date = new Date(at)
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(
    date.getMilliseconds()
  ).padStart(3, '0')}`
}

/** 时长 → 人话（<1s 走毫秒，其余走秒；没有 = null） */
export function formatDuration(ms: number | null): string | null {
  if (ms === null) return null
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} 秒`
}

/**
 * 时长 = 终点 − 起点。两端都在手、且**不自相矛盾**才算（终点早于起点 = 这两头不是同一件事的
 * 起止，宁可说"未记录"，也不把负数当 0 报出去）。
 */
function spanOf(startedAt: number | null, endedAt: number | null): number | null {
  if (startedAt === null || endedAt === null) return null
  return endedAt < startedAt ? null : endedAt - startedAt
}

/**
 * 计时来源：两头都没有记录下来的时刻 = `'none'`，否则 = `'session'`。
 * **不是**看"有没有时长"——瞬时事件与未收尾的调用都有时刻、没时长。
 */
function timingSourceOf(startedAt: number | null, endedAt: number | null): TrajectoryTimingSource {
  return startedAt === null && endedAt === null ? 'none' : 'session'
}

/** token 数 → 千分位（界面上不写 unit 后缀，靠列头说） */
export function formatTokens(value: number): string {
  return value.toLocaleString('en-US')
}

/** 消息里的 part 列表（不是 parts 结构就当空） */
function partsOf(content: unknown): unknown[] {
  if (!isRecord(content) || !Array.isArray(content.parts)) return []
  return content.parts
}

/** 消息 metadata（模型 id / provider 从这里来） */
function metadataOf(content: unknown): Record<string, unknown> {
  if (!isRecord(content) || !isRecord(content.metadata)) return {}
  return content.metadata
}

/** part 的时间戳：createdAt 优先，tool-invocation 落在 updatedAt 上 */
function partTimestamp(part: Record<string, unknown>): number | null {
  return (
    numberOrNull(part.createdAt) ??
    numberOrNull(part.updatedAt) ??
    (isRecord(part.toolInvocation) ? numberOrNull(part.toolInvocation.updatedAt) : null)
  )
}

/**
 * 消息写入时刻。
 * 列上存的是 **ISO 字符串**（Mastra 的 `mastra_messages.createdAt`，本机实测就是
 * `2026-10-13T06:23:55.630Z` 这种），part 上才是 epoch ms —— 两种都认；
 * 列不在 / 认不出来时退回"各 part 的最大时刻"（不是编一个，是有啥用啥）。
 */
/**
 * 这条消息里**最后一个 part** 的时刻 = 这一行最后一次被写入的时刻。
 *
 * 为什么不用 `mastra_messages.createdAt`：那是**行插入时刻**（第一次落库那一刻），
 * 之后同一行还会被追加 part（进一步的动作、工具结果），行时刻不会跟着变。真库实测：
 * 某条助手消息的行时刻比它自己内部的 `step-start` 还早 24ms —— 拿行时刻当"写完的时刻"
 * 会让那一步的时长算成 0（甚至负数）。行时刻只在整条消息一个带时间戳的 part 都没有时兜底。
 */
function lastPartTimestamp(parts: readonly unknown[]): number | null {
  let latest: number | null = null
  for (const part of parts) {
    if (!isRecord(part)) continue
    const at = partTimestamp(part)
    if (at === null) continue
    if (latest === null || at > latest) latest = at
  }
  return latest
}

function messageTimestamp(message: StoredMessage, parts: readonly unknown[]): number | null {
  const raw = isRecord(message) ? (message as { createdAt?: unknown }).createdAt : undefined
  const numeric = numberOrNull(raw)
  if (numeric !== null) return numeric
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  let latest: number | null = null
  for (const part of parts) {
    if (!isRecord(part)) continue
    const at = partTimestamp(part)
    if (at === null) continue
    if (latest === null || at > latest) latest = at
  }
  return latest
}

/** 一条用户消息的正文（text part 拼接） */
function userText(parts: readonly unknown[]): string {
  return parts
    .flatMap((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
    )
    .join('\n')
    .trim()
}

/** 助手 part 的分类（只认我们知道形状的四种，其余忽略——脏数据不把整条消息带崩） */
type AssistantPart =
  | { kind: 'step-start'; at: number | null; model: string | null }
  | { kind: 'text'; at: number | null; text: string }
  | { kind: 'reasoning'; at: number | null; text: string }
  | { kind: 'tool'; at: number | null; call: ToolCall }

interface ToolCall {
  toolName: string
  toolCallId: string
  input: unknown
  result: unknown
  isError: boolean
  /** `state` 不是终态 = 还没收尾（等审批 / 半截） */
  pending: boolean
  updatedAt: number | null
}

function assistantPartOf(part: unknown): AssistantPart | null {
  if (!isRecord(part)) return null
  switch (part.type) {
    case 'step-start':
      return {
        kind: 'step-start',
        at: numberOrNull(part.createdAt),
        model: stringOrNull(part.model)
      }
    case 'text':
      return typeof part.text === 'string' && part.text.trim() !== ''
        ? { kind: 'text', at: numberOrNull(part.createdAt), text: part.text }
        : null
    case 'reasoning':
      return typeof part.reasoning === 'string' && part.reasoning.trim() !== ''
        ? { kind: 'reasoning', at: numberOrNull(part.createdAt), text: part.reasoning }
        : null
    case 'tool-invocation': {
      const invocation = part.toolInvocation
      if (!isRecord(invocation)) return null
      const rawToolName = stringOrNull(invocation.toolName)
      const toolCallId = stringOrNull(invocation.toolCallId)
      if (rawToolName === null || toolCallId === null) return null
      const state = stringOrNull(invocation.state)
      const args = invocation.args
      // round 75：MCP 每台 server 只剩一个元工具 `mcp__<serverId>__meta`，真调用长成
      // `{action:'call', tool, args}`。轨迹是给人看的账，工具名与入参都要说真的（服务端闸门
      // 本来就在真名上工作）。不是元工具 / 不是 call → 原样（认不出就不猜）。
      return {
        kind: 'tool',
        at: numberOrNull(part.updatedAt),
        call: {
          toolName: resolveMcpToolCallName(rawToolName, args),
          toolCallId,
          input: resolveMcpToolCallInput(rawToolName, args),
          result: invocation.result,
          isError: invocation.isError === true || state === 'output-error',
          pending: state !== 'result' && state !== 'output-error' && state !== 'output-denied',
          updatedAt: numberOrNull(part.updatedAt)
        }
      }
    }
    default:
      return null
  }
}

/** 助手消息折出来的一步（还没落到行上） */
interface StepDraft {
  index: number
  modelId: string | null
  startedAt: number | null
  endedAt: number | null
  /**
   * 起点是"上一个事件的时刻"推出来的（第 1 步没有 `step-start` 标记时）。
   * 这一步如果**一个带时间戳的 part 都没有**，这个推出来的起点就不是关于它的证据 ——
   * 收尾时把它撤掉（宁可不画，也不在时间轴上放一个假的落点）。
   */
  startedFromPrevious: boolean
  entries: Array<
    | { kind: 'text'; at: number | null; text: string }
    | { kind: 'reasoning'; at: number | null; text: string }
    | { kind: 'tool'; at: number | null; call: ToolCall; startedAt: number | null }
  >
}

/**
 * 一条助手消息 → 若干"步"。
 *
 * 走法：`step-start` = 下一步的门；第 1 步没有门，起点取 `fallbackStart`（上一个事件的时刻）。
 * `firstStepIndex` 给的是**这一步在整轮里的编号起点** —— 一轮可能落成好几条助手消息
 * （Mastra 的 response boundary：中途被定稿一次就会再起一条），步号必须在**轮内连续**，
 * 否则同一轮里会出现两组"步骤 1 / 步骤 2"，折叠摘要在数步骤、列表在列步骤，两边就对不上了。
 */
function stepsOf(
  parts: readonly unknown[],
  messageEnd: number | null,
  fallbackStart: number | null,
  metadata: Record<string, unknown>,
  firstStepIndex: number
): StepDraft[] {
  const steps: StepDraft[] = []
  const messageModel = stringOrNull(metadata.modelId)
  let current: StepDraft | null = null
  /** 这一段里最后一个带时间戳的 part（关上一段用） */
  let lastAnyAt: number | null = null
  /**
   * 这一段里最后一个"模型说话"的 part（text / reasoning）—— 工具调用的起点用它。
   *
   * 为什么**不用**"上一个 part 的时刻"：同一段里模型可以一次吐出好几个工具调用（并行调用），
   * 它们是被**同时**发出的；用"上一个 part"会让第二个调用的起点落在第一个调用的结果时刻上，
   * 于是第二个的起点比它自己的终点还晚（真库实测：`read` 起点 8768、终点 8767）。
   * 用"模型说话的那一刻"则并行调用共享同一个起点，各自的终点仍是自己结果落下的时刻。
   *
   * 代价（如实记在这里）：这样算出来的工具时长是**上界** —— 它把模型在吐出这次调用之前
   * 的那段生成时间也算进去了。存储里没有"调用发出"的独立时刻（tool-invocation part 只有
   * `updatedAt`，没有 `createdAt`），这是能拿到的最紧的口径；明细面板的「计时来源」会说是
   * 会话时间戳。
   */
  let lastContentAt: number | null = null

  const openStep = (
    startedAt: number | null,
    modelId: string | null,
    startedFromPrevious = false
  ): StepDraft => ({
    index: firstStepIndex + steps.length,
    modelId,
    startedAt,
    endedAt: null,
    startedFromPrevious,
    entries: []
  })

  for (const part of parts) {
    const parsed = assistantPartOf(part)
    if (parsed === null) continue

    if (parsed.kind === 'step-start') {
      // 下一步开始 = 当前步收尾
      if (current !== null) current.endedAt = parsed.at ?? lastAnyAt
      current = openStep(parsed.at ?? lastAnyAt, parsed.model ?? messageModel)
      steps.push(current)
      lastAnyAt = parsed.at ?? lastAnyAt
      lastContentAt = null
      continue
    }

    current ??= ((): StepDraft => {
      const opened = openStep(fallbackStart, messageModel, true)
      steps.push(opened)
      return opened
    })()

    if (parsed.kind === 'tool') {
      // 起点：本段里模型最后一次说话的刻；本段一句话都没说（纯工具调用段）就退回本步起点
      const startedAt = lastContentAt ?? current.startedAt
      current.entries.push({ kind: 'tool', at: parsed.at, call: parsed.call, startedAt })
    } else {
      current.entries.push({ kind: parsed.kind, at: parsed.at, text: parsed.text })
      if (parsed.at !== null) lastContentAt = parsed.at
    }
    if (parsed.at !== null) lastAnyAt = parsed.at
  }

  // 最后一步收尾：这条消息最后写入的时刻，没有就用它自己最后一个 part 的时刻
  if (current !== null) {
    const lastEntryAt =
      [...current.entries].reverse().find((entry) => entry.at !== null)?.at ?? null
    current.endedAt = messageEnd ?? lastEntryAt
  }

  // 推出来的起点 + 这一步没有任何时间戳 → 撤掉起点（见 StepDraft.startedFromPrevious）
  for (const step of steps) {
    if (!step.startedFromPrevious || step.startedAt === null) continue
    const hasEvidence = step.entries.some((entry) => entry.at !== null)
    if (!hasEvidence) step.startedAt = null
  }

  return steps
}

/** 轮级用量的合计（同一轮的账合起来；缓存/花费"一行都没报"才是 null） */
function usageOfRows(rows: readonly TrajectoryUsageRun[]): TrajectoryUsage | null {
  if (rows.length === 0) return null
  let input = 0
  let output = 0
  let total = 0
  let cachedInput: number | null = null
  let cost: number | null = null
  /** 上下文大小是**快照**（不是合计）：取这一轮最后一条有值的账（时间升序的最后一条） */
  let contextInput: number | null = null
  let steps: number | null = null
  const models: string[] = []
  for (const row of rows) {
    input += row.input
    output += row.output
    total += row.total
    if (row.cachedInput !== null) cachedInput = (cachedInput ?? 0) + row.cachedInput
    if (row.cost !== null) cost = (cost ?? 0) + row.cost
    if (row.contextInput !== null) contextInput = row.contextInput
    if (row.stepCount !== null) steps = (steps ?? 0) + row.stepCount
    if (!models.includes(row.model)) models.push(row.model)
  }
  return { input, output, total, cachedInput, contextInput, steps, cost, models, runs: rows.length }
}

/**
 * 折叠：存储消息 + 用量 + 压缩 → 轨迹文档。
 *
 * 顺序是**存储顺序**（服务端 recall 已是时间升序），不在这里重排——列表要按别的序排时
 * 由视图层对 `rows` 排序（`sortTrajectoryRows`），模型层只保证"时间序 + 稳定 index"。
 */
export function buildTrajectory(input: BuildTrajectoryInput): TrajectoryDoc {
  const rows: TrajectoryRow[] = []
  const turnStarts: Array<{ turn: number; prompt: string; startedAt: number | null }> = []
  let currentTurn: number | null = null
  let previousEventAt: number | null = null
  /** 当前轮已产出的步骤数（步号 = 这个数 + 本消息内的序；换轮归零） */
  let turnStepOffset = 0

  /** 把一行推上去（index 在这里统一分配，调用处不关心） */
  const push = (row: Omit<TrajectoryRow, 'index' | 'usage'>): void => {
    rows.push({ ...row, index: rows.length, usage: null })
  }

  for (const message of input.messages) {
    const parts = partsOf(message.content)
    const metadata = metadataOf(message.content)
    const writtenAt = messageTimestamp(message, parts)
    const role = typeof message.role === 'string' ? message.role : ''

    if (role === 'user') {
      currentTurn = (currentTurn ?? 0) + 1
      turnStepOffset = 0
      const prompt = userText(parts)
      turnStarts.push({ turn: currentTurn, prompt, startedAt: writtenAt })
      const imageCount = parts.filter((part) => isRecord(part) && part.type === 'file').length
      push({
        kind: 'user',
        turn: currentTurn,
        step: null,
        text: summarize(prompt === '' ? '（无文本）' : prompt),
        body: prompt === '' ? null : prompt,
        thinking: null,
        toolName: null,
        toolCallId: null,
        inputRaw: null,
        outputRaw: null,
        isError: false,
        pending: false,
        modelId: null,
        startedAt: writtenAt,
        endedAt: writtenAt,
        durationMs: null,
        timingSource: timingSourceOf(writtenAt, writtenAt),
        raw: jsonOf(message),
        source: imageCount === 0 ? '用户' : `用户 · 附件 ${imageCount}`
      })
      if (writtenAt !== null) previousEventAt = writtenAt
      continue
    }

    if (role !== 'assistant') continue

    // 助手消息的"结束时刻" = 最后一个 part 的时刻（行 createdAt 只是插入时刻，见头注）
    const steps = stepsOf(
      parts,
      lastPartTimestamp(parts) ?? writtenAt,
      previousEventAt,
      metadata,
      turnStepOffset + 1
    )
    turnStepOffset += steps.length
    for (const step of steps) {
      const stepModel = step.modelId ?? stringOrNull(metadata.modelId)
      const stepDuration = spanOf(step.startedAt, step.endedAt)

      const textParts = step.entries.flatMap((entry) => (entry.kind === 'text' ? [entry.text] : []))
      const reasoningParts = step.entries.flatMap((entry) =>
        entry.kind === 'reasoning' ? [entry.text] : []
      )
      const toolEntries = step.entries.flatMap((entry) => (entry.kind === 'tool' ? [entry] : []))
      const body = textParts.join('\n\n').trim()
      const thinking = reasoningParts.join('\n\n').trim()

      // 1) 助手行：一步一条。有工具调用时摘要说"还调了 M 个工具"，没正文就是"仅工具调用"
      const toolSuffix = toolEntries.length === 0 ? '' : ` · 工具 ${toolEntries.length} 个`
      push({
        kind: 'message',
        turn: currentTurn,
        step: step.index,
        text:
          body === ''
            ? `${toolEntries.length > 0 ? '（仅工具调用）' : '（无文本输出）'}${toolSuffix}`
            : `${summarize(body)}${toolSuffix}`,
        body: body === '' ? null : body,
        thinking: thinking === '' ? null : thinking,
        toolName: null,
        toolCallId: null,
        inputRaw: null,
        outputRaw: null,
        isError: false,
        pending: step.endedAt === null,
        modelId: stepModel,
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        durationMs: stepDuration,
        timingSource: timingSourceOf(step.startedAt, step.endedAt),
        raw: null,
        source: stepModel === null ? '助手' : `助手 · ${stepModel}`
      })

      // 2) 工具行：一次调用一条（紧跟它的助手行之后，与对话里的先后一致）
      for (const entry of toolEntries) {
        const call = entry.call
        const endedAt = call.updatedAt ?? entry.at
        const durationMs = call.pending ? null : spanOf(entry.startedAt, endedAt)
        const resultText = rawOf(call.result)
        const inputText = jsonOf(call.input)
        const taskHistory = call.toolName === 'todo' ? projectTodoOutput(call.result) : null
        const interactionStatus =
          call.toolName !== 'ask_user'
            ? undefined
            : call.pending
              ? ('waiting' as const)
              : isRecord(call.result) && call.result.status === 'cancelled'
                ? ('cancelled' as const)
                : isRecord(call.result) && call.result.status === 'answered'
                  ? ('answered' as const)
                  : undefined
        push({
          ...(interactionStatus === undefined ? {} : { interactionStatus }),
          ...(taskHistory === null || taskHistory.conflict
            ? {}
            : { taskRevision: taskHistory.revision }),
          kind: 'tool',
          turn: currentTurn,
          step: step.index,
          text:
            taskHistory !== null
              ? `todo · 历史版本 ${taskHistory.revision} · ${taskHistory.summary}${taskHistory.conflict ? ' · 修改冲突（未保存）' : ''}`
              : `${call.toolName}${call.toolName === 'ask_user' ? ` · ${call.pending ? '等待回答' : isRecord(call.result) && call.result.status === 'cancelled' ? '已取消' : isRecord(call.result) && call.result.status === 'answered' ? '已回答' : '未完成'}` : ''} ${summarize(inputText ?? '（未捕获参数）', 80)}${
                  resultText === null ? '' : ` → ${summarize(resultText, 100)}`
                }`,
          body: null,
          thinking: null,
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          inputRaw: inputText,
          outputRaw: resultText,
          isError: call.isError,
          pending: call.pending,
          modelId: stepModel,
          startedAt: entry.startedAt,
          endedAt,
          durationMs,
          timingSource: timingSourceOf(entry.startedAt, endedAt),
          raw: jsonOf({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            args: call.input,
            result: call.result,
            isError: call.isError,
            pending: call.pending
          }),
          source: '工具'
        })
      }
      if (step.endedAt !== null) previousEventAt = step.endedAt
    }
  }

  // 压缩记录：按它自己的时刻插回时间序（它是"轮次之间"的一件事，不属于任何轮）
  const compaction = input.compaction ?? null
  if (compaction !== null) {
    const at = Date.parse(compaction.createdAt)
    const startedAt = Number.isFinite(at) ? at : null
    const level = compactionLevelOf(compaction)
    const row: Omit<TrajectoryRow, 'index' | 'usage'> = {
      kind: 'compacted',
      turn: null,
      step: null,
      // 按档说人话：精简 / 去重 / 折叠 / 摘要（老记录没有 level = 摘要档）
      text: `${COMPACT_VERB[level]} ${compaction.summarized} 条 · 保留 ${compaction.kept} 条`,
      body: compaction.summary,
      thinking: null,
      toolName: null,
      toolCallId: null,
      inputRaw: null,
      outputRaw: null,
      isError: false,
      pending: false,
      modelId: null,
      startedAt,
      endedAt: startedAt,
      durationMs: startedAt === null ? null : 0,
      timingSource: timingSourceOf(startedAt, startedAt),
      raw: jsonOf(compaction),
      source: COMPACT_SOURCE[level]
    }
    if (startedAt === null) {
      push(row)
    } else {
      const at2 = rows.findIndex(
        (existing) => existing.startedAt !== null && existing.startedAt > startedAt
      )
      const target = at2 === -1 ? rows.length : at2
      rows.splice(target, 0, { ...row, index: target, usage: null })
    }
  }

  // index 在 splice 之后要重排（时间轴的按 index 定位依赖它连续）
  rows.forEach((row, index) => {
    row.index = index
  })

  /**
   * 轮级用量归属：账的落账时刻落在 [本轮起始, 下一轮起始) 里就算这一轮的。
   * 不走"就近猜测"：落账时刻在两轮之间时，归**前一轮**（run 是那一轮发起的，收尾晚于消息落库）。
   */
  const runs = [...(input.usageRuns ?? [])]
  const unattributedUsage: TrajectoryUsageRun[] = []
  const usageByTurn = new Map<number, TrajectoryUsageRun[]>()
  for (const run of runs) {
    const at = Date.parse(run.createdAt)
    if (!Number.isFinite(at)) {
      unattributedUsage.push(run)
      continue
    }
    let owner: number | null = null
    for (const [position, start] of turnStarts.entries()) {
      if (start.startedAt === null) continue
      const next = turnStarts[position + 1]
      const upper = next?.startedAt ?? Number.POSITIVE_INFINITY
      if (at >= start.startedAt && at < upper) {
        owner = start.turn
        break
      }
    }
    if (owner === null) {
      unattributedUsage.push(run)
      continue
    }
    const bucket = usageByTurn.get(owner) ?? []
    bucket.push(run)
    usageByTurn.set(owner, bucket)
  }

  // 轮清单（行序号 + 用量 + 折叠摘要要的计数）
  const turns: TrajectoryTurn[] = turnStarts.map((start) => {
    const owned = rows.filter((row) => row.turn === start.turn)
    const steps = new Set(owned.flatMap((row) => (row.step === null ? [] : [row.step]))).size
    const toolCalls = owned.filter((row) => row.kind === 'tool').length
    const lastWithTime = [...owned].reverse().find((row) => row.endedAt !== null)
    return {
      turn: start.turn,
      prompt: summarize(start.prompt),
      startedAt: start.startedAt,
      endedAt: lastWithTime?.endedAt ?? null,
      steps,
      toolCalls,
      usage: usageOfRows(usageByTurn.get(start.turn) ?? []),
      rowIndexes: owned.map((row) => row.index)
    }
  })

  // 用量的最终落点：每一行都带"本轮用量"（同一轮的行拿的是同一份引用）
  const usageByTurnId = new Map(turns.map((turn) => [turn.turn, turn.usage]))
  for (const row of rows) {
    row.usage = row.turn === null ? null : (usageByTurnId.get(row.turn) ?? null)
  }

  return {
    rows,
    turns,
    compactions: compaction === null ? 0 : 1,
    unattributedUsage,
    hasTiming: rows.some((row) => row.startedAt !== null)
  }
}

/** 轨迹文档里所有可搜的文本（搜索层与导出共用一处口径） */
export function searchableTextOf(row: TrajectoryRow): string {
  return [
    row.text,
    row.body ?? '',
    row.thinking ?? '',
    row.toolName ?? '',
    row.inputRaw ?? '',
    row.outputRaw ?? '',
    row.modelId ?? '',
    KIND_LABEL[row.kind],
    row.turn === null ? '' : `第 ${row.turn} 轮`,
    row.turn === null ? '' : `${row.turn}`
  ].join('\n')
}
