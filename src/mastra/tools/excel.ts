/**
 * create_excel：把二维表格数据写成 .xlsx 工作簿（模块 4 格式②）。
 *
 * 口径：
 *   - **数字保号、字符串原样**：不做类型推断、不做单位换算 —— 模型给什么就写什么，
 *     单元格类型跟着输入走（ExcelJS 的 addRow 按值类型落 cell）。
 *   - 表名按 Excel 的硬约束归一：非法字符换空格、最长 31 字符、空名兜底、重名加序号后缀
 *     （ExcelJS 对重名会报错，这里先自己收敛掉，免得整个产出物失败）。
 *   - 内容与落盘分离：`renderXlsx` 是纯入口（表数据 → 字节，无 IO），工具只负责解析路径与写文件。
 *   - 依赖：exceljs（纯 JS，无原生依赖）。主进程产物是 CJS 而它的出口只有 `default` 命名空间，
 *     所以动态 import 后走 `.default`（Node 的 CJS 互操作把 module.exports 放在 default 上）。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import {
  artifactNeedsApproval,
  artifactTarget,
  saveArtifact,
  type ArtifactInput
} from './artifacts'
import { sessionKey, type ToolContext } from './guard'

/** 单元格值：只允许这三种标量 + null（空单元格）；对象/公式不在 v1 范围 */
const cellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const excelInputSchema = z.object({
  sheets: z
    .array(
      z.object({
        name: z.string().min(1).describe('工作表名（超过 31 字符或含 []:*?/\\ 会被自动归一）'),
        rows: z
          .array(z.array(cellSchema))
          .describe('二维单元格数组（外层是行）：数字保持数字，字符串原样，null 是空单元格')
      })
    )
    .min(1)
    .describe('工作表列表（按顺序落在工作簿里）'),
  title: z.string().optional().describe('不给 path 时用它派生文件名；缺省取第一个工作表名'),
  path: z.string().optional().describe('落盘路径（相对当前会话工作区；不给就按标题派生文件名）')
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
      '把二维表格数据写成 Excel 工作簿（.xlsx），落到当前会话工作区并返回文件路径与字节数。' +
      '每个 sheet 一张工作表，rows 是二维单元格数组（数字保持数字、字符串原样）。' +
      '适合明细表、清单、数据导出；要排版好看的报告用 create_report，要幻灯片用 create_ppt。' +
      '执行前会请求用户批准。',
    inputSchema: excelInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) =>
      artifactNeedsApproval(ctx, 'create_excel', planInput(input), 'xlsx', '表格'),
    execute: async (input, context) => {
      const session = sessionKey(context)
      const abs = artifactTarget(ctx, planInput(input), 'xlsx', '表格', session)
      const bytes = await renderXlsx(input.sheets)
      const kind = `${input.sheets.length} 张工作表${summarizeRows(input.sheets)}`

      return await saveArtifact(ctx, abs, bytes, kind, { session })
    }
  })
}

/** 回执里补一句总行数（工具卡上一眼能看出产了多少数据） */
function summarizeRows(sheets: readonly ExcelSheetInput[]): string {
  const rows = sheets.reduce((total, sheet) => total + sheet.rows.length, 0)
  return `／${rows} 行`
}
