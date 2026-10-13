/**
 * 时间轴布局（纯函数）：把轨迹行投影成**三条泳道**上的彩色块（输入 / 模型 / 工具）。
 *
 * 泳道归属照 dsh 的 `laneFor`：工具 → 第 3 条，助手与压缩 → 第 2 条，其余（用户 / 上下文 / 系统）→ 第 1 条。
 *
 * 三种视图档（工具栏的「时长 | 轮次 | 调用」）在时间轴上的差别：
 *   - `duration` 时长：**真实时刻**（epoch ms）为横坐标；事件之间的空档压掉
 *     （`compressIdle`）——不然等用户打字那几分钟会把所有块挤成一条线；
 *   - `turns` 轮次：**等宽序列**投影（一条记录一个单位宽），与真实时刻无关 ——
 *     会话很长、时间跨度很大时用这一档看"顺序与占比"；
 *   - `calls` 调用：真实时刻 + 压空档，但**只画工具块**（看"时间都花在哪几次调用上"）。
 *
 * 时钟口径见 model.ts 头注：两端都在手才有时长，缺一即"未记录"（这里落成 `instant`，
 * 视图用最小宽度画一个刻度，不假装它持续了多久）。
 */
import type { TrajectoryDoc, TrajectoryKind, TrajectoryRow } from './model'

export type TrajectoryViewMode = 'duration' | 'turns' | 'calls'

/** 视图档的三档（顺序 = 工具栏里的顺序） */
export const VIEW_MODES: ReadonlyArray<{ id: TrajectoryViewMode; label: string }> = [
  { id: 'duration', label: '时长' },
  { id: 'turns', label: '轮次' },
  { id: 'calls', label: '调用' }
]

/** 泳道（0 起，自上而下：输入 / 模型 / 工具） */
export const LANE_LABELS = ['输入', '模型', '工具'] as const

export type TrajectoryLane = 0 | 1 | 2

/** 与 dsh 同口径的归属 */
export function laneFor(kind: TrajectoryKind): TrajectoryLane {
  if (kind === 'tool') return 2
  if (kind === 'message' || kind === 'compacted') return 1
  return 0
}

export interface TimelineSpan {
  rowIndex: number
  lane: TrajectoryLane
  kind: TrajectoryKind
  /** 投影后的坐标（与 `TimelineModel.domainStart/domainEnd` 同一坐标系） */
  start: number
  end: number
  isError: boolean
  /** 时刻缺一头（没时长）：宽度用最小刻度画，不是"瞬间完成" */
  instant: boolean
}

export interface TimelineModel {
  domainStart: number
  domainEnd: number
  spans: TimelineSpan[]
  /** 轮次分界（画一条竖线）：`at` 与 span 同坐标 */
  turnBoundaries: Array<{ turn: number; at: number }>
  /** 这一档有没有可画的东西 */
  empty: boolean
}

/** 这一档要不要看这一行 */
export function rowVisibleInMode(row: TrajectoryRow, mode: TrajectoryViewMode): boolean {
  return mode !== 'calls' || row.kind === 'tool'
}

/**
 * 投影：行 + 档位 → 时间轴模型。
 *
 * @param doc 轨迹文档（时间序）
 * @param mode 视图档
 * @param visibleIndexes 当前**可见**的行序号（搜索过滤后）——时间轴只画看得见的那些，
 *   与列表一致；不传 = 全都画
 */
export function deriveTimeline(
  doc: TrajectoryDoc,
  mode: TrajectoryViewMode,
  visibleIndexes?: ReadonlySet<number> | null
): TimelineModel {
  const rows = doc.rows.filter(
    (row) =>
      rowVisibleInMode(row, mode) &&
      (visibleIndexes === undefined || visibleIndexes === null || visibleIndexes.has(row.index))
  )

  if (rows.length === 0) {
    return { domainStart: 0, domainEnd: 1, spans: [], turnBoundaries: [], empty: true }
  }

  if (mode === 'turns') {
    // 等宽序列：一条记录一个单位（与时刻无关，所以"没时刻"的行也画得出来）
    const spans: TimelineSpan[] = rows.map((row, offset) => ({
      rowIndex: row.index,
      lane: laneFor(row.kind),
      kind: row.kind,
      start: offset,
      end: offset + 1,
      isError: row.isError,
      instant: false
    }))
    const turnBoundaries: Array<{ turn: number; at: number }> = []
    for (const [offset, row] of rows.entries()) {
      if (row.turn === null) continue
      if (turnBoundaries.some((boundary) => boundary.turn === row.turn)) continue
      turnBoundaries.push({ turn: row.turn, at: offset })
    }
    return { domainStart: 0, domainEnd: rows.length, spans, turnBoundaries, empty: false }
  }

  // 真实时刻：只有带时刻的行画得出来（缺时刻的按"不编造"跳过，不是补 0）
  const raw = rows.flatMap((row) => {
    if (row.startedAt === null) return []
    const startedAt = row.startedAt
    // 不变式：块上 `start <= end`。记录里两头自相矛盾（终点早于起点）时收成一个最小刻度，
    // 不去画一个负宽度的块 —— 时长本身仍是"未记录"（见 model.ts 的 spanOf）。
    const end = row.endedAt === null ? startedAt : Math.max(startedAt, row.endedAt)
    return [
      {
        rowIndex: row.index,
        lane: laneFor(row.kind),
        kind: row.kind,
        start: startedAt,
        end,
        isError: row.isError,
        instant: row.durationMs === null || row.endedAt === null || row.endedAt < startedAt
      }
    ]
  })
  if (raw.length === 0) {
    return { domainStart: 0, domainEnd: 1, spans: [], turnBoundaries: [], empty: true }
  }

  // 压空档：按开始时刻扫一遍，把"上一段覆盖不到这里"的那段空白累计减掉
  const ordered = [...raw].sort((left, right) => left.start - right.start || left.end - right.end)
  const removedByIdentity = new Map<(typeof ordered)[number], number>()
  let removed = 0
  let covered: number | null = null
  for (const span of ordered) {
    if (covered !== null && span.start > covered) removed += span.start - covered
    removedByIdentity.set(span, removed)
    covered = covered === null ? span.end : Math.max(covered, span.end)
  }

  const spans: TimelineSpan[] = raw.map((span) => {
    const offset = removedByIdentity.get(span) ?? 0
    return { ...span, start: span.start - offset, end: span.end - offset }
  })

  const domainStart = Math.min(...spans.map((span) => span.start))
  const domainEnd = Math.max(...spans.map((span) => span.end), domainStart + 1)

  const turnBoundaries: Array<{ turn: number; at: number }> = []
  const byRowIndex = new Map(spans.map((span) => [span.rowIndex, span]))
  for (const row of rows) {
    if (row.turn === null) continue
    if (turnBoundaries.some((boundary) => boundary.turn === row.turn)) continue
    const span = byRowIndex.get(row.index)
    if (span === undefined) continue
    turnBoundaries.push({ turn: row.turn, at: span.start })
  }

  return { domainStart, domainEnd, spans, turnBoundaries, empty: false }
}

/** 点击/拖动选中的一段（与 span 同坐标）落在哪几个 span 上（含"区间内任一点活跃"） */
export function spansInRange(
  model: TimelineModel,
  range: { start: number; end: number }
): Set<number> {
  const low = Math.min(range.start, range.end)
  const high = Math.max(range.start, range.end)
  return new Set(
    model.spans.filter((span) => span.start <= high && span.end >= low).map((span) => span.rowIndex)
  )
}

/** 点到空白处时，找**离得最近**的那一条（dsh 的 onRecordFocus 口径） */
export function nearestSpanIndex(model: TimelineModel, at: number): number | null {
  let best: TimelineSpan | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const span of model.spans) {
    const distance = at < span.start ? span.start - at : at > span.end ? at - span.end : 0
    if (distance < bestDistance) {
      bestDistance = distance
      best = span
    }
  }
  return best?.rowIndex ?? null
}

/** 时间轴块的几何（百分比）——给视图层直接用，纯算不碰 DOM */
export function spanGeometry(
  model: TimelineModel,
  span: TimelineSpan
): { leftPercent: number; widthPercent: number } {
  const duration = Math.max(1, model.domainEnd - model.domainStart)
  return {
    leftPercent: ((span.start - model.domainStart) / duration) * 100,
    widthPercent: ((span.end - span.start) / duration) * 100
  }
}
