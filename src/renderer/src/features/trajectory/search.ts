/**
 * 轨迹搜索（纯函数）：工具栏那个搜索框的过滤口径。
 *
 * 命中口径（三条，任一即命中）：
 *   1. 原文子串（大小写不敏感）——正文 / 思考 / 工具名 / 入参 / 结果 / 模型 id / 类型词；
 *   2. **去空白后的子串** —— 让「第3轮」「3轮」这类写法也能命中列表里带空格的「第 3 轮」；
 *   3. 纯数字查询 = **轮次精确匹配**（输入 `3` 就只要第 3 轮，不再被正文里的 "3" 淹没）。
 *
 * 查询为空 = 不过滤（`active: false`），列表照常全量渲染。
 */
import { searchableTextOf, type TrajectoryRow } from './model'

export interface TrajectorySearchResult {
  /** 生效的查询原文（已 trim） */
  query: string
  /** 查询非空（列表只显示命中行） */
  active: boolean
  /** 命中的行序号 */
  matches: Set<number>
  /** 命中里的轮次（表头要显示"N 轮命中"） */
  turns: Set<number>
  /** 命中里的工具行条数 */
  tools: number
}

const EMPTY_RESULT: TrajectorySearchResult = {
  query: '',
  active: false,
  matches: new Set(),
  turns: new Set(),
  tools: 0
}

/** 去掉所有空白（中文查询里"第 3 轮"与"第3轮"该算同一件事） */
function squeeze(value: string): string {
  return value.replace(/\s+/g, '')
}

export function searchTrajectory(
  rows: readonly TrajectoryRow[],
  query: string
): TrajectorySearchResult {
  const trimmed = query.trim()
  if (trimmed === '') return EMPTY_RESULT

  const needle = trimmed.toLowerCase()
  const squeezedNeedle = squeeze(needle)
  const turnOnly = /^\d+$/.test(trimmed) ? Number(trimmed) : null

  const matches = new Set<number>()
  const turns = new Set<number>()
  let tools = 0

  for (const row of rows) {
    const haystack = searchableTextOf(row)
    const hit =
      (turnOnly !== null && row.turn === turnOnly) ||
      haystack.toLowerCase().includes(needle) ||
      squeeze(haystack.toLowerCase()).includes(squeezedNeedle)
    if (!hit) continue
    matches.add(row.index)
    if (row.turn !== null) turns.add(row.turn)
    if (row.kind === 'tool') tools += 1
  }

  return { query: trimmed, active: true, matches, turns, tools }
}
