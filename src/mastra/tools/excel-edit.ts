/**
 * edit_excel：在**已有的** .xlsx 上做增量编辑（增量编辑 v1，与 edit_docx 同一份账）。
 *
 * 为什么要它：`create_excel` 每次都要模型把**完整** `sheets` 重发一遍，工具层没有"只改 B3"的入口
 * —— 改一个单元格就是整张表重发，钱花在**模型输出**上（round 76 的量化结论：改一处 = 整份重生成的
 * 成本量级）。所以出路是"只让模型发改动"。
 *
 * 与 edit_docx 的根本差别（这一份因此短得多）：**xlsx 能从文件里读回完整数据** —— Excel 的单元格是
 * 自描述的（值 + 类型 + 格式），ExcelJS 载入一次就拿到了整本工作簿，不需要会话级"源结构"表
 * （docx 的版式读不回来，只能记源；xlsx 不记，也不该记）。所以这里**没有** session-xlsx 表、
 * **没有**指纹比对档（docx 的 ifChanged），流程就是一条直路：
 *
 *   读盘上的 bytes → 扫 ZIP 部件（危险部件命中就整次拒绝）→ ExcelJS 载入 → 应用 ops →
 *   writeBuffer 整包重写 → 结构自检（checkPackage + assertPackage）→ 读回核验 → 写回同一个路径。
 *
 * **整段编辑是一个事务**：read/stat → 扫部件 → 载入 → 应用 → 重写 → 自检 → 核验 → 落盘，
 * 全部在**同一个** `ctx.state.runExclusive(abs, …)` 里（同一份文件的两次编辑不会交错读同一份旧字节）。
 * 锁内走 `writeArtifactLocked`（它自己**不排队**）而**不是** `saveArtifact` —— 后者会在同一目标上
 * 再排一次队，那条队列永远等不到自己。任何一步失败都**绝不写盘**（盘上的字节一个不变）。
 *
 * 三个操作（v1 的最小实用集，够表达"把某个数改成新值""表尾补几行""这格不要了"）：
 *   - `set_cell`：改一个单元格（字符串 / 数字 / 布尔 / null）；
 *   - `append_rows`：在某张表末尾追加若干行；
 *   - `clear_cell`：清空一个单元格。
 *
 * **保真边界（不装作无损）**：ExcelJS 载入 → 写回是**整包重写** —— 它建模了的东西（单元格值与类型、
 * 公式、样式、合并、列宽行高、冻结窗格、内嵌图片……）跟着走，它没建模的东西会**静静消失**。
 * 所以后者在动手之前就**整次拒绝**（见 LOSSY_PART_RULES：宏 / 图表 / 数据透视表 / 批注 / 切片器 /
 * 外部链接 / 自定义 XML / 图表工作表），且盘上的字节一个不变 —— 用户口径："宁可拒绝，不要默默丢"。
 * 即便没有这些部件，"写回去的字节与原来一一对应"也不保证（这是 ExcelJS 重新打的一个包）。
 *
 * **不支持写新公式**：`set_cell` 的字符串即使以 `=` 开头也按**普通文字**写（ExcelJS 的字符串赋值
 * 就是文本，实测落进 sharedStrings）；已有的公式（`{ formula }` 单元格）原样保留 —— 覆盖一个公式格
 * 会在回执里点名"原公式被替换"，不静默丢。
 *
 * 格式与路径的闸门（全部前置，任一条不过就拒）：
 *   ① `artifactTarget` 解析（越界 fail closed，与审批同一把尺）；
 *   ② 扩展名只收 `.xlsx`（`.xlsm` / `.xltm` 直接拒：宏保不住）；
 *   ③ 文件必须**已存在**（新做一份走 create_excel）；
 *   ④ ≤ 32MB（与工作台办公档预览同一档上限 `PREVIEW_OFFICE_MAX_BYTES`）；
 *   ⑤ 文件头必须是 OOXML zip（与工作台同一份判据 `sniffFormat`）；
 *   ⑥ `readZipEntries` 必须读通（自研解包 + CRC，读不通就是文件坏了）。
 * 中文人话一律说清"哪一步不过 + 下一步怎么走"。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { PREVIEW_OFFICE_MAX_BYTES } from '../../shared/workbench'
import { sniffFormat } from '../../main/workbench-files'
import { sha256Of } from '../fingerprint'
import { assertPackage, checkPackage, readZipEntries } from './artifact-check'
import {
  artifactNeedsApproval,
  artifactTarget,
  writeArtifactLocked,
  type ArtifactInput
} from './artifacts'
import { excelInputSchema, loadExcelJs, type CellValue } from './excel'
import { approvalSessionOf, sessionKey, statOrNull, type ToolContext } from './guard'

/** 一次调用最多几处改动（改几十处的任务是"重做"，该走 create_excel） */
export const MAX_EXCEL_OPS = 200

/** 一次 `append_rows` 最多追加多少行（与 create_excel 的单表行数上限同一量级） */
export const MAX_APPEND_ROWS = 5000

/** 回执里最多列几张工作表 / 几处改动（回执是给模型读的，不是把表抄回去） */
const SUMMARY_MAX_SHEETS = 12
const SUMMARY_MAX_CHANGES = 20

/** 回执里每个值的截断长度（认得出来是哪一格就够了） */
const SUMMARY_VALUE_CHARS = 20

/** Excel 的硬限制：单元格字符串 32767 字符、16384 列（XFD）、1048576 行（与 create_excel 同一口径） */
const MAX_CELL_CHARS = 32767
const MAX_COLUMNS = 16_384
const MAX_ROWS = 1_048_576

/** 单元格值：字符串 / 数字 / 布尔 / null（空单元格）；对象与公式不在 v1 范围 */
const cellValueSchema = z.union([
  z
    .string()
    .max(MAX_CELL_CHARS, `单元格字符串最长 ${MAX_CELL_CHARS} 字符（Excel 硬限制），请截断或拆分`),
  z.number(),
  z.boolean(),
  z.null()
])

/** 表名字段（三处共用一份，说法一致） */
const sheetNameField = z
  .string()
  .min(1)
  .describe('Worksheet name as Excel shows it; matched case-insensitively')

export const excelEditOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('set_cell'),
      sheet: sheetNameField,
      cell: z
        .string()
        .min(1)
        .describe('Cell in A1 notation, e.g. B3 or $C$4 (a single cell, not a range)'),
      value: cellValueSchema.describe(
        'New value: string, number, boolean or null (null empties the cell). Numbers stay numbers; a string starting with `=` is written as plain text, never as a formula'
      )
    })
    .describe('Set one cell; everything else in the workbook is left as it is'),
  z
    .object({
      op: z.literal('append_rows'),
      sheet: sheetNameField,
      rows: z
        .array(
          z
            .array(cellValueSchema)
            .min(1)
            .max(MAX_COLUMNS, `一行最多 ${MAX_COLUMNS} 列（Excel 上限），请拆分`)
        )
        .min(1)
        .max(MAX_APPEND_ROWS, `一次最多追加 ${MAX_APPEND_ROWS} 行，请拆分`)
        .describe(
          `Rows to add below the last used row of that sheet, in order; the outer array is rows`
        )
    })
    .describe('Append rows at the bottom of one worksheet'),
  z
    .object({
      op: z.literal('clear_cell'),
      sheet: sheetNameField,
      cell: z.string().min(1).describe('Cell in A1 notation to empty')
    })
    .describe('Empty one cell')
])

export type ExcelEditOp = z.infer<typeof excelEditOpSchema>

export const excelEditInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'The .xlsx to change, relative to the session workspace; the file must already exist (create_excel made it, or the user put it there)'
    ),
  ops: z
    .array(excelEditOpSchema)
    .min(1)
    .max(MAX_EXCEL_OPS, `一次最多改 ${MAX_EXCEL_OPS} 处，整份重写请用 create_excel`)
    .describe(
      'Edits applied in order; send only the cells and rows you change, never the whole workbook'
    ),
  expect: excelInputSchema.shape.expect
})

export type ExcelEditInput = z.infer<typeof excelEditInputSchema>

type ExcelJs = typeof import('exceljs')
type ExcelWorkbook = import('exceljs').Workbook
type ExcelWorksheet = import('exceljs').Worksheet
type ExcelCellValue = import('exceljs').CellValue

/** 一张工作表改后的摘要（sheet 名 + 用到的行 × 列） */
export interface ExcelSheetSummary {
  name: string
  rows: number
  columns: number
}

/**
 * 一处"写完之后这格应该是什么"（读回核验用）。同一个格子被后一条 op 覆盖时**以最后一条为准**
 * （`applyExcelOps` 用一张 Map 收敛，所以核验只核最终状态，不会把中间态当期望）。
 */
export interface ExcelExpectedCell {
  sheet: string
  cell: string
  value: CellValue
}

/** 应用 ops 的结果：改后摘要 + 逐条改动的中文说法 + 读回核验的期望 */
export interface ExcelEditOutcome {
  sheets: ExcelSheetSummary[]
  changes: string[]
  expected: ExcelExpectedCell[]
}

/**
 * 危险部件：**命中任何一条就整次拒绝**（不动盘上的字节）。
 *
 * 判据是"ExcelJS 4.4 载入→写回会不会把它带走"——它没建模的部件在整包重写里会**静静消失**，
 * 而"用户的图表/宏/批注没了"是最坏的一种失败（用户看不到任何提示）。所以宁可拒：
 * 拒绝时说得清"会丢什么 + 两条出口"，比默默丢一份少了图表的表强。
 *
 * 名单（对着 ExcelJS 4.4 的模型逐条列出来的）：
 *   - `xl/vbaProject.bin`：VBA 宏（连 .xlsm 一起在扩展名那一步就拒了，这里是 .xlsx 里夹带宏的兜底）；
 *   - `xl/charts/`：图表；`xl/chartsheets/` 与 `xl/worksheets/chartsheet*`：图表工作表；
 *   - `xl/pivotTables/` `xl/pivotCache/`：数据透视表与它的缓存；
 *   - `xl/comments*.xml`（老式批注）/ `xl/threadedComments/`（新版批注）；
 *   - `xl/slicers/`：切片器；`xl/externalLinks/`：外部链接；`customXml/`：自定义 XML。
 *
 * 另外**内容**层面还查一次 chartsheet：图表工作表在 rels 里被引用（`Target="chartsheets/…"`），
 * 部件名万一不是上面那几种写法，这一条兜住。查 `.rels` 是保守方向：多认出一次 = 多拒一次，
 * 不会把有图表工作表的文件放过去。
 */
const LOSSY_PART_RULES: ReadonlyArray<{ match: (name: string) => boolean; what: string }> = [
  { match: (name) => name === 'xl/vbaproject.bin', what: 'VBA 宏' },
  { match: (name) => name.startsWith('xl/charts/'), what: '图表' },
  { match: (name) => name.startsWith('xl/chartsheets/'), what: '图表工作表' },
  { match: (name) => name.startsWith('xl/worksheets/chartsheet'), what: '图表工作表' },
  { match: (name) => name.startsWith('xl/pivottables/'), what: '数据透视表' },
  { match: (name) => name.startsWith('xl/pivotcache/'), what: '数据透视缓存' },
  { match: (name) => /^xl\/comments\d*\.xml$/.test(name), what: '批注' },
  { match: (name) => name.startsWith('xl/threadedcomments/'), what: '新版批注' },
  { match: (name) => name.startsWith('xl/slicers/'), what: '切片器' },
  { match: (name) => name.startsWith('xl/externallinks/'), what: '外部链接' },
  { match: (name) => name.startsWith('customxml/'), what: '自定义 XML' }
]

/** 命中的危险部件（部件名 + 它是什么）；空数组 = 可以安全地整包重写 */
export function findLossyParts(
  entries: Map<string, Buffer>
): Array<{ part: string; what: string }> {
  const hits: Array<{ part: string; what: string }> = []
  for (const name of entries.keys()) {
    const lower = name.toLowerCase()
    for (const rule of LOSSY_PART_RULES) {
      if (rule.match(lower)) {
        hits.push({ part: name, what: rule.what })
        break
      }
    }
  }

  // 内容兜底：任何 .rels 里引用了 chartsheet（部件名不是常见写法时）
  if (hits.length === 0) {
    for (const [name, data] of entries) {
      if (!name.toLowerCase().endsWith('.rels')) continue
      if (/chartsheet/i.test(data.toString('utf8'))) {
        hits.push({ part: name, what: '图表工作表' })
        break
      }
    }
  }
  return hits
}

/** A1 单元格地址（单格；允许 `$B$3` 这种绝对写法，不认区域与整行整列） */
const A1_REFERENCE = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/

/**
 * A1 地址 → `{ row, column }`（1 起）。非法写法 / 超 Excel 行列上限一律**抛中文人话**：
 * 这是"模型写歪了"里最常见的一种，回执要把正确写法与上限都摆出来。
 */
export function parseA1(reference: string): { row: number; column: number } {
  const match = A1_REFERENCE.exec(reference.trim())
  if (match === null) {
    throw new Error(
      `不是合法的单元格地址：「${reference}」—— 要单个单元格的 A1 写法（如 B3，允许 $B$3），不能是区域（A1:B2）、整行或整列。`
    )
  }
  const column = columnNumber(match[1] ?? '')
  const row = Number(match[2])
  if (row < 1 || row > MAX_ROWS || column < 1 || column > MAX_COLUMNS) {
    throw new Error(
      `单元格地址「${reference}」超了 Excel 的行列上限（最多 ${MAX_ROWS} 行 × ${MAX_COLUMNS} 列）：解析出来是第 ${row} 行、第 ${column} 列。`
    )
  }
  return { row, column }
}

/** 列字母 → 列号（`A` = 1、`XFD` = 16384）；正则已保证只含字母 */
function columnNumber(letters: string): number {
  let value = 0
  for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64)
  return value
}

/**
 * 按名字找工作表：先精确匹配，再**大小写不敏感**兜一次（Excel 不允许两张表只差大小写，所以这一步
 * 不会产生歧义）。找不到给中文人话，并把这份工作簿**有哪些表**列出来（模型下一轮就能改对）。
 */
export function findSheet(workbook: ExcelWorkbook, name: string): ExcelWorksheet | null {
  const exact = workbook.getWorksheet(name)
  if (exact !== undefined) return exact

  const wanted = name.trim().toLowerCase()
  return workbook.worksheets.find((sheet) => sheet.name.toLowerCase() === wanted) ?? null
}

/**
 * 应用 ops（**就地改这份 workbook**；盘与库都不碰）。校验全部前置：表名不存在、A1 非法、
 * 追加后越 Excel 行上限、超过一次调用上限，一律**抛中文人话**、一个字都不改。
 *
 * 每一步都按**当前**状态算（所以"先 append 三行、再 set_cell 到刚追加的那一行"能按模型读回执的
 * 直觉生效）。返回改后摘要、逐条改动说法（回执用）与读回核验的期望。
 */
export function applyExcelOps(
  workbook: ExcelWorkbook,
  ops: readonly ExcelEditOp[],
  path: string
): ExcelEditOutcome {
  const changes: string[] = []
  // 期望按"最后一个写它的 op 说了算"收敛：同一个格子被后面的 op 覆盖时，核验只核最终状态
  const expected = new Map<string, ExcelExpectedCell>()
  const remember = (sheet: string, cell: string, value: CellValue): void => {
    expected.set(`${sheet.toLowerCase()}\u0000${cell}`, { sheet, cell, value })
  }

  for (const op of ops) {
    const sheet = findSheet(workbook, op.sheet)
    if (sheet === null) throw new Error(unknownSheetMessage(workbook, op.sheet, path))

    switch (op.op) {
      case 'set_cell': {
        const { row, column } = parseA1(op.cell)
        const cell = sheet.getCell(row, column)
        const previous = cell.value
        cell.value = op.value
        remember(sheet.name, A1_TEXT(row, column), op.value)
        changes.push(
          `${sheet.name}!${A1_TEXT(row, column)} = ${displayValue(op.value)}${replacedFormula(previous)}`
        )
        break
      }
      case 'clear_cell': {
        const { row, column } = parseA1(op.cell)
        const cell = sheet.getCell(row, column)
        const previous = cell.value
        cell.value = null
        remember(sheet.name, A1_TEXT(row, column), null)
        changes.push(`${sheet.name}!${A1_TEXT(row, column)} 清空${replacedFormula(previous)}`)
        break
      }
      case 'append_rows': {
        const start = sheet.rowCount + 1
        const end = start + op.rows.length - 1
        if (end > MAX_ROWS) {
          throw new Error(
            `改不了「${sheet.name}」：从第 ${start} 行追加 ${op.rows.length} 行会到第 ${end} 行，超过 Excel 的 ${MAX_ROWS} 行上限。请先清理这张表，或另做一份。`
          )
        }
        op.rows.forEach((row, offset) => {
          sheet.addRow([...row])
          row.forEach((value, column) => {
            remember(sheet.name, A1_TEXT(start + offset, column + 1), value)
          })
        })
        changes.push(`${sheet.name} 追加 ${op.rows.length} 行（第 ${start}–${end} 行）`)
        break
      }
    }
  }

  return { sheets: summarizeSheets(workbook), changes, expected: [...expected.values()] }
}

/** 改后每张表的摘要（顺序就是工作簿里的顺序） */
function summarizeSheets(workbook: ExcelWorkbook): ExcelSheetSummary[] {
  return workbook.worksheets.map((sheet) => ({
    name: sheet.name,
    rows: sheet.rowCount,
    columns: sheet.columnCount
  }))
}

/** 表名不存在的人话：把"有哪些表"报出来（模型常常只是把表名写歪了） */
function unknownSheetMessage(workbook: ExcelWorkbook, name: string, path: string): string {
  const names = workbook.worksheets.map((sheet) => sheet.name)
  const shown = names.slice(0, SUMMARY_MAX_SHEETS)
  const rest = names.length > shown.length ? `、…等 ${names.length} 张` : ''
  return `《${path}》里没有工作表「${name}」。这份工作簿的工作表是：${shown.join('、')}${rest} —— 表名按这个写。我一个单元格都没改。`
}

/** 行号 + 列号 → 地址文本（只用于回执；与模型给的写法归一，`b3` 也回 `B3`） */
function A1_TEXT(row: number, column: number): string {
  let letters = ''
  let value = column
  while (value > 0) {
    const remainder = (value - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    value = Math.floor((value - 1) / 26)
  }
  return `${letters}${row}`
}

/** 覆盖掉一个公式格时补一句（不静默丢：模型/用户该知道那个公式没了） */
function replacedFormula(previous: ExcelCellValue | undefined): string {
  const formula =
    typeof previous === 'object' && previous !== null && 'formula' in previous
      ? String((previous as { formula?: unknown }).formula ?? '')
      : ''
  return formula === '' ? '' : `（原来是公式 =${formula}，已按你的要求替换）`
}

/** 值 → 回执里的一句话（长字符串截断；null 写作"空"） */
function displayValue(value: ExcelCellValue | undefined): string {
  if (value === null || value === undefined) return '空'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') {
    const flat = value.replace(/\s+/g, ' ').trim()
    return `「${flat.length > SUMMARY_VALUE_CHARS ? `${flat.slice(0, SUMMARY_VALUE_CHARS)}…` : flat}」`
  }
  // 只可能读到对象（富文本 / 公式 / 超链接）：模型给不了这些，回执里如实写成 JSON 片段
  return JSON.stringify(value)
}

/** 回执里的「工作表摘要」：`工作表：明细 9 行 × 4 列、汇总 2 行 × 2 列` */
export function sheetSummaryText(sheets: readonly ExcelSheetSummary[]): string {
  const shown = sheets
    .slice(0, SUMMARY_MAX_SHEETS)
    .map((sheet) => `${sheet.name} ${sheet.rows} 行 × ${sheet.columns} 列`)
  const rest = sheets.length > shown.length ? `、…等 ${sheets.length} 张` : ''
  return `工作表：${shown.join('、')}${rest}`
}

/** 回执里的「本次改动」：逐条改动 + 条数（太长只列前几处） */
export function changeSummaryText(changes: readonly string[]): string {
  const shown = changes.slice(0, SUMMARY_MAX_CHANGES)
  const rest = changes.length > shown.length ? `、…等 ${changes.length} 处` : ''
  return `本次改动：${shown.join('、')}${rest}`
}

/** 装载 ExcelJS（与 create_excel 同一份口径：CJS 出口只有 default） */
async function loadWorkbook(
  ExcelJS: ExcelJs,
  bytes: Uint8Array,
  path: string
): Promise<ExcelWorkbook> {
  const workbook = new ExcelJS.Workbook()
  try {
    // exceljs 的 d.ts 把自己的 Buffer 声明成 `extends ArrayBuffer`，而运行期收的就是 Node Buffer
    await workbook.xlsx.load(
      Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]
    )
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `读不出《${path}》这个 Excel 文件（包结构读不通：${detail}）—— 文件可能已损坏或不是标准的 .xlsx。我没有动它。`
    )
  }
  return workbook
}

/**
 * 写回之后再**读一遍**核验：每一处改动都真的在包里（`set_cell` 的值、`append_rows` 的那几行、
 * `clear_cell` 的空）。
 *
 * 为什么值得这一遍：ExcelJS 的 `writeBuffer()` 成功 ≠ 值真的进了包（写歪了、被上限截掉、
 * 类型没落对都可能）。核不过就**不写盘**（盘上那份连一个字节都不动），回执里点出是哪一处对不上。
 * 这一遍用的是同一个库，所以它证的是"库认自己写出去的包"，不是 OOXML 层面的保真 ——
 * 后者由 `checkPackage`（自研解包 + CRC）那一层证。
 */
async function verifyEdits(
  ExcelJS: ExcelJs,
  bytes: Uint8Array,
  outcome: ExcelEditOutcome,
  path: string
): Promise<void> {
  const workbook = await loadWorkbook(ExcelJS, bytes, path)

  for (const item of outcome.expected) {
    const sheet = findSheet(workbook, item.sheet)
    if (sheet === null) throw verifyFailure(`工作表「${item.sheet}」在改后的包里找不到了`)

    const actual = sheet.getCell(item.cell).value
    if (!sameValue(actual, item.value)) {
      throw verifyFailure(
        `${item.sheet}!${item.cell} 是 ${displayValue(actual)}，应该是 ${displayValue(item.value)}`
      )
    }
  }
}

/** 读回核验不过时的错误（调用方直接 throw：这类"库写出去的包对不上"是环境/库的问题，不是模型能修的） */
function verifyFailure(detail: string): Error {
  return new Error(`改完读回来核不上：${detail}。这次编辑没有落盘（盘上那份没动）。`)
}

/**
 * 读回来的值是不是"我们写进去的那个"。
 * null 与空串在 Excel 里都是"没有内容"（清空之后读回来可能是任一种），两种写法都算对上。
 */
function sameValue(actual: ExcelCellValue | undefined, expected: ExcelCellValue): boolean {
  if (expected === null) return actual === null || actual === undefined || actual === ''
  if (typeof expected === 'string') return actual === expected
  if (typeof expected === 'number') return actual === expected
  return actual === expected
}

/** 自检的样本文本：ops 里第一个非空字符串值（取不到就给空数组，该检查项不出现） */
function sampleEditedText(ops: readonly ExcelEditOp[]): string[] {
  for (const op of ops) {
    if (op.op === 'set_cell' && typeof op.value === 'string' && op.value !== '') return [op.value]
    if (op.op === 'append_rows') {
      for (const row of op.rows) {
        for (const value of row) {
          if (typeof value === 'string' && value !== '') return [value]
        }
      }
    }
  }
  return []
}

/** 指纹的短写法（回执里点出"我读进去的是哪一份"） */
function shortSha(sha: string): string {
  return sha.slice(0, 12)
}

/** 扩展名闸门：只收 .xlsx；`.xlsm` / `.xltm` 单独给人话（宏保不住，不是"格式不认识"） */
function assertXlsxExtension(abs: string): void {
  const base = abs.slice(Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  const extension = dot <= 0 ? '' : base.slice(dot).toLowerCase()

  if (extension === '.xlsm' || extension === '.xltm') {
    throw new Error(
      `edit_excel 不收带宏的工作簿（${extension}）：宏（VBA）在整包重写时会丢，这个工具保不住它。` +
        '出口：① 在 Excel 里「另存为」成 .xlsx（去掉宏）再改；② 要的是数据表就按新内容重发 create_excel。'
    )
  }
  if (extension !== '.xlsx') {
    throw new Error(
      `edit_excel 只改 .xlsx（这份是「${extension === '' ? '没有扩展名' : extension}」）：` +
        '新做一份数据表用 create_excel；旧版 .xls 请先在 Excel 里另存为 .xlsx。'
    )
  }
}

function notFoundMessage(path: string, abs: string): string {
  return (
    `《${path}》在盘上找不到（解析到的是 ${abs}）：edit_excel 只改**已有**的文件 —— ` +
    '新做一份用 create_excel；路径写错了就用 create_excel 回执里的那个路径。我没有动任何文件。'
  )
}

function tooLargeMessage(path: string, size: number): string {
  const mb = Math.round(size / (1024 * 1024))
  return (
    `《${path}》有 ${mb}MB，超过 edit_excel 的 32MB 上限：这么大的表不适合"读进来整包重写"，` +
    '请先拆表（或把明细放到单独的工作簿里）。我没有动它。'
  )
}

function notXlsxMessage(path: string): string {
  return (
    `《${path}》的字节不像 OOXML 包（文件头对不上 zip）：扩展名是 .xlsx，内容却是别的格式 —— ` +
    '文件可能被改过后缀、或根本不是 Excel 文件。我没有动它。'
  )
}

function lossyMessage(path: string, hits: ReadonlyArray<{ part: string; what: string }>): string {
  const listed = hits
    .slice(0, 5)
    .map((hit) => `${hit.part}（${hit.what}）`)
    .join('、')
  const rest = hits.length > 5 ? `等 ${hits.length} 处` : ''
  return (
    `改不了《${path}》：这份工作簿带着"整包重写会丢掉"的部件 —— ${listed}${rest}。` +
    'edit_excel 用 ExcelJS 重新打包整个文件，这些部件它认不得，写回去就会**静默消失**，所以这次调用被拒了，盘上的字节一个都没动。' +
    '出口：① 在 Excel 里删掉这些部件（或另存为一份纯数据的 .xlsx）再改；' +
    '② 要改的那张表按新样子重发 create_excel 另做一份。'
  )
}

/** 文件在这次编辑期间被别的东西改过（另一个进程 / 用户开着 Excel 保存了）→ 不写盘 */
function changedDuringEditMessage(path: string, before: string, now: string): string {
  return (
    `《${path}》在这次编辑期间被别的东西改过（我读进去的是 sha256 ${shortSha(before)}，现在是 ${shortSha(now)}）：` +
    '我没有写盘 —— 请确认没有别的程序正在编辑它（尤其是 Excel 里那份没关掉），然后重试这次改动。'
  )
}

export async function createEditExcelTool(ctx: ToolContext): Promise<Tool<ExcelEditInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  const planInput = (input: ExcelEditInput): ArtifactInput => ({ path: input.path })

  return createTool({
    id: 'edit_excel',
    description:
      'Change an existing spreadsheet (.xlsx) in place: set one cell, append rows at the bottom of a sheet, or empty a cell. ' +
      'Send only the cells you change, never the whole workbook; the file must already exist (create it with create_excel). ' +
      'Rows and columns are addressed as Excel shows them (A1 notation for cells, sheet names as they appear). ' +
      'The workbook is rebuilt from ExcelJS and written back to the same path, keeping formulas, styles, merged cells, column widths, row heights and frozen panes; ' +
      'a string starting with `=` is plain text and never becomes a formula, and existing formulas are kept (overwriting one is reported). ' +
      'Not byte-for-byte faithful: a file carrying macros, charts, pivot tables, comments, slicers, external links or custom XML is refused outright rather than silently losing them. ' +
      'Use create_excel for a new workbook or a full rewrite.',
    inputSchema: excelEditInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      artifactNeedsApproval(
        ctx,
        'edit_excel',
        planInput(input),
        'xlsx',
        '表格',
        approvalSessionOf(approval)
      ),
    execute: async (input, context) => {
      const session = sessionKey(context)
      // 与审批走同一个目标解析（"批的是 A、写的是 B"这类错配在这里被结构性排除：path 是必填的）
      const abs = artifactTarget(ctx, planInput(input), 'xlsx', '表格', session)
      assertXlsxExtension(abs)

      // 整段编辑是一个事务：读 → 扫部件 → 载入 → 改 → 重写 → 自检 → 核验 → 落盘，都在同一个目标的
      // 队列里。同一份文件的两次编辑因此不会交错读到同一份旧字节（否则后写的那次会覆盖前一次，丢更新）。
      return await ctx.state.runExclusive(abs, async () => {
        const stat = await statOrNull(ctx, abs)
        if (stat === null) throw new Error(notFoundMessage(input.path, abs))
        if (stat.isDirectory()) throw new Error(`改不了 ${abs}：它是一个目录，不是 Excel 文件。`)
        if (stat.size > PREVIEW_OFFICE_MAX_BYTES)
          throw new Error(tooLargeMessage(input.path, stat.size))

        const bytes = await ctx.fs.readFile(abs)
        if (bytes.byteLength > PREVIEW_OFFICE_MAX_BYTES) {
          throw new Error(tooLargeMessage(input.path, bytes.byteLength))
        }
        // 指纹：只用于"这次编辑期间盘上那份有没有被别的东西改过"（runExclusive 已经把我们自己的写
        // 串行了，不需要它防并发覆盖），以及拒绝时回执里点出"我读进去的是哪一份"
        const before = sha256Of(bytes)

        // 格式两道闸（与工作台同一份判据）：文件头是 OOXML zip + 自研解包读得通
        if (sniffFormat(bytes) !== 'ooxml') throw new Error(notXlsxMessage(input.path))
        let entries: Map<string, Buffer>
        try {
          entries = readZipEntries(bytes)
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause)
          throw new Error(
            `读不出《${input.path}》这个 Excel 文件（包结构不通：${detail}）—— 文件可能已损坏。我没有动它。`
          )
        }

        // 危险部件：命中就整次拒绝（盘上的字节一个不变，绝不静默降级）
        const lossy = findLossyParts(entries)
        if (lossy.length > 0) throw new Error(lossyMessage(input.path, lossy))

        const ExcelJS = await loadExcelJs()
        const workbook = await loadWorkbook(ExcelJS, bytes, input.path)
        const outcome = applyExcelOps(workbook, input.ops, input.path)
        const out = Buffer.from(await workbook.xlsx.writeBuffer())

        // 产出后结构自检（自研解包 + CRC）：包都读不通就不落盘；某项不过照写但回执注明
        const check = checkPackage(out, {
          kind: 'xlsx',
          sheets: outcome.sheets.length,
          texts: sampleEditedText(input.ops),
          assert: { count: input.expect?.sheets, contains: input.expect?.contains }
        })
        assertPackage(check)

        // 改完读回来核一遍（核不上就不写盘）
        await verifyEdits(ExcelJS, out, outcome, input.path)

        // 写盘前再确认一次盘上那份与刚读进去的是同一份（用户开着 Excel 保存过 / 别的进程写过）
        const again = await statOrNull(ctx, abs)
        if (again === null || again.isDirectory()) throw new Error(notFoundMessage(input.path, abs))
        const reread = await ctx.fs.readFile(abs)
        const now = sha256Of(reread)
        if (now !== before) throw new Error(changedDuringEditMessage(input.path, before, now))

        // 锁内落盘（**不能**在锁里调 saveArtifact：那会在同一目标上再排一次队，死锁）
        const receipt = await writeArtifactLocked(
          ctx,
          abs,
          out,
          `${outcome.sheets.length} 张工作表`,
          {
            session,
            check: check.note
          }
        )

        return [receipt, sheetSummaryText(outcome.sheets), changeSummaryText(outcome.changes)].join(
          '；'
        )
      })
    }
  })
}
