// @vitest-environment node
/**
 * 产出物工具的**执行层**用例（模块 4 §2）：五个工具的落盘、默认文件名派生、guard 三档
 * （ask 要审批 / full 免审 /
 * 越界 fail closed）与 PDF 的**注入钩子**（stub），最后连生五份做一次端到端。
 *
 * PDF 在这里走 stub：真实现（Electron printToPDF）在主进程侧（main/print-pdf.ts），
 * 不在 vitest 的 node 环境里跑 —— 这条链路的存在性由 main 侧的冒烟脚本证（见模块 4 报告）。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PdfPrinter } from '../artifacts'
import { createDocxTool, docxInputSchema } from '../docx'
import { createExcelTool, excelInputSchema } from '../excel'
import { createPptTool, pptInputSchema } from '../ppt'
import { createPdfTool, createReportTool, pdfInputSchema, reportInputSchema } from '../report'
import { callTool, createBed, readText, type TestBed } from './helpers'
import { readZipEntries, zipText } from './zip'

/** stub 钩子记下的 HTML（断言"工具把渲染好的报告交给了主进程"） */
const printed: string[] = []

/** 默认 stub：真 PDF 的断头（%PDF-），字节数够断"落盘>"0 */
const stubPrintPdf: PdfPrinter = async (html) => {
  printed.push(html)
  return Buffer.from('%PDF-1.4\nstub body\n%%EOF\n', 'utf8')
}

let bed: TestBed

beforeEach(() => {
  bed = createBed()
  printed.length = 0
})

afterEach(() => {
  bed.dispose()
})

/** 审批 gate 的形状与 write 一致：工具定义上的 requireApproval，收工具入参 */
function gateOf(tool: unknown): (input: unknown) => boolean {
  return (tool as { requireApproval: (input: unknown) => boolean }).requireApproval
}

describe('create_report：落盘与默认文件名', () => {
  it('不给 path：从标题派生文件名，父目录不用建，回执带路径/字节数/种类', async () => {
    const tool = await createReportTool(bed.ctx)
    const out = String(
      await callTool(tool, { title: '季度小结：Q3/Q4', html: '<h2>结论</h2><p>稳。</p>' })
    )

    const file = join(bed.root, '季度小结：Q3 Q4.html')
    expect(existsSync(file)).toBe(true)
    expect(out).toContain(file)
    expect(out).toContain('已创建')
    expect(out).toContain('HTML 报告')
    expect(out).toMatch(/（\d+ 字节，HTML 报告）/)

    const html = readText(file)
    expect(html).toContain('<title>季度小结：Q3/Q4</title>')
    expect(html).toContain('<h2>结论</h2><p>稳。</p>')
    expect(out).toContain(`${statSync(file).size} 字节`)
  })

  it('给了 path：父目录自动建；再写一次是"已覆盖"', async () => {
    const tool = await createReportTool(bed.ctx)

    const first = String(
      await callTool(tool, { title: 'r', html: '<p>一</p>', path: 'reports/q3/report.html' })
    )
    expect(first).toContain('已创建')
    expect(statSync(join(bed.root, 'reports', 'q3', 'report.html')).size).toBeGreaterThan(0)

    const second = String(
      await callTool(tool, { title: 'r', html: '<p>二</p>', path: 'reports/q3/report.html' })
    )
    expect(second).toContain('已覆盖')
    expect(readText(join(bed.root, 'reports', 'q3', 'report.html'))).toContain('<p>二</p>')
  })

  it('目标是目录：拒绝（不把它当文件写）', async () => {
    const tool = await createReportTool(bed.ctx)
    mkdirSync(join(bed.root, 'sub'))
    await expect(callTool(tool, { title: 'x', html: '<p>x</p>', path: 'sub' })).rejects.toThrow(
      /目录/
    )
  })

  it('产出物写完后可直接 edit（报告是文本，记了"已读"）', async () => {
    const report = await createReportTool(bed.ctx)
    const { createEditTool } = await import('../edit')
    const edit = await createEditTool(bed.ctx)

    await callTool(report, { title: 'R', html: '<p>旧</p>' })
    await expect(
      callTool(edit, { path: 'R.html', oldText: '<p>旧</p>', newText: '<p>新</p>' })
    ).resolves.toContain('已替换')
  })
})

describe('产出物：guard 三档（与 write 同口径）', () => {
  it('ask 工作区要审批；切 full 后免审 —— 没给 path（派生名）也一样', async () => {
    const tool = await createReportTool(bed.ctx)
    const gate = gateOf(tool)

    expect(gate({ title: '报告', html: '<p>x</p>' })).toBe(true)
    expect(gate({ title: '报告', html: '<p>x</p>', path: 'a.html' })).toBe(true)

    bed.roots[0].mode = 'full'
    expect(gate({ title: '报告', html: '<p>x</p>' })).toBe(false)
    expect(gate({ title: '报告', html: '<p>x</p>', path: 'sub/a.html' })).toBe(false)
  })

  it('命中"永久允许"规则（工具 × 工作区）→ 免审；别的工具照样问', async () => {
    const report = await createReportTool(bed.ctx)
    const docx = await createDocxTool(bed.ctx)
    bed.rules.push({ tool: 'create_report', workspace: bed.root, mode: 'allow' })

    expect(gateOf(report)({ title: 'R', html: '<p>x</p>' })).toBe(false)
    expect(gateOf(docx)({ title: 'D', blocks: [{ type: 'paragraph', text: 'x' }] })).toBe(true)
  })

  it('越界：不弹审批（执行会 fail closed），执行时明确拒绝且不落盘', async () => {
    const tool = await createReportTool(bed.ctx)
    const outside = join(bed.outside, 'x.html')

    expect(gateOf(tool)({ title: 'x', html: '<p>x</p>', path: outside })).toBe(false)
    await expect(callTool(tool, { title: 'x', html: '<p>x</p>', path: outside })).rejects.toThrow(
      /授权工作区/
    )
    await expect(
      callTool(tool, { title: 'x', html: '<p>x</p>', path: '../outside/y.html' })
    ).rejects.toThrow(/授权工作区/)
    expect(existsSync(outside)).toBe(false)
  })

  it('没有任何授权工作区：明确报"先去设置里添加"', async () => {
    const tool = await createExcelTool(bed.ctx)
    bed.roots.length = 0
    await expect(callTool(tool, { sheets: [{ name: 'S', rows: [[1]] }] })).rejects.toThrow(
      /授权工作区/
    )
  })
})

describe('create_pdf：注入的打印钩子', () => {
  it('钩子收到渲染好的报告 HTML；PDF 字节落盘、回执报 PDF', async () => {
    const tool = await createPdfTool(bed.ctx, stubPrintPdf)
    const out = String(await callTool(tool, { title: '月度简报', html: '<h2>要点</h2>' }))

    const file = join(bed.root, '月度简报.pdf')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file).subarray(0, 5).toString('utf8')).toBe('%PDF-')
    expect(out).toContain(file)
    expect(out).toContain('字节，PDF）')
    expect(out).toContain('；结构校验通过')

    expect(printed).toHaveLength(1)
    expect(printed[0]).toContain('<title>月度简报</title>')
    expect(printed[0]).toContain('<style>')
    expect(printed[0]).toContain('<h2>要点</h2>')
  })

  it('没注入钩子（没有 electron 那侧）：报"没有注入打印钩子"，不落半截文件', async () => {
    const tool = await createPdfTool(bed.ctx)
    await expect(callTool(tool, { title: 'x', html: '<p>x</p>' })).rejects.toThrow(/打印钩子/)
    expect(existsSync(join(bed.root, 'x.pdf'))).toBe(false)
  })

  it('钩子抛错：翻成"PDF 导出失败"+ 原因（并提示可先出 HTML）', async () => {
    const failing: PdfPrinter = async () => {
      throw new Error('窗口创建失败')
    }
    const tool = await createPdfTool(bed.ctx, failing)
    await expect(callTool(tool, { title: 'x', html: '<p>x</p>' })).rejects.toThrow(
      /PDF 导出失败：窗口创建失败/
    )
  })

  it('钩子返回的不是 PDF（没有 %PDF- 头 / 末尾没有 %%EOF）：抛错且不落盘', async () => {
    const notPdf: PdfPrinter = async () => Buffer.from('<html>其实是 HTML</html>', 'utf8')
    const tool = await createPdfTool(bed.ctx, notPdf)

    await expect(callTool(tool, { title: 'x', html: '<p>x</p>' })).rejects.toThrow(/结构自检没通过/)
    expect(existsSync(join(bed.root, 'x.pdf'))).toBe(false)

    const truncated: PdfPrinter = async () => Buffer.from('%PDF-1.4\n1 0 obj\n', 'utf8')
    const tool2 = await createPdfTool(bed.ctx, truncated)
    await expect(callTool(tool2, { title: 'y', html: '<p>y</p>' })).rejects.toThrow(/%%EOF/)
    expect(existsSync(join(bed.root, 'y.pdf'))).toBe(false)
  })

  it('越界路径在打印之前就被拒（白跑一次打印是最贵的错）', async () => {
    const tool = await createPdfTool(bed.ctx, stubPrintPdf)
    await expect(
      callTool(tool, { title: 'x', html: '<p>x</p>', path: join(bed.outside, 'x.pdf') })
    ).rejects.toThrow(/授权工作区/)
    expect(printed).toHaveLength(0)
  })
})

describe('create_excel / create_ppt / create_docx：落盘', () => {
  it('create_excel：默认文件名取第一个工作表名，回执带表数/行数', async () => {
    const tool = await createExcelTool(bed.ctx)
    const out = String(
      await callTool(tool, {
        sheets: [
          {
            name: '销量',
            rows: [
              ['名称', '数量'],
              ['甲', 42]
            ]
          },
          { name: '备注', rows: [['下周再看']] }
        ]
      })
    )

    const file = join(bed.root, '销量.xlsx')
    expect(existsSync(file)).toBe(true)
    expect(out).toContain('2 张工作表／3 行')
    // 产出后结构自检的结论拼在回执尾部
    expect(out).toContain('；结构校验通过')
    expect(statSync(file).size).toBeGreaterThan(0)
  })

  it('create_ppt：落盘为真 pptx（解包能读到页与文字）', async () => {
    const tool = await createPptTool(bed.ctx)
    const out = String(
      await callTool(tool, { title: '汇报', slides: [{ title: '结论', bullets: ['增长 12%'] }] })
    )

    const file = join(bed.root, '汇报.pptx')
    expect(existsSync(file)).toBe(true)
    expect(out).toContain('1 页演示文稿')
    expect(out).toContain('；结构校验通过')

    const entries = readZipEntries(readFileSync(file))
    expect([...entries.keys()]).toContain('ppt/presentation.xml')
    expect(zipText(entries, 'ppt/slides/slide2.xml')).toContain('增长 12%')
  })

  it('create_ppt：主题 + 版式走完整链路（schema → 渲染 → 落盘）', async () => {
    const tool = await createPptTool(bed.ctx)
    const out = String(
      await callTool(tool, {
        title: '季度复盘',
        theme: '商务蓝',
        slides: [
          { section: '业务概览' },
          { title: '关键指标', stats: [{ value: '12%', label: '营收同比' }] }
        ]
      })
    )

    const file = join(bed.root, '季度复盘.pptx')
    expect(existsSync(file)).toBe(true)
    expect(out).toContain('；结构校验通过')

    const entries = readZipEntries(readFileSync(file))
    // 封面 + 章节 + 数字卡 + 自动结尾页
    expect(
      [...entries.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    ).toHaveLength(4)
    const stats = zipText(entries, 'ppt/slides/slide3.xml')
    expect(stats).toContain('val="1F5FA9"')
    expect(stats).toContain('微软雅黑')
    expect(stats).toContain('<a:t>12%</a:t>')
  })

  it('create_docx：落盘为真 docx（解包能读到正文）', async () => {
    const tool = await createDocxTool(bed.ctx)
    const out = String(
      await callTool(tool, {
        title: '方案',
        blocks: [
          { type: 'heading', text: '目标' },
          { type: 'paragraph', text: '三步走。' }
        ],
        path: 'docs/方案.docx'
      })
    )

    const file = join(bed.root, 'docs', '方案.docx')
    expect(existsSync(file)).toBe(true)
    expect(out).toContain('2 个内容块')
    expect(out).toContain('；结构校验通过')

    const entries = readZipEntries(readFileSync(file))
    const document = zipText(entries, 'word/document.xml')
    expect(document).toContain('目标')
    expect(document).toContain('三步走。')
  })
})

describe('端到端：一个会话根里连生五份', () => {
  it('报告 / PDF / Excel / PPT / Word：都在、都非空、都能读回（PDF 断头）', async () => {
    const report = await createReportTool(bed.ctx)
    const pdf = await createPdfTool(bed.ctx, stubPrintPdf)
    const excel = await createExcelTool(bed.ctx)
    const ppt = await createPptTool(bed.ctx)
    const docx = await createDocxTool(bed.ctx)

    const receipts = [
      await callTool(report, { title: '季度复盘', html: '<h2>结论</h2><p>稳中向好。</p>' }),
      await callTool(pdf, { title: '季度复盘', html: '<h2>结论</h2><p>稳中向好。</p>' }),
      await callTool(excel, {
        sheets: [
          {
            name: '营收',
            rows: [
              ['季度', '金额'],
              ['Q3', 1234.5]
            ]
          }
        ]
      }),
      await callTool(ppt, {
        title: '季度复盘',
        slides: [{ title: '结论', bullets: ['稳中向好'] }]
      }),
      await callTool(docx, {
        title: '季度复盘',
        blocks: [{ type: 'paragraph', text: '稳中向好。' }]
      })
    ].map((result) => String(result))

    const files = {
      report: join(bed.root, '季度复盘.html'),
      pdf: join(bed.root, '季度复盘.pdf'),
      excel: join(bed.root, '营收.xlsx'),
      ppt: join(bed.root, '季度复盘.pptx'),
      docx: join(bed.root, '季度复盘.docx')
    }
    for (const [kind, file] of Object.entries(files)) {
      expect(existsSync(file), `${kind} 应该落盘`).toBe(true)
      expect(statSync(file).size, `${kind} 不该是空文件`).toBeGreaterThan(0)
      expect(receipts.join('\n')).toContain(file)
    }

    // 读回：HTML 是文本、xlsx 走同库、docx/pptx 解包、PDF 断头
    expect(readText(files.report)).toContain('<p>稳中向好。</p>')
    const ExcelJS = (await import('exceljs')) as unknown as { default: typeof import('exceljs') }
    const workbook = new ExcelJS.default.Workbook()
    // exceljs 的 d.ts 用 `Buffer extends ArrayBuffer` 当 load() 入参类型，Node 的 Buffer 过不了检查；
    // 运行期它收的就是 Node Buffer，按运行期事实断言一次
    type ExcelLoadInput = Parameters<typeof workbook.xlsx.load>[0]
    await workbook.xlsx.load(readFileSync(files.excel) as unknown as ExcelLoadInput)
    expect(workbook.getWorksheet('营收')?.getCell('B2').value).toBe(1234.5)
    expect(zipText(readZipEntries(readFileSync(files.docx)), 'word/document.xml')).toContain(
      '稳中向好。'
    )
    expect(zipText(readZipEntries(readFileSync(files.ppt)), 'ppt/slides/slide2.xml')).toContain(
      '稳中向好'
    )
    expect(readFileSync(files.pdf).subarray(0, 5).toString('utf8')).toBe('%PDF-')
  })

  it('同名不同格式不互相覆盖（同一标题的两份产出物各在其位）', async () => {
    const report = await createReportTool(bed.ctx)
    const docx = await createDocxTool(bed.ctx)

    await callTool(report, { title: '同名', html: '<p>html</p>' })
    await callTool(docx, { title: '同名', blocks: [{ type: 'paragraph', text: 'docx' }] })

    expect(readText(join(bed.root, '同名.html'))).toContain('<p>html</p>')
    expect(readFileSync(join(bed.root, '同名.docx')).length).toBeGreaterThan(0)
  })
})

describe('路径口径：产出物只写工作区', () => {
  it('写进子目录与覆盖已有文件之外，不动工作区外的同名文件', async () => {
    const tool = await createReportTool(bed.ctx)
    const outside = join(bed.outside, 'keep.txt')
    writeFileSync(outside, '原样')

    await callTool(tool, { title: 'keep', html: '<p>x</p>' })
    expect(readText(outside)).toBe('原样')
    expect(existsSync(join(bed.root, 'keep.html'))).toBe(true)
  })
})

describe('输入上限：超限被 schema 拒（每件一例）', () => {
  /** 拒的同时把原因带出来：报错要让模型知道"怎么改" */
  function issuesOf(result: {
    success: boolean
    error?: { issues: Array<{ message: string }> }
  }): string {
    return result.error?.issues.map((issue) => issue.message).join('；') ?? ''
  }

  it('create_ppt：一页要点超过 30 条被拒', () => {
    const parsed = pptInputSchema.safeParse({
      slides: [
        { title: '结论', bullets: Array.from({ length: 31 }, (_, index) => `要点 ${index}`) }
      ]
    })
    expect(parsed.success).toBe(false)
    expect(issuesOf(parsed)).toContain('一页最多 30 条要点')
  })

  it('create_excel：单元格字符串超过 32767 字符被拒', () => {
    const parsed = excelInputSchema.safeParse({
      sheets: [{ name: 'S', rows: [['x'.repeat(32768)]] }]
    })
    expect(parsed.success).toBe(false)
    expect(issuesOf(parsed)).toContain('单元格字符串最长 32767 字符')
  })

  it('create_docx：内容块超过 1000 个被拒', () => {
    const parsed = docxInputSchema.safeParse({
      blocks: Array.from({ length: 1001 }, () => ({ type: 'paragraph', text: 'x' }))
    })
    expect(parsed.success).toBe(false)
    expect(issuesOf(parsed)).toContain('文档最多 1000 个内容块')
  })

  it('create_report：正文超过 200000 字符被拒', () => {
    const parsed = reportInputSchema.safeParse({ title: 'R', html: 'x'.repeat(200001) })
    expect(parsed.success).toBe(false)
    expect(issuesOf(parsed)).toContain('正文最多 200000 字符')
  })

  it('create_pdf：正文超过 200000 字符被拒', () => {
    const parsed = pdfInputSchema.safeParse({ html: 'x'.repeat(200001) })
    expect(parsed.success).toBe(false)
    expect(issuesOf(parsed)).toContain('正文最多 200000 字符')
  })
})
