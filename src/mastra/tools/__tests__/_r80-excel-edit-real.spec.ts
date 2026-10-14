// @vitest-environment node
/**
 * R80 探针：**增量改 Excel** 的真产物（真 create_excel 出稿、真 edit_excel 改、真读回）。
 *
 * 聚焦用例（excel-edit.spec.ts）钉的是行为；这一份生成**看得见的证据**：一条真实的编辑链走完，
 * 每一版的 .xlsx 都留在 `.superpowers/office-incremental/xlsx/`（本地，不入库），并用产品自己的
 * 读侧两条路验一遍：
 *   - `extractXlsx`（工作台预览用的那一条：exceljs → 每张表的单元格文本）：**人读得出来的内容对不对**；
 *   - `readZipEntries`（自研解包 + CRC）：**容器本身是不是规矩的 OOXML**，以及**危险部件是否真的没被放过去**；
 *   - ExcelJS 直读：类型（数字是不是数字）、公式 / 样式 / 合并 / 列宽 / 冻结窗格是不是原样。
 *
 * 用法（约 2 秒，不花钱、不联网）：
 *   KYCLAW_R80_XLSX_PROBE=1 pnpm exec vitest run src/mastra/tools/__tests__/_r80-excel-edit-real.spec.ts
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractXlsx } from '../../../main/workbench-office'
import { zipOf } from '../../../main/__tests__/zip-fixture'
import { sha256Of } from '../../fingerprint'
import { readZipEntries } from '../artifact-check'
import { createExcelTool, loadExcelJs } from '../excel'
import { createEditExcelTool } from '../excel-edit'
import { callTool, createBed, type TestBed } from './helpers'

const enabled = process.env.KYCLAW_R80_XLSX_PROBE === '1'
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const evidenceDir = join(repoRoot, '.superpowers', 'office-incremental', 'xlsx')

const FILE = '表格/费用明细.xlsx'

/** 一份"像真任务那样"的初稿：明细 + 汇总两张表 */
const BOOK = {
  path: FILE,
  sheets: [
    {
      name: '明细',
      rows: [
        ['日期', '项目', '金额', '备注'],
        ['2026-01-05', '服务器', 62000, '一年'],
        ['2026-01-12', '域名', 480, null],
        ['2026-01-20', '对象存储', 1280, '按量']
      ]
    },
    { name: '汇总', rows: [['合计', 63760]] }
  ]
}

let bed: TestBed
let create: unknown
let edit: unknown
let file: string

/** 每一版都留一份到证据目录（文件名带序号，便于人工按顺序打开看） */
function keep(name: string, from = file): string {
  const target = join(evidenceDir, name)
  copyFileSync(from, target)
  console.log(`[r80] 留档 ${target}（${readFileSync(from).byteLength} 字节）`)
  return target
}

/** 产品读侧（工作台预览那一条）：每张表的单元格文本 */
async function preview(path: string): Promise<string> {
  const { sheets } = await extractXlsx(readFileSync(path))
  return sheets
    .map(
      (sheet) =>
        `${sheet.name}（${sheet.rows.length} 行）：${sheet.rows.map((row) => row.join(' | ')).join(' / ')}`
    )
    .join('\n')
}

/** 一个单元格的原值（类型也在：数字还是数字） */
async function cell(path: string, sheetName: string, address: string): Promise<unknown> {
  const ExcelJS = await loadExcelJs()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(
    readFileSync(path) as unknown as Parameters<typeof workbook.xlsx.load>[0]
  )
  return workbook.getWorksheet(sheetName)?.getCell(address).value ?? null
}

/** 一份"别人交给我们的"表：公式 / 样式 / 合并 / 列宽 / 行高 / 冻结窗格都有 */
async function userWorkbook(path: string): Promise<void> {
  const ExcelJS = await loadExcelJs()
  const workbook = new ExcelJS.Workbook()
  const detail = workbook.addWorksheet('明细')
  detail.columns = [{ width: 22 }, { width: 10 }, { width: 8 }]
  detail.getCell('A1').value = '项目'
  detail.getCell('A1').font = { bold: true, color: { argb: 'FFFF0000' } }
  detail.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } }
  detail.getCell('B1').value = 10
  detail.getCell('C1').value = 20
  detail.getCell('B2').value = 1
  detail.getCell('C2').value = 2
  detail.getCell('D2').value = { formula: 'B2+C2', result: 3 }
  detail.getCell('D2').numFmt = '0.00'
  detail.mergeCells('A3:C3')
  detail.getCell('A3').value = '这一段是合并单元格'
  detail.getRow(4).height = 30
  detail.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }]
  workbook.addWorksheet('汇总').getCell('A1').value = '合计'
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.from(await workbook.xlsx.writeBuffer()))
}

beforeAll(async () => {
  mkdirSync(evidenceDir, { recursive: true })
  bed = createBed({ mode: 'full' })
  create = await createExcelTool(bed.ctx)
  edit = await createEditExcelTool(bed.ctx)
  file = join(bed.root, '表格', '费用明细.xlsx')
})

afterAll(() => {
  bed.dispose()
})

describe.skipIf(!enabled)('R80：增量改 Excel 的真实产物', () => {
  it('create_excel → set_cell / append_rows / clear_cell 全链留档，每一版都读回验内容', async () => {
    // ① 初稿
    const created = String(await callTool(create, BOOK, 'probe'))
    expect(created).toContain('已创建')
    const v1 = keep('01-初稿.xlsx')
    expect(await preview(v1)).toContain('服务器 | 62000')
    console.log(`[r80] 初稿回执：${created}`)

    // ② set_cell：改一个金额（数字还是数字）+ 改一条备注
    const setReceipt = String(
      await callTool(
        edit,
        {
          path: FILE,
          ops: [
            { op: 'set_cell', sheet: '明细', cell: 'C2', value: 61000 },
            { op: 'set_cell', sheet: '明细', cell: 'D3', value: '域名续费' }
          ],
          expect: { contains: [{ text: '域名续费' }] }
        },
        'probe'
      )
    )
    const v2 = keep('02-set-cell.xlsx')
    expect(setReceipt).toContain('结构校验通过')
    expect(setReceipt).toContain('本次改动：明细!C2 = 61000、明细!D3 = 「域名续费」')
    expect(await cell(v2, '明细', 'C2')).toBe(61000)
    expect(await cell(v2, '明细', 'D3')).toBe('域名续费')
    console.log(`[r80] ② 回执：${setReceipt}`)
    console.log(`[r80] ② 产品读侧：\n${await preview(v2)}`)

    // ③ append_rows：表尾补两行 + clear_cell：清掉一格备注
    const appendReceipt = String(
      await callTool(
        edit,
        {
          path: FILE,
          ops: [
            {
              op: 'append_rows',
              sheet: '明细',
              rows: [
                ['2026-02-01', '短信', 120, null],
                ['2026-02-10', 'CDN', 860, '按量']
              ]
            },
            { op: 'clear_cell', sheet: '明细', cell: 'D2' }
          ]
        },
        'probe'
      )
    )
    const v3 = keep('03-append-rows.xlsx')
    expect(appendReceipt).toContain('明细 追加 2 行（第 5–6 行）')
    expect(appendReceipt).toContain('明细!D2 清空')
    expect(await cell(v3, '明细', 'A6')).toBe('2026-02-10')
    expect(await cell(v3, '明细', 'D2')).toBeNull()
    console.log(`[r80] ③ 回执：${appendReceipt}`)
    console.log(`[r80] ③ 产品读侧：\n${await preview(v3)}`)

    // ④ 容器与自检：真解包（CRC 逐条核）+ 要害部件在
    const entries = readZipEntries(readFileSync(file))
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml']) {
      expect(entries.has(name), `包里缺 ${name}`).toBe(true)
    }
    const sheetXml = [...entries.keys()]
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .map((name) => entries.get(name)?.toString('utf8') ?? '')
      .join('\n')
    // 单元格文字落在 sharedStrings（工作表里是 `t="s"` + 索引），所以两处一起看
    const allXml = [...entries.values()].map((data) => data.toString('utf8')).join('\n')
    expect(sheetXml).toContain('<v>860</v>')
    expect(allXml).toContain('CDN')
    console.log(
      `[r80] ④ 条目数=${entries.size}，最后一份 sha256=${sha256Of(readFileSync(file)).slice(0, 12)}…`
    )
  }, 60_000)

  it('别人给的表：公式 / 样式 / 合并 / 列宽 / 行高 / 冻结窗格改完还在（留改前改后两份）', async () => {
    const given = join(bed.root, '表格', '别人给的表.xlsx')
    await userWorkbook(given)
    keep('04-别人给的表-改前.xlsx', given)

    const receipt = String(
      await callTool(
        edit,
        {
          path: '表格/别人给的表.xlsx',
          ops: [{ op: 'set_cell', sheet: '明细', cell: 'B2', value: 5 }]
        },
        'probe'
      )
    )
    const after = keep('05-别人给的表-改后.xlsx', given)

    const ExcelJS = await loadExcelJs()
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(
      readFileSync(after) as unknown as Parameters<typeof workbook.xlsx.load>[0]
    )
    const sheet = workbook.getWorksheet('明细')
    if (sheet === undefined) throw new Error('读回时没有工作表 明细')

    expect(sheet.getCell('B2').value).toBe(5)
    expect(sheet.getCell('D2').value).toMatchObject({ formula: 'B2+C2' })
    expect(sheet.getCell('D2').numFmt).toBe('0.00')
    expect(sheet.getCell('A1').font).toMatchObject({ bold: true, color: { argb: 'FFFF0000' } })
    expect(sheet.model.merges).toEqual(['A3:C3'])
    expect(sheet.getColumn(1).width).toBe(22)
    expect(sheet.getRow(4).height).toBe(30)
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 1 })
    expect(workbook.getWorksheet('汇总')?.getCell('A1').value).toBe('合计')

    // 真解包：公式确实写在部件里
    const xml = [...readZipEntries(readFileSync(after)).values()]
      .map((data) => data.toString('utf8'))
      .join('\n')
    expect(xml).toContain('<f>B2+C2</f>')
    console.log(`[r80] ⑤ 回执：${receipt}`)
    console.log('[r80] ⑤ 公式 / 样式 / 合并 / 列宽 / 行高 / 冻结窗格全部保留')
  }, 60_000)

  it('带图表的表：整次拒绝，盘上的字节一个不动（留证：改前改后同指纹）', async () => {
    // 造一份"带图表"的表：真 xlsx 的条目 + 注入一个图表部件
    const withChart = join(bed.root, '表格', '带图表的表.xlsx')
    const entries = readZipEntries(readFileSync(file))
    const files: Record<string, string> = {}
    for (const [name, data] of entries) files[name] = data.toString('utf8')
    files['xl/charts/chart1.xml'] = '<c:chartSpace xmlns:c="x"/>'
    mkdirSync(dirname(withChart), { recursive: true })
    writeFileSync(withChart, zipOf(files))
    const before = sha256Of(readFileSync(withChart))
    keep('06-带图表的表-拒绝前.xlsx', withChart)

    await expect(
      callTool(
        edit,
        {
          path: '表格/带图表的表.xlsx',
          ops: [{ op: 'set_cell', sheet: '明细', cell: 'C2', value: 1 }]
        },
        'probe'
      )
    ).rejects.toThrow(/整包重写会丢掉/)

    expect(sha256Of(readFileSync(withChart))).toBe(before)
    keep('07-带图表的表-拒绝后.xlsx', withChart)
    console.log(`[r80] ⑥ 拒绝后 sha256=${before.slice(0, 12)}…（与拒绝前一致：一个字节都没动）`)
  }, 60_000)
})
