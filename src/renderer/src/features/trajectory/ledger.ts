/**
 * 步骤列表的**行模型**（纯函数）：把轨迹文档折成"表头 / 步骤分隔 / 数据行 / 折叠摘要"四种条目。
 *
 * 三种视图档在列表上的差别（与时间轴同源，见 timeline.ts）：
 *   - `duration` 时长：**按真实开始时刻排序**（时刻缺的排到后面，保持稳定）；
 *   - `turns` 轮次：按"轮次 → 步骤 → 记录顺序"排（= 文档顺序，最接近对话本身）；
 *   - `calls` 调用：只列工具行（看"哪几次调用、各花了多久"）。
 *
 * 折叠与搜索的交互照 dsh 的口径：**搜索生效时不折叠**（搜出来又被折叠掉会看不见），
 * 折叠只管"没搜索时"的那份列表。
 */
import type { TrajectoryDoc, TrajectoryRow, TrajectoryTurn } from './model'
import type { TrajectoryViewMode } from './timeline'

export type LedgerItem =
  | {
      type: 'turn'
      /** 轮次号；`null` = 不属于任何轮的记录（轮次之间） */
      turn: number | null
      key: string
      label: string
      prompt: string | null
      /** 折叠摘要（"N 个步骤 · M 个工具调用"） */
      summary: string
      /** 表格头右侧的用量（拿不到 = null） */
      usageText: string | null
      collapsed: boolean
      /** 有没有可折叠的内容（一条都没有就不画开合按钮） */
      foldable: boolean
    }
  | { type: 'step'; turn: number; step: number; key: string; label: string }
  | { type: 'row'; row: TrajectoryRow; key: string }
  | { type: 'collapsed'; turn: number; key: string; summary: string }

/** 折叠摘要的人话（与 dsh 的 "N 个步骤 · M 个工具调用" 同款） */
export function turnSummary(turn: TrajectoryTurn): string {
  return `${turn.steps} 个步骤 · ${turn.toolCalls} 个工具调用`
}

/** 表头右侧的用量文案（一行都没有 = null） */
export function turnUsageText(turn: TrajectoryTurn): string | null {
  if (turn.usage === null) return null
  const parts = [
    `输入 ${turn.usage.input.toLocaleString('en-US')}`,
    `输出 ${turn.usage.output.toLocaleString('en-US')}`
  ]
  if (turn.usage.cachedInput !== null) {
    parts.push(`缓存 ${turn.usage.cachedInput.toLocaleString('en-US')}`)
  }
  return parts.join(' · ')
}

export interface BuildLedgerInput {
  doc: TrajectoryDoc
  mode: TrajectoryViewMode
  /** 折叠起来的轮次 */
  collapsedTurns: ReadonlySet<number>
  /** 搜索命中的行序号；null = 没在搜索（全量 + 折叠生效） */
  matches: ReadonlySet<number> | null
}

/** 文档顺序的重排：时长档按真实开始时刻，缺时刻的排到后面（稳定） */
function orderRows(doc: TrajectoryDoc, mode: TrajectoryViewMode): TrajectoryRow[] {
  const rows = mode === 'calls' ? doc.rows.filter((row) => row.kind === 'tool') : [...doc.rows]
  if (mode !== 'duration') return rows
  return rows
    .map((row, position) => ({ row, position }))
    .sort((left, right) => {
      const a = left.row.startedAt
      const b = right.row.startedAt
      if (a === null && b === null) return left.position - right.position
      if (a === null) return 1
      if (b === null) return -1
      return a - b || left.position - right.position
    })
    .map((entry) => entry.row)
}

/**
 * 折成列表条目。
 * 表头（轮次 / 轮次之间）在"轮次变了"或"从有轮变成无轮"时出现，一次一组。
 */
export function buildLedgerItems(input: BuildLedgerInput): LedgerItem[] {
  const searching = input.matches !== null
  const rows = orderRows(input.doc, input.mode).filter(
    (row) => !searching || input.matches?.has(row.index) === true
  )
  const turnById = new Map(input.doc.turns.map((turn) => [turn.turn, turn]))
  const items: LedgerItem[] = []
  /** 已经出过表头的轮次（时长档可能把同一轮的行打散，表头只出一次） */
  const headedTurns = new Set<string>()
  /** 已经出过折叠摘要的轮次（一行摘要代表整轮，只出一次） */
  const collapsedTurns = new Set<number>()
  let heading: string | null = null
  let lastStep: string | null = null

  const headerKey = (turn: number | null): string => (turn === null ? 'between' : `turn-${turn}`)

  for (const row of rows) {
    const key = headerKey(row.turn)
    const folded = !searching && row.turn !== null && input.collapsedTurns.has(row.turn)

    if (key !== heading) {
      heading = key
      lastStep = null
      if (!headedTurns.has(key)) {
        headedTurns.add(key)
        const turn = row.turn === null ? null : (turnById.get(row.turn) ?? null)
        items.push({
          type: 'turn',
          turn: row.turn,
          key: `header-${key}`,
          label: row.turn === null ? '轮次之间' : `第 ${row.turn} 轮`,
          prompt: turn === null ? null : turn.prompt === '' ? null : turn.prompt,
          summary: turn === null ? '' : turnSummary(turn),
          usageText: turn === null ? null : turnUsageText(turn),
          collapsed: folded,
          foldable: turn !== null && turn.rowIndexes.length > 0
        })
      }
    }

    // 收起：整轮的行都让位，只留一行摘要（每轮一次）
    if (folded && row.turn !== null) {
      if (!collapsedTurns.has(row.turn)) {
        collapsedTurns.add(row.turn)
        const turn = turnById.get(row.turn)
        items.push({
          type: 'collapsed',
          turn: row.turn,
          key: `collapsed-${row.turn}`,
          summary: turn === undefined ? '' : turnSummary(turn)
        })
      }
      continue
    }

    // 步骤分隔：一轮里不止一步时才有意义（一步的轮加一行标签只是噪音）
    if (row.turn !== null && row.step !== null) {
      const turn = turnById.get(row.turn)
      const showSteps = turn !== undefined && turn.steps > 1
      const stepKey = `${row.turn}#${row.step}`
      if (showSteps && stepKey !== lastStep) {
        lastStep = stepKey
        items.push({
          type: 'step',
          turn: row.turn,
          step: row.step,
          key: `step-${stepKey}`,
          label: `步骤 ${row.step}`
        })
      }
    }

    items.push({ type: 'row', row, key: `row-${row.index}` })
  }

  return items
}
