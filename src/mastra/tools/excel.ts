/**
 * create_excel：把二维表格数据写成 .xlsx 工作簿（模块 4 格式②）。
 *
 * 口径：
 *   - **数字保号、字符串原样**：不做类型推断、不做单位换算 —— 模型给什么就写什么，
 *     单元格类型跟着输入走（ExcelJS 的 addRow 按值类型落 cell）。
 *   - **不支持公式单元格**：要计算的值请先算好再写数字；`=` 开头的字符串会被当普通文本原样写入，
 *     Excel 打开时不会执行它（要真公式得用 Excel 自己再编辑）。
 *   - 表名按 Excel 的硬约束归一：非法字符换空格、最长 31 字符、空名兜底、重名加序号后缀
 *     （ExcelJS 对重名会报错，这里先自己收敛掉，免得整个产出物失败）。
 *   - **断言**（`expect`）：用户说"必须 3 张表""表里必须有这几个字"时写进来；文本断言按**整本
 *     工作簿**的单元格文字核（不分工作表），没过不拦落盘、但回执会点名差在哪。
 *   - 内容与落盘分离：`renderXlsx` 是纯入口（表数据 → 字节，无 IO），工具只负责解析路径与写文件。
 *   - 依赖：exceljs（纯 JS，无原生依赖）。主进程产物是 CJS 而它的出口只有 `default` 命名空间，
 *     所以动态 import 后走 `.default`（Node 的 CJS 互操作把 module.exports 放在 default 上）。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { assertPackage, checkPackage } from './artifact-check'
import {
  artifactNeedsApproval,
  artifactTarget,
  saveArtifact,
  type ArtifactInput
} from './artifacts'
import { approvalSessionOf, sessionKey, type ToolContext } from './guard'

/** 输入上限（依据：模块 4 报告 §六.6 登记的"输入规模无上限"）：超限让模型知道怎么改 */
const MAX_SHEETS = 50
const MAX_ROWS_PER_SHEET = 5000
/** Excel 的硬限制：单元格字符串 32767 字符，超了文件会坏 */
const MAX_CELL_CHARS = 32767
/** 断言条数上限：回执里要逐条报，太多会把上下文吃光 */
const MAX_EXPECTS = 20

/** 单元格值：只允许这三种标量 + null（空单元格）；对象/公式不在 v1 范围 */
const cellSchema = z.union([
  z
    .string()
    .max(MAX_CELL_CHARS, `单元格字符串最长 ${MAX_CELL_CHARS} 字符（Excel 硬限制），请截断或拆分`),
  z.number(),
  z.boolean(),
  z.null()
])

export const excelInputSchema = z.object({
  sheets: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .describe('Sheet name; names over 31 characters or containing []:*?/\\ are normalised'),
        rows: z
          .array(z.array(cellSchema))
          .max(MAX_ROWS_PER_SHEET, `一张表最多 ${MAX_ROWS_PER_SHEET} 行，请拆分工作表`)
          .describe(
            `Two-dimensional cell array, outer array is rows, at most ${MAX_ROWS_PER_SHEET} rows: numbers stay numbers, strings are written as-is, ` +
              `null is an empty cell. Formulas are not supported: compute values yourself and write the numbers, ` +
              `and a string starting with \`=\` is written as plain text (at most ${MAX_CELL_CHARS} characters)`
          )
      })
    )
    .min(1)
    .max(MAX_SHEETS, `最多 ${MAX_SHEETS} 张工作表，请拆分工作簿`)
    .describe(`Sheets in order, at most ${MAX_SHEETS}`),
  title: z
    .string()
    .optional()
    .describe('Used to derive the file name when path is omitted; defaults to the first sheet name'),
  expect: z
    .object({
      sheets: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Exact number of sheets the user asked for'),
      contains: z
        .array(z.object({ text: z.string().min(1).describe('Text that must appear') }))
        .max(MAX_EXPECTS, `最多 ${MAX_EXPECTS} 条断言，请精选`)
        .optional()
        .describe('Text the user named as required, checked across all cell text in the workbook')
    })
    .optional()
    .describe(
      'Hard requirements the user stated, such as an exact sheet count or specific text; each one is checked and misses are reported in the result'
    ),
  path: z
    .string()
    .optional()
    .describe('Output path relative to the session workspace; when omitted the file name derives from the title')
})

export type ExcelInput = z.infer<typeof excelInputSchema>

export type CellValue = string | number | boolean | null

export interface ExcelSheetInput {
  name: string
  rows: ReadonlyArray<ReadonlyArray<CellValue>>
}

/** Excel 的工作表名硬约束 */
const SHEET_NAME_MAX = 31
/** Excel 不允许出现在表名里的字符（[]:*?/\） */
const SHEET_NAME_ILLEGAL = /[\\/?*[\]:]/g

/**
 * 渲染一份 xlsx（纯函数式入口：没有 IO，测试直接拿返回值解包/读回）。
 * 空 `sheets` 会抛错（schema 已经挡住，这里兜住直接调用的场景）。
 */
export async function renderXlsx(sheets: readonly ExcelSheetInput[]): Promise<Buffer> {
  if (sheets.length === 0) throw new Error('renderXlsx：至少要有一张工作表')

  const ExcelJS = await loadExcelJs()
  const workbook = new ExcelJS.Workbook()
  const used = new Set<string>()

  sheets.forEach((sheet, index) => {
    const worksheet = workbook.addWorksheet(uniqueSheetName(sheet.name, index, used))
    for (const row of sheet.rows) worksheet.addRow([...row])
  })

  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/**
 * exceljs 的动态装载：它的 CJS 出口是 `module.exports = require('./lib/exceljs.nodejs.js')`，
 * Node 的 ESM 互操作拿不到具名导出（实测 keys 只有 default），所以走 `.default`；
 * 类型面用 `typeof import('exceljs')` 显式标注（d.ts 是具名导出风格，没有 default 声明）。
 */
async function loadExcelJs(): Promise<typeof import('exceljs')> {
  const loaded = (await import('exceljs')) as unknown as { default: typeof import('exceljs') }
  return loaded.default
}

/** 归一表名：非法字符 → 空格、截断 31、空名兜底 `工作表N`、重名加 `(2)` `(3)` 后缀 */
function uniqueSheetName(name: string, index: number, used: Set<string>): string {
  const base =
    name
      .replace(SHEET_NAME_ILLEGAL, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, SHEET_NAME_MAX)
      .trim() || `工作表${index + 1}`

  let candidate = base
  let suffix = 2
  while (used.has(candidate.toLowerCase())) {
    const tag = `(${suffix++})`
    candidate = `${base.slice(0, SHEET_NAME_MAX - tag.length)}${tag}`
  }
  used.add(candidate.toLowerCase())
  return candidate
}

export async function createExcelTool(ctx: ToolContext): Promise<Tool<ExcelInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  const planInput = (input: ExcelInput): ArtifactInput => ({
    title: input.title ?? input.sheets[0]?.name,
    path: input.path
  })

  return createTool({
    id: 'create_excel',
    description:
      'Write tabular data as an Excel workbook (.xlsx); saved to the session workspace, returns path and bytes. ' +
      'Each sheets entry is one worksheet; rows is a two-dimensional cell array. ' +
      'Use it for detail tables, lists and data exports. ' +
      'Not for a table that is part of prose (create_report / create_docx) or one page of a deck (create_ppt).',
    inputSchema: excelInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      artifactNeedsApproval(
        ctx,
        'create_excel',
        planInput(input),
        'xlsx',
        '表格',
        approvalSessionOf(approval)
      ),
    execute: async (input, context) => {
      const session = sessionKey(context)
      const abs = artifactTarget(ctx, planInput(input), 'xlsx', '表格', session)
      const bytes = await renderXlsx(input.sheets)

      // 产出后结构自检：包都读不通（fatal）就不落盘；某项不过照写但回执注明（断言没过也照写）
      const check = checkPackage(bytes, {
        kind: 'xlsx',
        sheets: input.sheets.length,
        texts: sampleText(input.sheets),
        assert: { count: input.expect?.sheets, contains: input.expect?.contains }
      })
      assertPackage(check)

      const kind = `${input.sheets.length} 张工作表${summarizeRows(input.sheets)}`

      return await saveArtifact(ctx, abs, bytes, kind, { session, check: check.note })
    }
  })
}

/** 自检的样本文本：输入里第一个非空字符串单元格（取不到就给空数组，该检查项不出现） */
function sampleText(sheets: readonly ExcelSheetInput[]): string[] {
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      for (const cell of row) {
        if (typeof cell === 'string' && cell.trim() !== '') return [cell]
      }
    }
  }
  return []
}

/** 回执里补一句总行数（工具卡上一眼能看出产了多少数据） */
function summarizeRows(sheets: readonly ExcelSheetInput[]): string {
  const rows = sheets.reduce((total, sheet) => total + sheet.rows.length, 0)
  return `／${rows} 行`
}
