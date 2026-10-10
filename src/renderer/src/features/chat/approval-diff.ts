/**
 * 审批卡的行级 diff（T13）：不引依赖，自己写一个最小实现。
 *
 * 输入取自工具入参（渲染端拿不到文件本身，也不需要）：
 *   - `edit`：oldText → newText —— 这是"最小改动"的精确表达；
 *   - `write`：整文件覆盖/新建 —— 没有旧内容可用，按"全部新增"呈现（结果内容本身）。
 * 行级 LCS：先掐掉公共前后缀（真实 diff 的绝大部分就是这两段），中间再做 DP；
 * 中间块太大时退化成"全删 + 全加"（仍然是对的，只是少一些上下文行）。
 * 渲染行数上限由 MAX_DIFF_LINES 收口，超过就在中间折叠（不渲染上万行 DOM）。
 */
import { normalizeToolName } from '@shared/permissions'

export type DiffLineKind = 'add' | 'remove' | 'context' | 'gap'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

/** 渲染上限（超过就在中间折叠一段） */
export const MAX_DIFF_LINES = 400

/** 中间块 DP 的规模上限（超过就退化成整块替换；行数乘积） */
const LCS_CELL_LIMIT = 200_000

function splitLines(text: string): string[] {
  // 空串 = 零行（新建文件的 diff 就是清一色 add）；其余按 \n 切（\r 留在行尾，原样显示）
  return text === '' ? [] : text.split('\n')
}

/** 行级 diff（公共前后缀 + 中间 LCS） */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const before = splitLines(oldText)
  const after = splitLines(newText)

  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++

  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }

  const middleBefore = before.slice(head, before.length - tail)
  const middleAfter = after.slice(head, after.length - tail)

  const lines: DiffLine[] = []
  for (const text of before.slice(0, head)) lines.push({ kind: 'context', text })
  lines.push(...middleDiff(middleBefore, middleAfter))
  for (const text of before.slice(before.length - tail)) lines.push({ kind: 'context', text })

  return fold(lines)
}

/** 中间块：小规模用 LCS 求最长公共子序列，太大就整块替换（全删 + 全加） */
function middleDiff(before: string[], after: string[]): DiffLine[] {
  if (before.length === 0) return after.map((text) => ({ kind: 'add' as const, text }))
  if (after.length === 0) return before.map((text) => ({ kind: 'remove' as const, text }))
  if (before.length * after.length > LCS_CELL_LIMIT) {
    return [
      ...before.map((text) => ({ kind: 'remove' as const, text })),
      ...after.map((text) => ({ kind: 'add' as const, text }))
    ]
  }

  // 标准 LCS 长度表（从后往前填），再顺着走一遍产出编辑脚本
  const rows = before.length + 1
  const cols = after.length + 1
  const lengths = new Int32Array(rows * cols)
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i * cols + j] =
        before[i] === after[j]
          ? lengths[(i + 1) * cols + j + 1] + 1
          : Math.max(lengths[(i + 1) * cols + j], lengths[i * cols + j + 1])
    }
  }

  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ kind: 'context', text: before[i] })
      i++
      j++
    } else if (lengths[(i + 1) * cols + j] >= lengths[i * cols + j + 1]) {
      lines.push({ kind: 'remove', text: before[i] })
      i++
    } else {
      lines.push({ kind: 'add', text: after[j] })
      j++
    }
  }
  while (i < before.length) lines.push({ kind: 'remove', text: before[i++] })
  while (j < after.length) lines.push({ kind: 'add', text: after[j++] })
  return lines
}

/** 超过上限就在中间折叠：头尾各留一半，中间用一条 gap 行交代跳过了多少行 */
function fold(lines: DiffLine[]): DiffLine[] {
  if (lines.length <= MAX_DIFF_LINES) return lines
  const half = Math.floor(MAX_DIFF_LINES / 2)
  const omitted = lines.length - half * 2
  return [
    ...lines.slice(0, half),
    { kind: 'gap', text: `中间省略 ${omitted} 行` },
    ...lines.slice(lines.length - half)
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 这次工具调用的 diff 素材（认得出的工具才给；认不出回 null，卡片退回"只看入参"）。
 * 认得出的：edit（oldText → newText）、write（content 全部新增）。
 */
export function approvalDiff(toolName: string, input: unknown): DiffLine[] | null {
  if (!isRecord(input)) return null
  const tool = normalizeToolName(toolName)

  if (tool === 'edit') {
    const oldText = input.oldText
    const newText = input.newText
    if (typeof oldText !== 'string' || typeof newText !== 'string') return null
    return diffLines(oldText, newText)
  }

  if (tool === 'write') {
    const content = input.content
    if (typeof content !== 'string') return null
    return diffLines('', content)
  }

  return null
}
