// @vitest-environment node
/**
 * 增量改一份已有 Excel 工作簿（edit_excel）的聚焦用例。
 *
 * 要钉住的六件事（都是"改了以后就再也回不去"的行为）：
 *   ① **红→绿**：create_excel 做一份 → edit_excel 只发一个 op 改一格 → 那一格换了值、
 *      其余单元格逐格没动、模型入参里不含整张表；
 *   ② 三个操作各自的语义（set_cell / append_rows / clear_cell）与**地址口径**（A1、表名大小写不敏感）；
 *   ③ **干净失败**：未知工作表 / 坏 A1 / 文件不存在 / 是目录 / 路径越界 / .xlsm / 非 zip / 坏包 /
 *      超 32MB / 危险部件 —— 一律**不动盘上的字节**（逐条比 sha256），回中文人话给出口；
 *   ④ **危险部件整次拒绝**：宏 / 图表 / 数据透视 / 批注 / 切片器 / 外链 / 自定义 XML / 图表工作表
 *      （部件名命中，以及只在 rels 里被引用的情况）—— 说清会丢什么，不静默降级；
 *   ⑤ **保留**：公式 / 样式 / 合并 / 列宽 / 行高 / 冻结窗格（ExcelJS 建模了的结构）在整包重写后还在，
 *      且用**真解包**（readZipEntries + CRC）看一眼容器结构仍是规矩的 xlsx；
 *   ⑥ **并发**：同一路径两次 edit 串行执行、两次改动都在（不丢更新）；审批与 create_excel 同档
 *      （ask 问 / full 免审 / 规则放行 / 区外不问）。
 *
 * 走的是**真链路**：真临时工作区 + 真 create_excel 出稿 + 真落盘，再用 ExcelJS 读回（产品的预览/读侧
 * 同一个库）与 `readZipEntries`（自研解包 + CRC）双向验。断言的是"文件里真是那个值"，
 * 不是"某个库自己认自己"。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from '../../../shared/zod'
import { PREVIEW_OFFICE_MAX_BYTES } from '../../../shared/workbench'
import { zipOf } from '../../../main/__tests__/zip-fixture'
import { sha256Of } from '../../fingerprint'
import { readZipEntries } from '../artifact-check'
import { createExcelTool, loadExcelJs } from '../excel'
import {
  applyExcelOps,
  createEditExcelTool,
  excelEditInputSchema,
  findLossyParts,
  MAX_EXCEL_OPS,
  parseA1
} from '../excel-edit'
import { callTool, createBed, type TestBed } from './helpers'
import { zipText } from './zip'

const FILE = '表格/费用明细.xlsx'

/** 一份"像真任务那样"的初稿：两张表，数字/字符串/空值都有 */
const BOOK = {
  path: FILE,
  sheets: [
    {
      name: '明细',
      rows: [
        ['项目', '金额', '备注'],
        ['服务器', 62000, '一年'],
        ['域名', 480, null]
      ]
    },
    { name: '汇总', rows: [['合计', 62480]] }
  ]
}

let bed: TestBed
let create: unknown
let edit: unknown
let file: string

beforeEach(async () => {
  bed = createBed({ mode: 'full' })
  create = await createExcelTool(bed.ctx)
  edit = await createEditExcelTool(bed.ctx)
  file = join(bed.root, '表格', '费用明细.xlsx')
})

afterEach(() => {
  bed.dispose()
})

/** 真落盘一份初稿（走 create_excel，证明"做出来 → 接着改"这条链） */
async function firstVersion(book = BOOK, session = 'thread-1'): Promise<void> {
  await callTool(create, book, session)
}

/** 改一次（收单条或一串 ops） */
async function runEdit(input: unknown, session = 'thread-1'): Promise<string> {
  return String(await callTool(edit, input, session))
}

/** 读一份 xlsx 的单元格原值（NaN 之外的值都原样：数字还是数字、空还是 null） */
async function matrix(path: string, sheetName: string): Promise<unknown[][]> {
  const ExcelJS = await loadExcelJs()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(
    readFileSync(path) as unknown as Parameters<typeof workbook.xlsx.load>[0]
  )
  const sheet = workbook.getWorksheet(sheetName)
  if (sheet === undefined) throw new Error(`读回时没有工作表 ${sheetName}`)
  const rows: unknown[][] = []
  for (let row = 1; row <= sheet.rowCount; row++) {
    const cells: unknown[] = []
    for (let column = 1; column <= sheet.columnCount; column++) {
      cells.push(plain(sheet.getCell(row, column).value))
    }
    rows.push(cells)
  }
  return rows
}

/** 一个单元格的原值 */
async function cellOf(path: string, sheetName: string, address: string): Promise<unknown> {
  const ExcelJS = await loadExcelJs()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(
    readFileSync(path) as unknown as Parameters<typeof workbook.xlsx.load>[0]
  )
  const sheet = workbook.getWorksheet(sheetName)
  if (sheet === undefined) throw new Error(`读回时没有工作表 ${sheetName}`)
  return plain(sheet.getCell(address).value)
}

/** 公式格读回来是对象；这里折成可比较的普通值 */
function plain(value: unknown): unknown {
  if (value === undefined || value === null) return null
  if (typeof value === 'object') return JSON.parse(JSON.stringify(value)) as unknown
  return value
}

/** 把盘上那份的字节 sha256 记下来（失败用例逐条比"一个字节都没动"） */
function fingerprint(path: string): string {
  return sha256Of(readFileSync(path))
}

/** 盘上那份 xlsx 的条目表（真解包 + CRC） */
function entriesOf(path: string): Map<string, Buffer> {
  return readZipEntries(readFileSync(path))
}

/** 往现有 xlsx 里**注入**一个部件（危险部件负向用例：模拟别人给的、带图表的表） */
function injectPart(path: string, part: string, content = '<injected/>'): void {
  const files: Record<string, string> = {}
  for (const [name, data] of entriesOf(path)) files[name] = data.toString('utf8')
  files[part] = content
  writeFileSync(path, zipOf(files))
}

describe('① 红→绿：改一格 = 那一格换了值、其余格逐格没动、入参不含整张表', () => {
  it('set_cell 改一个数字：其余单元格逐格没动', async () => {
    await firstVersion()
    const before = await matrix(file, '明细')

    const ops = { path: FILE, ops: [{ op: 'set_cell', sheet: '明细', cell: 'B2', value: 62001 }] }
    await runEdit(ops)

    const after = await matrix(file, '明细')
    expect(after[1][1]).toBe(62001)
    // 其余每一格都没动（逐格比：改的那一格先抹平再比）
    const normalized = (rows: unknown[][]): unknown[] => {
      const copy = rows.map((row) => [...row])
      copy[1][1] = null
      return copy.flat()
    }
    expect(normalized(after)).toEqual(normalized(before))
    // 数字还是数字（不是文本）：B3 = 480 没被动过，类型也对
    expect(await cellOf(file, '明细', 'B3')).toBe(480)
    // 另一张表与初稿一模一样
    expect(await matrix(file, '汇总')).toEqual([['合计', 62480]])
  })

  it('字符串即使以 = 开头也按普通文字写（不新增公式）', async () => {
    await firstVersion()

    await runEdit({
      path: FILE,
      ops: [{ op: 'set_cell', sheet: '明细', cell: 'C2', value: '=SUM(B2:B3)' }]
    })

    // 读回来是字符串（不是 { formula }），且包里的工作表 XML 没有 <f>
    expect(await cellOf(file, '明细', 'C2')).toBe('=SUM(B2:B3)')
    const sheetXml = [...entriesOf(file).values()].map((data) => data.toString('utf8'))
    expect(sheetXml.some((xml) => xml.includes('=SUM(B2:B3)'))).toBe(true)
    expect(sheetXml.some((xml) => xml.includes('<f>SUM'))).toBe(false)
  })

  it('模型这一轮的入参只有"改哪一格 + 改成什么"，没有整张表', async () => {
    await firstVersion()

    const ops = {
      path: FILE,
      ops: [
        { op: 'set_cell', sheet: '明细', cell: 'B2', value: 62001 },
        { op: 'clear_cell', sheet: '明细', cell: 'C3' }
      ]
    }
    const incremental = JSON.stringify(excelEditInputSchema.parse(ops))

    expect(incremental).toContain('62001')
    expect(incremental).not.toContain('域名')
    expect(incremental).not.toContain('汇总')
    expect(incremental).not.toContain('"sheets"')
  })

  it('回执：与 create_excel 同形的落盘回执 + 工作表摘要 + 改动摘要', async () => {
    await firstVersion()

    const receipt = await runEdit({
      path: FILE,
      ops: [{ op: 'set_cell', sheet: '明细', cell: 'B2', value: 62001 }]
    })

    expect(receipt).toContain(`已覆盖 ${file}`)
    expect(receipt).toContain('2 张工作表')
    expect(receipt).toMatch(/（\d+ 字节，2 张工作表）/)
    expect(receipt).toContain('结构校验通过')
    expect(receipt).toContain('工作表：明细 3 行 × 3 列、汇总 1 行 × 2 列')
    expect(receipt).toContain('本次改动：明细!B2 = 62001')
  })

  it('**两次并发编辑**：串行执行、两次改动都在（同一个目标的队列，不丢更新）', async () => {
    await firstVersion()

    // 同时发两个改同一份文件的调用（没有队列时：两边读到同一份旧字节，后写的把前一次覆盖掉）
    const first = runEdit({
      path: FILE,
      ops: [{ op: 'set_cell', sheet: '明细', cell: 'B2', value: 111 }]
    })
    const second = runEdit({
      path: FILE,
      ops: [{ op: 'set_cell', sheet: '明细', cell: 'C2', value: 222 }]
    })
    await Promise.all([first, second])

    expect(await cellOf(file, '明细', 'B2')).toBe(111)
    expect(await cellOf(file, '明细', 'C2')).toBe(222)
    // 别的东西也没被卷掉
    expect(await cellOf(file, '汇总', 'B1')).toBe(62480)
  })
})

describe('② 三个操作与地址口径', () => {
  it('append_rows：追加到表尾（第 4–5 行），不覆盖已有行', async () => {
    await firstVersion()

    const receipt = await runEdit({
      path: FILE,
      ops: [
        {
          op: 'append_rows',
          sheet: '明细',
          rows: [
            ['短信', 120, '一月'],
            ['备案', null, '二月']
          ]
        }
      ]
    })

    const after = await matrix(file, '明细')
    expect(after).toHaveLength(5)
    expect(after[3]).toEqual(['短信', 120, '一月'])
    expect(after[4]).toEqual(['备案', null, '二月'])
    expect(after[1]).toEqual(['服务器', 62000, '一年'])
    expect(receipt).toContain('明细 追加 2 行（第 4–5 行）')
    expect(receipt).toContain('工作表：明细 5 行 × 3 列')
  })

  it('clear_cell：清空一格（读回 null），别的格没动', async () => {
    await firstVersion()

    await runEdit({ path: FILE, ops: [{ op: 'clear_cell', sheet: '明细', cell: 'C2' }] })

    expect(await cellOf(file, '明细', 'C2')).toBeNull()
    expect(await cellOf(file, '明细', 'B2')).toBe(62000)
    expect(await cellOf(file, '明细', 'A3')).toBe('域名')
  })

  it('一串 ops 按**当前**状态逐条应用（刚追加的那一行随后就能改）', async () => {
    await firstVersion()

    await runEdit({
      path: FILE,
      ops: [
        { op: 'append_rows', sheet: '明细', rows: [['新增', 1, null]] },
        { op: 'set_cell', sheet: '明细', cell: 'B4', value: 999 },
        { op: 'append_rows', sheet: '明细', rows: [['再来一行', 2, null]] }
      ]
    })

    const after = await matrix(file, '明细')
    expect(after).toHaveLength(5)
    expect(after[3]).toEqual(['新增', 999, null])
    expect(after[4]).toEqual(['再来一行', 2, null])
  })

  it('表名大小写不敏感（Excel 里不允许两张表只差大小写）；表名写歪就给清单', async () => {
    await firstVersion({
      path: '表格/明细.xlsx',
      sheets: [{ name: 'Detail', rows: [['a', 1]] }]
    })
    const path = join(bed.root, '表格', '明细.xlsx')

    const receipt = await runEdit({
      path: '表格/明细.xlsx',
      ops: [{ op: 'set_cell', sheet: 'detail', cell: 'B1', value: 2 }]
    })
    expect(receipt).toContain('Detail!B1 = 2')
    expect(await cellOf(path, 'Detail', 'B1')).toBe(2)

    await expect(
      runEdit({
        path: '表格/明细.xlsx',
        ops: [{ op: 'set_cell', sheet: '没有这张', cell: 'A1', value: 1 }]
      })
    ).rejects.toThrow(/没有工作表「没有这张」[\s\S]*工作表是：Detail/)
  })

  it('$B$3 这类绝对写法照收；区域/整行/越界地址一律拒（人话点名上限）', () => {
    expect(parseA1('$B$3')).toEqual({ row: 3, column: 2 })
    expect(parseA1('b3')).toEqual({ row: 3, column: 2 })
    expect(parseA1('XFD1048576')).toEqual({ row: 1_048_576, column: 16_384 })

    for (const bad of ['A1:B2', 'A', '1', 'A-1', '', '第 3 行', 'A1 值', 'AAAA1', 'A12345678']) {
      expect(() => parseA1(bad), bad).toThrow(/不是合法的单元格地址/)
    }
    // 行 0 / 列超 XFD / 行超 1048576：解析得出来，但超 Excel 上限（人话里点名上限与解析结果）
    for (const out of ['A0', 'XFE1', 'A1048577']) {
      expect(() => parseA1(out), out).toThrow(/超了 Excel 的行列上限/)
    }
  })

  it('核验期望按"最后一条 op 说了算"收敛（append 之后又改同一格）', async () => {
    const ExcelJS = await loadExcelJs()
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('S')
    sheet.addRow(['a', 1])

    const outcome = applyExcelOps(
      workbook,
      [
        { op: 'append_rows', sheet: 'S', rows: [['b', 2]] },
        { op: 'set_cell', sheet: 'S', cell: 'B2', value: 9 }
      ],
      'x.xlsx'
    )

    // B2 只留一条期望，且是最后写进去的那个值（否则读回核验会把中间态当成期望、必然不过）
    expect(outcome.expected.filter((item) => item.cell === 'B2')).toEqual([
      { sheet: 'S', cell: 'B2', value: 9 }
    ])
    expect(outcome.expected).toContainEqual({ sheet: 'S', cell: 'A2', value: 'b' })
    expect(sheet.getCell('B2').value).toBe(9)
    expect(outcome.changes).toEqual(['S 追加 1 行（第 2–2 行）', 'S!B2 = 9'])
  })

  it('expect（断言）在改的时候照样逐条核', async () => {
    await firstVersion()

    const passed = await runEdit({
      path: FILE,
      ops: [{ op: 'set_cell', sheet: '明细', cell: 'B2', value: 62001 }],
      expect: { sheets: 2, contains: [{ text: '62001' }] }
    })
    expect(passed).toContain('结构校验通过')

    const missed = await runEdit({
      path: FILE,
      ops: [{ op: 'set_cell', sheet: '明细', cell: 'B2', value: 62001 }],
      expect: { sheets: 3, contains: [{ text: '这句不在表里' }] }
    })
    expect(missed).toContain('断言：必须正好 3 张工作表（包内 2 张工作表）')
    expect(missed).toContain('工作簿里必须含「这句不在表里」')
  })
})

describe('③ 干净失败：不动盘上的字节，回人话给出口', () => {
  it('未知工作表 → 拒，盘上字节一个没变', async () => {
    await firstVersion()
    const before = fingerprint(file)

    await expect(
      runEdit({ path: FILE, ops: [{ op: 'set_cell', sheet: '流水', cell: 'A1', value: 1 }] })
    ).rejects.toThrow(/没有工作表「流水」[\s\S]*一个单元格都没改/)
    expect(fingerprint(file)).toBe(before)
  })

  it('坏 A1：抛中文人话，一个字节都不写', async () => {
    await firstVersion()
    const before = fingerprint(file)

    await expect(
      runEdit({ path: FILE, ops: [{ op: 'set_cell', sheet: '明细', cell: 'A1:B2', value: 1 }] })
    ).rejects.toThrow(/不是合法的单元格地址/)
    await expect(
      runEdit({ path: FILE, ops: [{ op: 'clear_cell', sheet: '明细', cell: 'XFE1' }] })
    ).rejects.toThrow(/超了 Excel 的行列上限/)
    expect(fingerprint(file)).toBe(before)
  })

  it('入参上限在 schema 层就挡下：ops 条数 / 单元格 32767 字符 / 空 ops', () => {
    const tooMany = excelEditInputSchema.safeParse({
      path: FILE,
      ops: Array.from({ length: MAX_EXCEL_OPS + 1 }, () => ({
        op: 'clear_cell',
        sheet: '明细',
        cell: 'A1'
      }))
    })
    expect(tooMany.success).toBe(false)

    const longCell = excelEditInputSchema.safeParse({
      path: FILE,
      ops: [{ op: 'set_cell', sheet: '明细', cell: 'A1', value: 'x'.repeat(32_768) }]
    })
    expect(longCell.success).toBe(false)
    expect(JSON.stringify(longCell.error?.issues)).toContain('32767')

    expect(excelEditInputSchema.safeParse({ path: FILE, ops: [] }).success).toBe(false)
    expect(
      excelEditInputSchema.safeParse({ ops: [{ op: 'clear_cell', sheet: 'S', cell: 'A1' }] })
        .success
    ).toBe(false)
  })

  it('文件不存在 → 指向 create_excel（且什么都不建）', async () => {
    await expect(
      runEdit({ path: FILE, ops: [{ op: 'set_cell', sheet: '明细', cell: 'A1', value: 1 }] })
    ).rejects.toThrow(/找不到[\s\S]*create_excel/)
    expect(existsSync(file)).toBe(false)
  })

  it('目标是目录 → 拒', async () => {
    mkdirSync(file, { recursive: true })
    await expect(
      runEdit({ path: FILE, ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })
    ).rejects.toThrow(/是一个目录/)
  })

  it('路径落在工作区外：执行前就被拒（fail closed，一个字节都不写）', async () => {
    await firstVersion()
    const outside = join(bed.outside, 'x.xlsx')
    writeFileSync(outside, readFileSync(file))

    await expect(
      runEdit({ path: outside, ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })
    ).rejects.toThrow(/授权工作区/)
    expect(statSync(outside).size).toBe(statSync(file).size)
  })

  it('.xlsm / .xltm 直接拒（宏保不住）；别的扩展名也拒', async () => {
    await firstVersion()
    const macro = join(bed.root, '表格', '带宏.xlsm')
    writeFileSync(macro, readFileSync(file))

    await expect(
      runEdit({ path: '表格/带宏.xlsm', ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })
    ).rejects.toThrow(/不收带宏的工作簿（\.xlsm）[\s\S]*另存为/)
    await expect(
      runEdit({ path: '表格/带宏.xltm', ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })
    ).rejects.toThrow(/不收带宏的工作簿（\.xltm）/)
    await expect(
      runEdit({ path: '表格/老表.xls', ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })
    ).rejects.toThrow(/只改 \.xlsx/)
    expect(fingerprint(macro)).toBe(fingerprint(file))
  })

  it('后缀是 .xlsx 但内容不是 zip（文件头对不上）→ 拒，内容不变', async () => {
    await firstVersion()
    const fake = join(bed.root, '表格', '改名.xlsx')
    writeFileSync(fake, '这其实是一份 CSV，不是 xlsx')

    await expect(
      runEdit({ path: '表格/改名.xlsx', ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })
    ).rejects.toThrow(/文件头对不上 zip/)
    expect(readFileSync(fake, 'utf8')).toBe('这其实是一份 CSV，不是 xlsx')
  })

  it('zip 被截断（包结构读不通）→ 拒，字节一个没变', async () => {
    await firstVersion()
    const broken = join(bed.root, '表格', '坏包.xlsx')
    const bytes = readFileSync(file)
    writeFileSync(broken, bytes.subarray(0, bytes.length - 40))

    await expect(
      runEdit({ path: '表格/坏包.xlsx', ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })
    ).rejects.toThrow(/包结构(不通|读不通)/)
    expect(statSync(broken).size).toBe(bytes.length - 40)
  })

  it('超过 32MB 上限 → 拒（与工作台办公档同一档上限）', async () => {
    const big = join(bed.root, '表格', '超大.xlsx')
    mkdirSync(dirname(big), { recursive: true })
    writeFileSync(big, Buffer.alloc(PREVIEW_OFFICE_MAX_BYTES + 1))

    await expect(
      runEdit({ path: '表格/超大.xlsx', ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })
    ).rejects.toThrow(/超过 edit_excel 的 32MB 上限/)
    expect(statSync(big).size).toBe(PREVIEW_OFFICE_MAX_BYTES + 1)
  })

  it('这次编辑期间盘上那份被别的东西改过 → 不写盘（sha256 一致性）', async () => {
    // 一个"读到第二遍时盘上已经变了"的注入 fs：第一次给真字节，第二次给被改过的字节
    const custom = createBed({ mode: 'full' })
    try {
      const path = join(custom.root, '表格', '费用明细.xlsx')
      const create2 = await createExcelTool(custom.ctx)
      await callTool(create2, BOOK, 'thread-1')
      const before = readFileSync(path)

      const real = custom.ctx.fs.readFile.bind(custom.ctx.fs)
      let reads = 0
      custom.ctx.fs = {
        ...custom.ctx.fs,
        readFile: async (target, maxBytes) => {
          const bytes = await real(target, maxBytes)
          reads += 1
          if (reads === 1) return bytes
          const tampered = Buffer.from(bytes)
          tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff
          return tampered
        }
      }

      const edit2 = await createEditExcelTool(custom.ctx)
      await expect(
        callTool(
          edit2,
          { path: FILE, ops: [{ op: 'set_cell', sheet: '明细', cell: 'B2', value: 1 }] },
          'thread-1'
        )
      ).rejects.toThrow(/在这次编辑期间被别的东西改过[\s\S]*没有写盘/)
      // 读了两次（原字节 + 写盘前的复核），盘上那份逐字节没动
      expect(reads).toBe(2)
      expect(readFileSync(path).equals(before)).toBe(true)
      expect(await cellOf(path, '明细', 'B2')).toBe(62000)
    } finally {
      custom.dispose()
    }
  })
})

describe('④ 危险部件：整次拒绝、说清会丢什么、盘上字节一个不变', () => {
  it('每种危险部件都拒（部件名命中）', async () => {
    await firstVersion()
    const dangerous: Array<[string, RegExp]> = [
      ['xl/vbaProject.bin', /VBA 宏|宏/],
      ['xl/charts/chart1.xml', /图表/],
      ['xl/chartsheets/sheet1.xml', /图表工作表/],
      ['xl/worksheets/chartsheet1.xml', /图表工作表/],
      ['xl/pivotTables/pivotTable1.xml', /数据透视表/],
      ['xl/pivotCache/pivotCacheDefinition1.xml', /数据透视缓存/],
      ['xl/comments1.xml', /批注/],
      ['xl/threadedComments/threadedComment1.xml', /新版批注/],
      ['xl/slicers/slicer1.xml', /切片器/],
      ['xl/externalLinks/externalLink1.xml', /外部链接/],
      ['customXml/item1.xml', /自定义 XML/]
    ]

    for (const [part, expected] of dangerous) {
      await firstVersion()
      injectPart(file, part)
      const before = fingerprint(file)

      await expect(
        runEdit({ path: FILE, ops: [{ op: 'set_cell', sheet: '明细', cell: 'B2', value: 1 }] }),
        part
      ).rejects.toThrow(/整包重写会丢掉|会丢掉/)
      await expect(
        runEdit({ path: FILE, ops: [{ op: 'set_cell', sheet: '明细', cell: 'B2', value: 1 }] }),
        part
      ).rejects.toThrow(expected)
      // 盘上的字节一个都没变（连我们注入的那个部件也还在）
      expect(fingerprint(file), part).toBe(before)
      expect(entriesOf(file).has(part), part).toBe(true)
    }
  })

  it('部件名不认识、但 rels 里引用了 chartsheet：一样拒（内容兜底）', async () => {
    await firstVersion()
    const rels = 'xl/_rels/workbook.xml.rels'
    const original = zipText(entriesOf(file), rels)
    injectPart(
      file,
      rels,
      original.replace(
        '</Relationships>',
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="sheets/weirdName1.xml"/></Relationships>'
      )
    )
    const before = fingerprint(file)

    await expect(
      runEdit({ path: FILE, ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })
    ).rejects.toThrow(/图表工作表/)
    expect(fingerprint(file)).toBe(before)
  })

  it('干净的 xlsx 不会误伤（firstVersion 那份能改）', async () => {
    await firstVersion()
    expect(findLossyParts(entriesOf(file))).toEqual([])
    await runEdit({ path: FILE, ops: [{ op: 'set_cell', sheet: '明细', cell: 'B2', value: 7 }] })
    expect(await cellOf(file, '明细', 'B2')).toBe(7)
  })
})

describe('⑤ 保留 ExcelJS 建模了的结构（整包重写后还在）', () => {
  /** 一份"别人交给我们的"表：公式 / 样式 / 合并 / 列宽 / 行高 / 冻结窗格都有 */
  async function userWorkbook(path: string): Promise<void> {
    const ExcelJS = await loadExcelJs()
    const workbook = new ExcelJS.Workbook()
    const detail = workbook.addWorksheet('明细')
    detail.columns = [{ width: 22 }, { width: 10 }, { width: 8 }]
    detail.getCell('A1').value = '名称'
    detail.getCell('A1').font = { bold: true, color: { argb: 'FFFF0000' } }
    detail.getCell('B1').value = 10
    detail.getCell('C1').value = 20
    detail.getCell('B2').value = 1
    detail.getCell('C2').value = 2
    detail.getCell('D2').value = { formula: 'B2+C2', result: 3 }
    detail.getCell('D2').numFmt = '0.00'
    detail.mergeCells('A3:C3')
    detail.getCell('A3').value = '合并标题'
    detail.getRow(4).height = 30
    detail.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }]
    workbook.addWorksheet('汇总').getCell('A1').value = '合计'
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from(await workbook.xlsx.writeBuffer()))
  }

  it('改一格之后：公式 / 样式 / 合并 / 列宽 / 行高 / 冻结窗格原样，读回核过', async () => {
    const path = join(bed.root, '表格', '别人给的表.xlsx')
    await userWorkbook(path)

    await runEdit({
      path: '表格/别人给的表.xlsx',
      ops: [{ op: 'set_cell', sheet: '明细', cell: 'B2', value: 5 }]
    })

    const ExcelJS = await loadExcelJs()
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(
      readFileSync(path) as unknown as Parameters<typeof workbook.xlsx.load>[0]
    )
    const sheet = workbook.getWorksheet('明细')
    if (sheet === undefined) throw new Error('读回时没有工作表 明细')

    // 我们改的那一格
    expect(sheet.getCell('B2').value).toBe(5)
    // 公式还在（值也跟着变成 5 + 2）
    expect(sheet.getCell('D2').value).toMatchObject({ formula: 'B2+C2' })
    expect(sheet.getCell('D2').numFmt).toBe('0.00')
    // 样式 / 合并 / 列宽 / 行高 / 冻结窗格
    expect(sheet.getCell('A1').font).toMatchObject({ bold: true, color: { argb: 'FFFF0000' } })
    expect(sheet.model.merges).toEqual(['A3:C3'])
    expect(sheet.getColumn(1).width).toBe(22)
    expect(sheet.getRow(4).height).toBe(30)
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 1 })
    expect(workbook.getWorksheet('汇总')?.getCell('A1').value).toBe('合计')

    // 真解包看一眼：公式在部件 XML 里（不是"库自己认自己"）
    const entries = entriesOf(path)
    const sheetPart = [...entries.keys()].find(
      (name) => name.startsWith('xl/worksheets/sheet') && name.endsWith('.xml')
    )
    expect(sheetPart).toBeDefined()
    const xml = zipText(entries, sheetPart ?? '')
    expect(xml).toContain('<f>B2+C2</f>')
    expect(entries.has('[Content_Types].xml')).toBe(true)
    expect(entries.has('_rels/.rels')).toBe(true)
  })

  it('覆盖一个公式格：回执点名"原公式被替换"（不静默丢）', async () => {
    const path = join(bed.root, '表格', '别人给的表.xlsx')
    await userWorkbook(path)

    const receipt = await runEdit({
      path: '表格/别人给的表.xlsx',
      ops: [{ op: 'set_cell', sheet: '明细', cell: 'D2', value: 99 }]
    })

    expect(receipt).toContain('明细!D2 = 99（原来是公式 =B2+C2，已按你的要求替换）')
    expect(await cellOf(path, '明细', 'D2')).toBe(99)
  })

  it('结构自检仍然过：改完的包是规矩的 xlsx（解包 + CRC 走一遍）', async () => {
    await firstVersion()
    const receipt = await runEdit({
      path: FILE,
      ops: [{ op: 'append_rows', sheet: '明细', rows: [['x', 1, null]] }]
    })

    expect(receipt).toContain('结构校验通过')
    const entries = entriesOf(file) // 读不通会抛（CRC 逐条核）
    expect(entries.has('xl/workbook.xml')).toBe(true)
    expect(statSync(file).size).toBeGreaterThan(0)
  })
})

/**
 * 权限尾巴：edit_excel 与 create_excel **同档同表**（classify 的 TOOL_CLASSES /
 * WORKSPACE_FILE_TOOLS + guard 的 ENGINE_TARGET_TOOLS）—— 落地看的三件事：
 *   ① 写类默认问、目标工作区 full 免审；
 *   ② 命中 (工具 × 工作区) 的"永久允许"规则免审；
 *   ③ path 解析不出去（区外）**不问**：执行层先 artifactTarget 再改，批了也不会落一个字节。
 */
describe('⑥ 审批：与 create_excel 同档（ask 问 / full 免审 / 规则放行 / 区外不问）', () => {
  const gate = (input: unknown): boolean =>
    (edit as { requireApproval: (input: unknown) => boolean }).requireApproval(input)

  it('ask 工作区要审批；切 full 后免审', () => {
    bed.roots[0].mode = 'ask'
    expect(gate({ path: FILE, ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })).toBe(true)

    bed.roots[0].mode = 'full'
    expect(gate({ path: FILE, ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })).toBe(false)
  })

  it('命中"永久允许"规则（edit_excel × 工作区）→ 免审', () => {
    bed.roots[0].mode = 'ask'
    expect(gate({ path: FILE, ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })).toBe(true)

    bed.rules.push({ tool: 'edit_excel', workspace: bed.root, mode: 'allow' })
    expect(gate({ path: FILE, ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }] })).toBe(false)
  })

  it('path 落在工作区外：不弹审批（执行会 fail closed）', () => {
    bed.roots[0].mode = 'ask'
    expect(
      gate({
        path: join(bed.outside, 'x.xlsx'),
        ops: [{ op: 'clear_cell', sheet: '明细', cell: 'A1' }]
      })
    ).toBe(false)
  })
})

/**
 * 入参形状是**接线的一部分**：模型要按 schema 生成 JSON，顶层是 `oneOf` / 顶层是数组这类形状
 * 会让结构化输出直接失败（工具压根不会被调）。所以这里把"顶层 object + ops 是数组"钉住 ——
 * 将来谁把顶层改成 `z.union` 或把 ops 展开成顶层字段，这一条会红。
 */
describe('⑦ 入参形状：顶层 object + ops 数组（模型按它生成 JSON）', () => {
  it('json schema 顶层是 object，path/ops 必填，ops 是数组（每个元素是一个 op 对象）', () => {
    const json = z.toJSONSchema(excelEditInputSchema) as {
      type?: string
      required?: string[]
      properties?: Record<string, { type?: string; items?: { oneOf?: unknown[] } }>
    }

    expect(json.type).toBe('object')
    expect(json.required).toEqual(expect.arrayContaining(['path', 'ops']))
    expect(json.properties?.ops?.type).toBe('array')
    expect(json.properties?.ops?.items?.oneOf?.length).toBe(3)
  })
})
