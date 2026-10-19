// @vitest-environment node
/**
 * 办公档读取器（`src/main/workbench-office.ts`）：Word / Excel / PPT 抽结构 + csv/tsv 解析。
 *
 * fixture 是**真件**：docx/xlsx/pptx 由 `__tests__/fixtures/office-fixtures.ts` 用仓库现有生产依赖
 * （`docx` / `exceljs` / `pptxgenjs`）直接产出（Step 2 前从 `src/mastra/tools` 的产出器迁来，
 * 避免删旧内核时把 main 侧测试一起带崩）；pptx 里那些夹具造不出的形状
 * （标题占位符 / 页码乱序 / 超页数上限）用 `zip-fixture.ts` 手写的真 zip 造。
 * 全程只碰内存与临时目录，不写用户目录。
 */
import { describe, expect, it } from 'vitest'
import {
  fixtureDocx as renderDocx,
  fixturePptx as renderPptx,
  fixtureXlsx as renderXlsx
} from './fixtures/office-fixtures'
import {
  CSV_TEXT_MAX_BYTES,
  DOCX_MARKDOWN_MAX_CHARS,
  SHEET_COLUMN_LIMIT,
  SHEET_LIMIT,
  SHEET_ROW_LIMIT,
  SLIDE_LIMIT,
  extractDocx,
  extractPptx,
  extractXlsx,
  parseTableText
} from '../workbench-office'
import { zipOf } from './zip-fixture'

/** 1×1 的真 PNG（内嵌图夹具最小件） */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

/** 一页 slide 部件（`<a:t>` 文本按给定形状拼） */
function slideXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`
}

/** 一个形状：`placeholder` 给了就是标题占位符，`paragraphs` 每项一段 */
function shape(paragraphs: readonly string[], placeholder?: string): string {
  return rawShape(
    paragraphs.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join(''),
    placeholder
  )
}

/** 一个形状（段落 XML 原样给）：用来造 `<a:br/>` 这种段落内部的东西 */
function rawShape(paragraphs: string, placeholder?: string): string {
  const ph =
    placeholder === undefined ? '<p:nvPr/>' : `<p:nvPr><p:ph type="${placeholder}"/></p:nvPr>`
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/>${ph}</p:nvSpPr><p:txBody>${paragraphs}</p:txBody></p:sp>`
}

/** 一个表格形状（`<p:graphicFrame>` 里的 `<a:tbl>`，与 pptxgenjs 写出来的形状同构） */
function rawTable(rows: readonly (readonly string[])[]): string {
  const cell = (text: string): string =>
    `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`
  const tr = rows.map((row) => `<a:tr h="457200">${row.map(cell).join('')}</a:tr>`).join('')
  return (
    '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Table 0"/>' +
    '<p:cNvGraphicFramePr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/>' +
    '<a:ext cx="0" cy="0"/></p:xfrm><a:graphic><a:graphicData ' +
    'uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/>' +
    '<a:tblGrid><a:gridCol w="914400"/></a:tblGrid>' +
    `${tr}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  )
}

describe('extractDocx：Word → markdown', () => {
  it('真件读回：标题（Word 的 Title 样式 → `#`）/ 小标题 / 正文 / 项目符号都在 markdown 里', async () => {
    const bytes = await renderDocx({
      title: '季度报告',
      blocks: [
        { type: 'heading', text: '一、结论', level: 1 },
        { type: 'paragraph', text: '整体稳中向好。' },
        { type: 'bullets', items: ['第一点', '第二点'] }
      ]
    })

    const result = await extractDocx(bytes)

    expect(result.truncated).toBe(false)
    expect(result.markdown).toMatch(/^# 季度报告/)
    expect(result.markdown).toContain('# 一、结论')
    expect(result.markdown).toContain('整体稳中向好。')
    expect(result.markdown).toMatch(/^- 第一点$/m)
    expect(result.markdown).toMatch(/^- 第二点$/m)
  })

  it('内嵌图片一律不抽（不把 base64 巨图灌进预览），只在原位留一句人话', async () => {
    const { Document, ImageRun, Packer, Paragraph } = await import('docx')
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: '前面一段' }),
            new Paragraph({
              children: [
                new ImageRun({
                  data: TINY_PNG,
                  transformation: { width: 8, height: 8 },
                  type: 'png'
                })
              ]
            }),
            new Paragraph({ text: '后面一段' })
          ]
        }
      ]
    })

    const result = await extractDocx(Buffer.from(await Packer.toBuffer(doc)))

    expect(result.markdown).toContain('（图片已省略）')
    expect(result.markdown).not.toContain('base64')
    expect(result.markdown).toContain('前面一段')
    expect(result.markdown).toContain('后面一段')
  })

  it('超长文档按字符上限截断并如实标注', async () => {
    const long = '很长的段落'.repeat(Math.ceil(DOCX_MARKDOWN_MAX_CHARS / 5) + 1000)
    const bytes = await renderDocx({ blocks: [{ type: 'paragraph', text: long }] })

    const result = await extractDocx(bytes)

    expect(result.truncated).toBe(true)
    expect(result.markdown).toHaveLength(DOCX_MARKDOWN_MAX_CHARS)
  })

  it('不是 docx（损坏的字节）给人话，不吐栈', async () => {
    await expect(extractDocx(Buffer.from('这不是一个 docx'))).rejects.toThrow(
      /读不出这个 Word 文档/
    )
  })
})

describe('extractXlsx：Excel → 表', () => {
  it('真件读回：多张表各自的名字与单元格文本（数字已转成字符串）', async () => {
    const bytes = await renderXlsx([
      {
        name: '汇总',
        rows: [
          ['项目', '金额'],
          ['房租', 1200],
          ['水电', 340.5]
        ]
      },
      { name: '明细', rows: [['备注'], ['第一行']] }
    ])

    const result = await extractXlsx(bytes)

    expect(result.truncated).toBe(false)
    expect(result.sheets.map((sheet) => sheet.name)).toEqual(['汇总', '明细'])
    expect(result.sheets[0].rows).toEqual([
      ['项目', '金额'],
      ['房租', '1200'],
      ['水电', '340.5']
    ])
    expect(result.sheets[1].rows).toEqual([['备注'], ['第一行']])
    expect(result.sheets.every((sheet) => !sheet.truncated)).toBe(true)
  })

  it('尾部的空行不算内容（Excel 的格式残留不画进去）', async () => {
    const bytes = await renderXlsx([{ name: '空尾', rows: [['有内容'], [null], [null]] }])
    const result = await extractXlsx(bytes)
    expect(result.sheets[0].rows).toEqual([['有内容']])
  })

  it('行 / 列各自封顶并标 truncated（多出来的不抽）', async () => {
    const wide = Array.from({ length: SHEET_COLUMN_LIMIT + 3 }, (_all, index) => index + 1)
    const rows: number[][] = [wide]
    for (let index = 0; index < SHEET_ROW_LIMIT + 5; index++) rows.push([index])
    const bytes = await renderXlsx([{ name: '大表', rows }])

    const result = await extractXlsx(bytes)

    const sheet = result.sheets[0]
    expect(sheet.truncated).toBe(true)
    expect(sheet.rows).toHaveLength(SHEET_ROW_LIMIT)
    expect(sheet.rows[0]).toHaveLength(SHEET_COLUMN_LIMIT)
    expect(sheet.rows[0][0]).toBe('1')
    expect(sheet.rows[0][SHEET_COLUMN_LIMIT - 1]).toBe(String(SHEET_COLUMN_LIMIT))
  })

  it('工作簿张数超上限：只抽前 20 张，并由顶层 truncated 如实说', async () => {
    const sheets = Array.from({ length: SHEET_LIMIT + 2 }, (_all, index) => ({
      name: `表${index + 1}`,
      rows: [['x']]
    }))
    const bytes = await renderXlsx(sheets)

    const result = await extractXlsx(bytes)

    expect(result.sheets).toHaveLength(SHEET_LIMIT)
    expect(result.sheets[0].name).toBe('表1')
    expect(result.truncated).toBe(true)
  })
})

describe('parseTableText：csv / tsv', () => {
  it('RFC4180 那几件：引号包裹、`""` 是引号本身、引号内的分隔符与换行', () => {
    const sheet = parseTableText(
      '名称,说明\r\n"含,逗号","含""引号"""\r\n跨行,"第一行\n第二行"\r\n',
      '示例',
      ','
    )

    expect(sheet.name).toBe('示例')
    expect(sheet.rows).toEqual([
      ['名称', '说明'],
      ['含,逗号', '含"引号"'],
      ['跨行', '第一行\n第二行']
    ])
    expect(sheet.truncated).toBe(false)
  })

  it('BOM 与 CRLF 不影响第一格；最后一行没有换行结尾也收得下', () => {
    const sheet = parseTableText('\uFEFF甲,乙\r\n丙,丁', '表格', ',')
    expect(sheet.rows).toEqual([
      ['甲', '乙'],
      ['丙', '丁']
    ])
  })

  it('tsv 用制表符；行 / 列各自封顶', () => {
    const one = parseTableText('甲\t乙\n丙\t丁\n', '表', '\t')
    expect(one.rows).toEqual([
      ['甲', '乙'],
      ['丙', '丁']
    ])

    const wide = Array.from({ length: SHEET_COLUMN_LIMIT + 4 }, (_all, index) => `c${index}`)
    const lines = [wide.join(',')]
    for (let index = 0; index < SHEET_ROW_LIMIT + 3; index++) lines.push(`r${index}`)
    const big = parseTableText(lines.join('\n'), '大', ',')

    expect(big.truncated).toBe(true)
    expect(big.rows).toHaveLength(SHEET_ROW_LIMIT)
    expect(big.rows[0]).toHaveLength(SHEET_COLUMN_LIMIT)
    expect(big.rows[0][SHEET_COLUMN_LIMIT - 1]).toBe(`c${SHEET_COLUMN_LIMIT - 1}`)
  })

  it('尾部的空行去掉；上限常数与"头部只读 2MB"的口径都在', () => {
    expect(parseTableText('甲,乙\n\n\n', '表', ',').rows).toEqual([['甲', '乙']])
    expect(CSV_TEXT_MAX_BYTES).toBe(2 * 1024 * 1024)
  })
})

describe('extractPptx：PPT → 逐页文字提要', () => {
  it('真件读回：封面 + 内容，一页一张卡（产出器不写标题占位符 → 不给 title）', async () => {
    const { data, slides } = await renderPptx({
      title: '汇报',
      slides: [{ title: '进展', bullets: ['第一条', '第二条'] }]
    })

    const result = extractPptx(data)

    // create_ppt 不再自动补结尾页（模型没给就没有）；正文要点带「●」圆点前缀（主题化版式的点缀），
    // 封面外每页含页脚（文档标题 + 页码）——预览如实读全部文本。
    expect(slides).toBe(2)
    expect(result.slides).toEqual([
      { index: 1, lines: ['汇报'] },
      { index: 2, lines: ['进展', '● 第一条', '● 第二条', '汇报', '2'] }
    ])
    expect(result.truncated).toBe(false)
  })

  it('标题占位符认得出就是 title（不猜：普通文本框只进 lines）', () => {
    const bytes = zipOf({
      'ppt/slides/slide1.xml': slideXml(
        shape(['封面标题'], 'ctrTitle') + shape(['正文一', '正文二'])
      )
    })

    const result = extractPptx(bytes)

    expect(result.slides).toEqual([{ index: 1, title: '封面标题', lines: ['正文一', '正文二'] }])
  })

  it('页码按数字排（slide10 在第 2 页之后），`<a:br/>` 是真换行，XML 转义还原', () => {
    const bytes = zipOf({
      'ppt/slides/slide10.xml': slideXml(shape(['第十页'])),
      'ppt/slides/slide2.xml': slideXml(
        rawShape(
          '<a:p><a:r><a:t>前一段</a:t></a:r><a:br/><a:r><a:t>后一段 &amp; 结尾</a:t></a:r></a:p>'
        )
      ),
      'ppt/slides/slide1.xml': slideXml(shape(['第一页 &lt;标签&gt;']))
    })

    const result = extractPptx(bytes)

    expect(result.slides.map((slide) => slide.index)).toEqual([1, 2, 10])
    expect(result.slides[0].lines).toEqual(['第一页 <标签>'])
    // `<a:p>` 里的 `<a:br/>` 拆成两行
    expect(result.slides[1].lines).toEqual(['前一段', '后一段 & 结尾'])
    expect(result.slides[2].lines).toEqual(['第十页'])
  })

  it('页数超上限：只抽前 100 页并如实标注', () => {
    const files: Record<string, string> = {}
    for (let index = 1; index <= SLIDE_LIMIT + 1; index++) {
      files[`ppt/slides/slide${index}.xml`] = slideXml(shape([`第${index}页`]))
    }

    const result = extractPptx(zipOf(files))

    expect(result.slides).toHaveLength(SLIDE_LIMIT)
    expect(result.truncated).toBe(true)
    expect(result.slides[0].lines).toEqual(['第1页'])
    expect(result.slides[SLIDE_LIMIT - 1].lines).toEqual([`第${SLIDE_LIMIT}页`])
  })

  it('没有文字的形状与空段落不进卡片', () => {
    const bytes = zipOf({
      'ppt/slides/slide1.xml': slideXml(shape(['']) + shape(['有字']))
    })
    expect(extractPptx(bytes).slides).toEqual([{ index: 1, lines: ['有字'] }])
  })

  it('表格（<a:tbl>）的单元格文字也抽得到：按行列顺序，一行一句', () => {
    const bytes = zipOf({
      'ppt/slides/slide1.xml': slideXml(
        shape(['市场速览']) +
          rawTable([
            ['项目', '最新', '变动'],
            ['创业板指', '—', '-2.61%']
          ])
      )
    })

    expect(extractPptx(bytes).slides).toEqual([
      {
        index: 1,
        lines: ['市场速览', '项目 | 最新 | 变动', '创业板指 | — | -2.61%']
      }
    ])
  })

  it('表格里的空单元格留位（列不错位），行内文字顺序 = XML 里的顺序', () => {
    const bytes = zipOf({
      'ppt/slides/slide1.xml': slideXml(
        rawTable([
          ['甲', '', '丙'],
          ['1', '2']
        ]) + shape(['表下面的话'])
      )
    })

    expect(extractPptx(bytes).slides).toEqual([
      { index: 1, lines: ['甲 |  | 丙', '1 | 2', '表下面的话'] }
    ])
  })

  it('真件读回：create_ppt 产出的 table 版式页里，缺值占位 `—` 与数字都在（这正是模型自检要核的）', async () => {
    const { data } = await renderPptx({
      title: '今日新闻日报',
      slides: [
        {
          layout: 'table',
          title: '市场速览',
          table: {
            headers: ['项目', '最新', '变动'],
            rows: [
              ['上证指数', '3797.24', '-0.43%'],
              ['创业板指', '—', '-2.61%']
            ]
          }
        }
      ]
    })

    const result = extractPptx(data)
    const tablePage = result.slides.find((slide) =>
      slide.lines.some((line) => line.includes('上证指数'))
    )

    expect(tablePage).toBeDefined()
    expect(tablePage?.lines).toEqual(
      expect.arrayContaining([
        '项目 | 最新 | 变动',
        '上证指数 | 3797.24 | -0.43%',
        '创业板指 | — | -2.61%'
      ])
    )
  })

  it('包读不通（不是 zip / 中央目录坏了）给人话，不吐栈', () => {
    expect(() => extractPptx(Buffer.from('PK\x03\x04这不是一个真 zip'))).toThrow(
      /读不出这个 PPT 文件/
    )
  })
})
