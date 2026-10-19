// @vitest-environment node
/**
 * read 专用的办公档抽取（`src/main/workbench-office.ts` 的 0.1.2 新增面）：xlsx 的单元格定位 /
 * 公式缓存 / 日期稳定 / 空格；pptx 的真实页序与"图片没读"；csv 的行列与准确截断。
 *
 * fixture 与工作台那份 spec 同口径：能真件就真件（`renderXlsx` / `renderPptx`），
 * 产出器造不出的形状（公式缓存与否、日期格式、合并单元格、presentation 关系页序、图片页）用
 * exceljs 直接写 / `zip-fixture.ts` 手写真 zip。全程只碰内存与临时目录。
 */
import { describe, expect, it } from 'vitest'
import {
  fixturePptx as renderPptx,
  fixtureXlsx as renderXlsx
} from './fixtures/office-fixtures'
import {
  SHEET_COLUMN_LIMIT,
  SHEET_LIMIT,
  SHEET_ROW_LIMIT,
  extractPptxForRead,
  extractXlsxForRead,
  parseTableText,
  readTableForRead
} from '../workbench-office'
import { zipOf } from './zip-fixture'

/** exceljs 的动态装载（与生产同一条口径：CJS 出口只有 default） */
async function loadExcelJs(): Promise<typeof import('exceljs')> {
  const loaded = (await import('exceljs')) as unknown as { default: typeof import('exceljs') }
  return loaded.default
}

/** 用 exceljs 直接造一份**真 xlsx**（要公式缓存、日期格式、合并单元格这些产出器给不了的形状） */
async function excelBytes(build: (workbook: import('exceljs').Workbook) => void): Promise<Buffer> {
  const ExcelJS = await loadExcelJs()
  const workbook = new ExcelJS.Workbook()
  build(workbook)
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

/**
 * 把公式的**缓存结果**写进 exceljs 的内部模型：`cell.value = { formula, result: 0 }` 走的是
 * exceljs 的 `_copyModel`，它把 falsy 的 `result`（`0` / `''` / `false`）整个丢掉 —— **公开 API
 * 根本造不出"缓存值是 0"的工作簿**（而这一格正是我们要验的）。`cell.model` 就是那个模型对象的引用，
 * 直接改它，落盘出来就是真的 `<v>0</v>`；验的仍是**读侧**（exceljs 自己的 `cell.text` 会把 0 吞成空）。
 */
function setCachedResult(cell: import('exceljs').Cell, result: unknown): void {
  const internal = cell as unknown as { _value: { model: Record<string, unknown> } }
  internal._value.model.result = result
}

/* ── pptx 夹具：一页 slide 部件 ──────────────────────────────────────────── */

/** 一页 slide 部件（`<p:spTree>` 里放给定的形状 XML） */
function slideXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`
}

/** 一个文本框形状（每项一段） */
function shape(paragraphs: readonly string[]): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:txBody>${paragraphs
    .map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp>`
}

/** 一张图片（`<p:pic>`） */
const PIC =
  '<p:pic><p:nvPicPr><p:cNvPr id="4" name="图片 1"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr/></p:pic>'

/** 一个图表（graphicFrame + chart 的 graphicData） */
const CHART =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="图表 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  '<p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
  '<c:chart r:id="rId3"/></a:graphicData></a:graphic></p:graphicFrame>'

/** presentation.xml（`sldIdLst` 给出**真实页序**：先 rId2 再 rId1） */
const PRESENTATION =
  '<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>' +
  '<p:sldId id="257" r:id="rId2"/><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'

/** presentation.xml.rels（rId1 → slide1、rId2 → slide2） */
const PRESENTATION_RELS =
  '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/>' +
  '</Relationships>'

describe('extractXlsxForRead：行列定位与真件', () => {
  it('真件读回：每行带行号、格按列序用 ` | ` 连；表格标题带真实规模', async () => {
    const bytes = await renderXlsx([
      {
        name: '汇总',
        rows: [
          ['项目', '金额'],
          ['房租', 1200]
        ]
      }
    ])

    const result = await extractXlsxForRead(bytes, { maxChars: 64_000 })

    expect(result.total).toBe(1)
    expect(result.unread).toBe(0)
    expect(result.truncated).toBe(false)
    expect(result.blocks[0].title).toBe('工作表「汇总」（2 行 × 2 列）')
    expect(result.blocks[0].body).toBe('行 1: 项目 | 金额\n行 2: 房租 | 1200')
  })

  it('空行不写、行号照旧（位置看得出来）；多表按顺序各成一块', async () => {
    const bytes = await excelBytes((workbook) => {
      const sheet = workbook.addWorksheet('有洞')
      sheet.getCell('A1').value = '第一行'
      sheet.getCell('A3').value = '第三行'
      workbook.addWorksheet('空的')
    })

    const result = await extractXlsxForRead(bytes, { maxChars: 64_000 })

    expect(result.blocks[0].body).toBe('行 1: 第一行\n行 3: 第三行')
    expect(result.blocks[1].title).toBe('工作表「空的」（空工作表）')
    expect(result.blocks[1].body).toBe('')
  })

  it('公式：缓存的 0 **不**被吞成空，没缓存的说"没有缓存的计算结果"', async () => {
    const bytes = await excelBytes((workbook) => {
      const sheet = workbook.addWorksheet('公式')
      const cachedZero = sheet.getCell('A1')
      cachedZero.value = { formula: 'B1+B2' }
      setCachedResult(cachedZero, 0)
      sheet.getCell('A2').value = { formula: 'B1+B2' }
      sheet.getCell('B1').value = 1
    })

    const [block] = (await extractXlsxForRead(bytes, { maxChars: 64_000 })).blocks

    expect(block.body).toContain('行 1: =B1+B2 → 0')
    expect(block.body).toContain('行 2: =B1+B2 → （没有缓存的计算结果）')
  })

  it('日期稳定：按文件里写的日期读（UTC），不随宿主机时区挪一天；纯日期不带时间', async () => {
    const bytes = await excelBytes((workbook) => {
      const sheet = workbook.addWorksheet('日期')
      sheet.getCell('A1').value = new Date(Date.UTC(2026, 9, 15, 6, 30))
      sheet.getCell('A1').numFmt = 'yyyy-mm-dd hh:mm'
      sheet.getCell('A2').value = new Date(Date.UTC(2026, 9, 15))
      sheet.getCell('A2').numFmt = 'yyyy-mm-dd'
    })

    const [block] = (await extractXlsxForRead(bytes, { maxChars: 64_000 })).blocks

    expect(block.body).toContain('行 1: 2026-10-15 06:30')
    expect(block.body).toContain('行 2: 2026-10-15')
  })

  it('空格不吞：首尾空白原样留着并加引号（看得出它真有空白）', async () => {
    const bytes = await excelBytes((workbook) => {
      const sheet = workbook.addWorksheet('空白')
      sheet.getCell('A1').value = '  1 月  '
      sheet.getCell('B1').value = '正常'
    })

    const [block] = (await extractXlsxForRead(bytes, { maxChars: 64_000 })).blocks

    expect(block.body).toBe('行 1: "  1 月  " | 正常')
  })

  it('合并区域只显示主人那一格（从属格不是内容）', async () => {
    const bytes = await excelBytes((workbook) => {
      const sheet = workbook.addWorksheet('合并')
      sheet.getCell('A1').value = '标题'
      sheet.mergeCells('A1:C1')
      sheet.getCell('A2').value = '正文'
    })

    const [block] = (await extractXlsxForRead(bytes, { maxChars: 64_000 })).blocks

    expect(block.body).toBe('行 1: 标题\n行 2: 正文')
  })

  it('列超上限：如实说"共几列、只读了前几列"', async () => {
    const bytes = await excelBytes((workbook) => {
      const sheet = workbook.addWorksheet('宽')
      sheet.getCell(1, SHEET_COLUMN_LIMIT + 1).value = 'x'
    })

    const result = await extractXlsxForRead(bytes, { maxChars: 64_000 })

    expect(result.truncated).toBe(true)
    expect(result.blocks[0].body).toContain(`这张表共 ${SHEET_COLUMN_LIMIT + 1} 列`)
    expect(result.blocks[0].body).toContain(`只读了前 ${SHEET_COLUMN_LIMIT} 列`)
  })

  it('工作表张数超上限（20）：只抽前 20 张，并如实说"共几张、一次最多读几张"', async () => {
    const bytes = await renderXlsx(
      Array.from({ length: SHEET_LIMIT + 2 }, (_all, index) => ({
        name: `表${index + 1}`,
        rows: [['x']]
      }))
    )

    const result = await extractXlsxForRead(bytes, { maxChars: 64_000 })

    expect(result.total).toBe(SHEET_LIMIT + 2)
    expect(result.blocks).toHaveLength(SHEET_LIMIT)
    expect(result.unread).toBe(2)
    expect(result.truncated).toBe(true)
    expect(result.note).toContain(`一次最多读 ${SHEET_LIMIT} 张`)
  })

  it('字符预算：一块装不下就切在行边界上，并如实说还有几张表没读', async () => {
    const bytes = await renderXlsx([
      { name: '一', rows: [['a'.repeat(80)]] },
      { name: '二', rows: [['b']] }
    ])

    const result = await extractXlsxForRead(bytes, { maxChars: 30 })

    expect(result.total).toBe(2)
    expect(result.unread).toBe(1)
    expect(result.truncated).toBe(true)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].body).toContain('读出总量有上限')
  })
})

describe('extractPptxForRead：页序、没读的东西、上限', () => {
  it('页序按 presentation 关系（不是文件名数字序）', () => {
    const bytes = zipOf({
      'ppt/presentation.xml': PRESENTATION,
      'ppt/_rels/presentation.xml.rels': PRESENTATION_RELS,
      'ppt/slides/slide1.xml': slideXml(shape(['文件名第一'])),
      'ppt/slides/slide2.xml': slideXml(shape(['文件名第二']))
    })

    const result = extractPptxForRead(bytes, { maxChars: 64_000 })

    expect(result.note).toBeUndefined()
    expect(result.blocks.map((block) => block.body)).toEqual(['文件名第二', '文件名第一'])
    expect(result.blocks.map((block) => block.title)).toEqual(['第 1 页', '第 2 页'])
  })

  it('拿不到 presentation 关系：退回文件名序，并**如实标注**', () => {
    const bytes = zipOf({
      'ppt/slides/slide10.xml': slideXml(shape(['第十页'])),
      'ppt/slides/slide2.xml': slideXml(shape(['第二页']))
    })

    const result = extractPptxForRead(bytes, { maxChars: 64_000 })

    expect(result.note).toContain('页序')
    expect(result.blocks.map((block) => block.body)).toEqual(['第二页', '第十页'])
  })

  it('只有图片的页：明说"有 1 张图片，内容没有读"，不写成空白页', () => {
    const bytes = zipOf({ 'ppt/slides/slide1.xml': slideXml(PIC) })

    const [block] = extractPptxForRead(bytes, { maxChars: 64_000 }).blocks

    expect(block.body).toBe('（这页没有文字：有 1 张图片，内容没有读）')
    expect(block.body).not.toContain('空白')
  })

  it('有文字又有图片：文字照抽，末尾补一句图片没读', () => {
    const bytes = zipOf({ 'ppt/slides/slide1.xml': slideXml(shape(['结论']) + PIC) })

    expect(extractPptxForRead(bytes, { maxChars: 64_000 }).blocks[0].body).toBe(
      '结论\n（这页还有 1 张图片，内容没有读）'
    )
  })

  it('图表页：同样明说没读（不是空白页）', () => {
    const bytes = zipOf({ 'ppt/slides/slide1.xml': slideXml(CHART) })

    expect(extractPptxForRead(bytes, { maxChars: 64_000 }).blocks[0].body).toBe(
      '（这页没有文字：有 1 个图表，内容没有读）'
    )
  })

  it('真空页（没有文字也没有图片/图表）：如实说"没有抽到文字"', () => {
    const bytes = zipOf({ 'ppt/slides/slide1.xml': slideXml('') })

    expect(extractPptxForRead(bytes, { maxChars: 64_000 }).blocks[0].body).toBe(
      '（这页没有抽到文字）'
    )
  })

  it('真件读回：每一页一块，封面也在', async () => {
    const { data, slides } = await renderPptx({
      title: '汇报',
      slides: [{ title: '进展', bullets: ['第一条'] }]
    })

    const result = extractPptxForRead(data, { maxChars: 64_000 })

    expect(result.total).toBe(slides)
    expect(result.blocks).toHaveLength(slides)
    expect(result.blocks[0].title).toBe('第 1 页')
    expect(result.blocks[1].body).toContain('进展')
  })

  it('字符预算：装不下的页不抽，并如实说还有几页没读', () => {
    const bytes = zipOf({
      'ppt/slides/slide1.xml': slideXml(shape(['A'])),
      'ppt/slides/slide2.xml': slideXml(shape(['B'])),
      'ppt/slides/slide3.xml': slideXml(shape(['C']))
    })

    const result = extractPptxForRead(bytes, { maxChars: 25 })

    expect(result.blocks).toHaveLength(2)
    expect(result.unread).toBe(1)
    expect(result.truncated).toBe(true)
  })
})

describe('readTableForRead：csv 的行列与准确截断', () => {
  it('真文本：行号 + 列序；尾部的空行不算内容', () => {
    const table = readTableForRead('甲,乙\n丙,丁\n\n', '示例', ',', 64_000)

    expect(table.block.title).toBe('表格「示例」（2 行 × 2 列）')
    expect(table.block.body).toBe('行 1: 甲 | 乙\n行 2: 丙 | 丁')
    expect(table.truncated).toBe(false)
  })

  it('引号包着的空格与竖线：原样保住并加引号（不吞、不错位）', () => {
    const table = readTableForRead('" 含空格 ",b\n"a | b",c\n', '表', ',', 64_000)

    expect(table.block.body).toBe('行 1: " 含空格 " | b\n行 2: "a | b" | c')
  })

  it('BOM 不进第一格', () => {
    expect(readTableForRead('\uFEFF甲,乙\n', '表', ',', 64_000).block.body).toBe('行 1: 甲 | 乙')
  })

  it('字符预算：切在行边界上，并写清"只读到第几行"', () => {
    const rows = Array.from({ length: 20 }, (_all, index) => `第${index + 1}行,${'x'.repeat(20)}`)
    const table = readTableForRead(rows.join('\n'), '长表', ',', 120)

    expect(table.truncated).toBe(true)
    expect(table.block.body).toContain('读出总量有上限')
    expect(table.block.body).toMatch(/只读到第 \d+ 行/)
    expect(table.rowCount).toBe(20)
  })

  it('列超上限：另起一句说清共几列、只读了前几列', () => {
    const header = Array.from({ length: SHEET_COLUMN_LIMIT + 1 }, (_all, index) => `c${index}`)
    const table = readTableForRead(header.join(',') + '\n', '宽表', ',', 64_000)

    expect(table.truncated).toBe(true)
    expect(table.block.body).toContain(`这份表格共 ${SHEET_COLUMN_LIMIT + 1} 列`)
    expect(table.block.body).toContain(`只读了前 ${SHEET_COLUMN_LIMIT} 列`)
  })
})

describe('parseTableText：工作台预览的输出合同没变', () => {
  it('形状与判据照旧（抽取核心换了一处实现，接口不变）', () => {
    expect(parseTableText('甲,乙\n丙,丁', '表', ',')).toEqual({
      name: '表',
      rows: [
        ['甲', '乙'],
        ['丙', '丁']
      ],
      truncated: false
    })
  })

  it('行超上限：只抽前 2000 行且 truncated=true（与改动前一致）', () => {
    const lines = Array.from({ length: SHEET_ROW_LIMIT + 3 }, (_all, index) => `r${index}`)
    const sheet = parseTableText(lines.join('\n'), '大', ',')

    expect(sheet.rows).toHaveLength(SHEET_ROW_LIMIT)
    expect(sheet.truncated).toBe(true)
  })
})
