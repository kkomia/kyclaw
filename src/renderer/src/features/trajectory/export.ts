/**
 * 轨迹导出（纯序列化 + 一层浏览器下载薄壳）：dsh 有 session 导出，这里给同一件事。
 *
 * 导出的是**一件事的完整快照**，几部分都在里面（用户点名的"对话 + 轨迹 + 用量"）：
 *   - `conversation.messages`：存储消息**原文**（不做任何加工，拿到别处能原样回放）；
 *   - `trajectory`：投影出来的轮次与步骤（含每步的时刻 / 时长 / 计时来源 / 工具入参结果）；
 *   - `usage`：该会话的逐轮用量行 + 合计（含没归属进任何轮的那些，不丢账）；
 *   - `requests`：该会话的逐次模型请求（用户反馈 015）—— **只带摘要**：一步一步的状态、
 *     消息条数、工具件数、系统指令长度与失败原因。
 *
 * 「请求正文」为什么不进导出：一条请求实测 ~96 KB（3 条 system 1.4 万字 + 35 件工具 8.1 万字），
 * 一轮里还有好几步 —— 几百轮的会话导一次就是几十 MB，外部工具也读不动。正文按需从本地取
 * （`GET /api/trajectory/requests/detail?id=`，`requests.summaries[].id`），导出里把这条口径写清。
 *
 * 序列化与"怎么落盘"分开：`serializeTrajectoryExport` 是纯函数（可单测，不碰 DOM），
 * `downloadTrajectoryExport` 才碰 Blob / a[download]。
 */
import type { StoredMessage, ThreadCompaction } from '@shared/threads'
import type { TrajectoryRequestSummary, TrajectoryUsageRun } from '@shared/trajectory'
import type { TrajectoryDoc, TrajectoryRow } from './model'
import type { TrajectoryViewMode } from './timeline'

/** 导出格式标识（外部工具认这个字段；改形状就升 version） */
export const TRAJECTORY_EXPORT_FORMAT = 'kyclaw-trajectory'
/** v2：用量里去掉计费口径（`usage.totals.cost` 与每行 run 的 `cost`；用户口径 014 不做计费） */
/** v3：新增 `requests` 段（逐轮请求快照：系统指令 / 工具表 / 上下文条数；用户反馈 015） */
/** v4：`requests` 改**逐次请求的摘要** + 正文按需取的口径说明（一条请求 ~96 KB，不进导出） */
export const TRAJECTORY_EXPORT_VERSION = 4

/** 请求正文不进导出的原因（写进载荷，别让外部工具以为"导出缺了东西"） */
export const REQUESTS_DETAIL_NOTE =
  '请求正文不进导出（一条请求 ~96 KB、一轮多步）；按 requests.summaries[].id 从本地取：GET /api/trajectory/requests/detail?id='

export interface TrajectoryExportInput {
  thread: { id: string; title: string | null }
  /** 当前视图档（导出时一并记下"这份快照是按哪一档看的"） */
  mode: TrajectoryViewMode
  doc: TrajectoryDoc
  /** 存储消息原文 */
  messages: readonly StoredMessage[]
  usageRuns: readonly TrajectoryUsageRun[]
  /** 逐次模型请求的摘要（round 87；没有 = 没记过/老会话，导出里是空数组而不是缺字段） */
  requests: readonly TrajectoryRequestSummary[]
  compaction: ThreadCompaction | null
  /** 测试注入"现在" */
  now?: Date
}

/** epoch ms → ISO；没有 = null（**不是** 1970） */
function isoOf(at: number | null): string | null {
  return at === null ? null : new Date(at).toISOString()
}

function rowOf(row: TrajectoryRow): Record<string, unknown> {
  return {
    index: row.index,
    kind: row.kind,
    turn: row.turn,
    step: row.step,
    text: row.text,
    source: row.source,
    body: row.body,
    thinking: row.thinking,
    modelId: row.modelId,
    startedAt: isoOf(row.startedAt),
    endedAt: isoOf(row.endedAt),
    durationMs: row.durationMs,
    timingSource: row.timingSource,
    pending: row.pending,
    isError: row.isError,
    /** 这一行属于哪一次模型请求（系统 / 上下文 / 失败三类行才有；用户反馈 015） */
    request: row.request,
    tool:
      row.kind !== 'tool'
        ? null
        : {
            // **原始**工具名（`mcp__<serverId>__<tool>`）：导出是给机器读的快照，服务名与 id 的对应
            // 是外部工具回放/对账要用的；展示层（时间轴 tooltip / 明细表头）另走 @shared/mcp 的
            // formatToolName 美化。两边故意不同 —— 改了这里等于改导出契约（version 要跟着升）。
            name: row.toolName,
            callId: row.toolCallId,
            input: row.inputRaw,
            result: row.outputRaw
          }
  }
}

export interface TrajectoryExportPayload {
  format: string
  version: number
  exportedAt: string
  view: TrajectoryViewMode
  thread: { id: string; title: string | null }
  usage: {
    /** 该会话的全部记账行（含没能归属进某轮的那些） */
    runs: readonly TrajectoryUsageRun[]
    /** `runs` 里**没能归属进任何轮**的交叉索引（不丢账，也便于看出"有账无轮"） */
    unattributed: readonly TrajectoryUsageRun[]
    totals: { input: number; output: number; cachedInput: number }
  }
  compaction: ThreadCompaction | null
  conversation: { messages: readonly StoredMessage[] }
  /**
   * round 87：逐次模型请求的**摘要**（一步一步：状态 / 消息条数 / 工具件数 / 系统指令长度 /
   * 失败原因）。`rowOf` 里那几类的行与它同源；正文按 `summaries[].id` 从本地按需取
   * （见 `note`）。
   */
  requests: { note: string; summaries: readonly TrajectoryRequestSummary[] }
  trajectory: {
    compactions: number
    turns: ReadonlyArray<Record<string, unknown>>
    rows: ReadonlyArray<Record<string, unknown>>
  }
}

/** 合计：缓存没报的行按 0 计入（这是"报了多少"的合计，不区分"没报"） */
function totalsOf(runs: readonly TrajectoryUsageRun[]): {
  input: number
  output: number
  cachedInput: number
} {
  let input = 0
  let output = 0
  let cachedInput = 0
  for (const run of runs) {
    input += run.input
    output += run.output
    cachedInput += run.cachedInput ?? 0
  }
  return { input, output, cachedInput }
}

/** 轨迹文档 + 原料 → 导出载荷（纯数据，未序列化） */
export function trajectoryExportPayload(input: TrajectoryExportInput): TrajectoryExportPayload {
  const now = input.now ?? new Date()
  return {
    format: TRAJECTORY_EXPORT_FORMAT,
    version: TRAJECTORY_EXPORT_VERSION,
    exportedAt: now.toISOString(),
    view: input.mode,
    thread: { id: input.thread.id, title: input.thread.title },
    usage: {
      runs: input.usageRuns,
      unattributed: input.doc.unattributedUsage,
      totals: totalsOf(input.usageRuns)
    },
    compaction: input.compaction,
    conversation: { messages: input.messages },
    requests: { note: REQUESTS_DETAIL_NOTE, summaries: input.requests },
    trajectory: {
      compactions: input.doc.compactions,
      turns: input.doc.turns.map((turn) => ({
        turn: turn.turn,
        prompt: turn.prompt,
        startedAt: isoOf(turn.startedAt),
        endedAt: isoOf(turn.endedAt),
        steps: turn.steps,
        toolCalls: turn.toolCalls,
        usage: turn.usage
      })),
      rows: input.doc.rows.map(rowOf)
    }
  }
}

/** 导出为 JSON 文本（缩进 2，便于人看也便于 diff） */
export function serializeTrajectoryExport(input: TrajectoryExportInput): string {
  return JSON.stringify(trajectoryExportPayload(input), null, 2)
}

/** 文件名：`kyclaw-轨迹-<会话前 8 位>-<yyyyMMdd-HHmmss>.json`（本地时间，便于按时间找） */
export function trajectoryExportFileName(threadId: string, now: Date = new Date()): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(
    now.getHours()
  )}${two(now.getMinutes())}${two(now.getSeconds())}`
  return `kyclaw-轨迹-${threadId.slice(0, 8)}-${stamp}.json`
}

/**
 * 落盘（浏览器下载）：把 JSON 交给下载管理器。
 * 纯壳子——序列化在上面的纯函数里，测试只测那个（jsdom 没有 createObjectURL）。
 */
export function downloadTrajectoryExport(json: string, fileName: string): void {
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}
