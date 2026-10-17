// @vitest-environment node
/**
 * 产出物的**渲染层**用例（模块 4 §2）：五个渲染入口都是纯函数（数据 → 字符串/字节，无 IO），
 * 所以这里不碰工作区、不碰审批，只钉"产出的东西长什么样"：
 *   - 报告 HTML：自包含（内联样式、无外部请求）、转义标题、打印规则在；
 *   - xlsx / pptx / docx：**真解包**（zip 中央目录 + inflate，见 ./zip.ts）断言 OOXML 部件与核心文本，
 *     再各用**同库读回**验一次"库自己认"（ExcelJS 读单元格类型等）。
 *
 * PDF 不在这里：它的渲染就是转调注入的钩子，用例在 artifacts-tools.spec.ts（stub 钩子）。
 */
import { describe, expect, it } from 'vitest'
import { defaultArtifactName, renderReportHtml } from '../artifacts'
import { renderDocx } from '../docx'
import { renderXlsx } from '../excel'
import { renderPptx } from '../ppt'
import { readZipEntries, zipText } from './zip'

/** 同库读回 xlsx 用的 exceljs（与实现同一条装载口径：CJS 出口只有 default） */
async function loadExcelJs(): Promise<typeof import('exceljs')> {
  const loaded = (await import('exceljs')) as unknown as { default: typeof import('exceljs') }
  return loaded.default
}

/** exceljs 的 `load()` 入参类型（它的 d.ts 把自己的 `Buffer` 声明成 `extends ArrayBuffer`，见 loadWorkbook） */
type ExcelLoadInput = Parameters<import('exceljs').Workbook['xlsx']['load']>[0]

/**
 * 同库读回一份 xlsx。
 * 这里的断言不是绕校验：exceljs 的 d.ts 用 `declare interface Buffer extends ArrayBuffer {}` 当入参类型，
 * Node 的 Buffer 因此过不了它的参数检查，而**运行期它收的就是 Node Buffer**——按运行期事实断言一次。
 */
async function loadWorkbook(bytes: Buffer): Promise<import('exceljs').Workbook> {
  const ExcelJS = await loadExcelJs()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as ExcelLoadInput)
  return workbook
}

describe('renderReportHtml：自带样式的单文件报告', () => {
  it('自带外壳：doctype / lang / charset / 标题 / 内联样式，且没有任何外部请求', () => {
    const html = renderReportHtml({ title: '季度复盘', body: '<h2>结论</h2><p>稳中向好。</p>' })

    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<meta charset="utf-8">')
    expect(html).toContain('<title>季度复盘</title>')
    expect(html).toContain('<style>')
    expect(html).toContain('.kyclaw-report')
    // 正文原样嵌进来（模板只负责外壳，不改写模型给的 HTML）
    expect(html).toContain('<h2>结论</h2><p>稳中向好。</p>')
    // 离线可看：不引任何外部资源（字体/图片/CSS 全在内联样式里）
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/<link\b/)
    expect(html).not.toMatch(/<script\b/)
  })

  it('标题做 HTML 转义（正文不转义），页首大标题与 <title> 同一份', () => {
    const html = renderReportHtml({ title: 'A & B <b>粗</b>', body: '<p>正文 &amp; 保持</p>' })

    expect(html).toContain('<title>A &amp; B &lt;b&gt;粗&lt;/b&gt;</title>')
    expect(html).toContain('<h1>A &amp; B &lt;b&gt;粗&lt;/b&gt;</h1>')
    expect(html).toContain('<p>正文 &amp; 保持</p>')
    expect(html).not.toContain('A & B <b>粗</b>')
  })

  it('带打印规则（A4、保背景色、避免标题/表格被拆开）', () => {
    const html = renderReportHtml({ title: 'T', body: '<p>x</p>' })

    expect(html).toContain('@page{size:A4}')
    expect(html).toContain('print-color-adjust:exact')
    expect(html).toContain('@media print')
    expect(html).toContain('break-inside:avoid')
  })

  it('字体栈 = 章程逐字 DSH 中文链（拉丁回退 Segoe UI）；代码位 mono 同链；旧栈不再出现', () => {
    const html = renderReportHtml({ title: 'T', body: '<pre><code>x</code></pre>' })

    // 正文：系统无衬线拉丁回退 + DSH 中文链（顺序逐字，与 semantic.css 的 --font-ui 一致）
    expect(html).toContain(
      "font:16px/1.75 'Segoe UI','Noto Sans SC','Source Han Sans SC','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif"
    )
    // 代码位：mono 声部（Cascadia Mono 起）+ 同一条 DSH 中文链
    expect(html).toMatch(
      /code\{font-family:'Cascadia Mono','Cascadia Code',Consolas,'Noto Sans SC','Source Han Sans SC','PingFang SC','Hiragino Sans GB','Microsoft YaHei',monospace/
    )
    // P2 修掉的旧栈：Apple 系统字、雅黑优先、本机未装的 Noto Sans CJK SC 都不该再出现
    expect(html).not.toContain('-apple-system')
    expect(html).not.toContain('Noto Sans CJK SC')
    expect(html).not.toContain('"Microsoft YaHei","PingFang SC"')
  })
})

describe('defaultArtifactName：从标题派生文件名', () => {
  it('保留中文与全角标点、把非法字符换成空格、补上扩展名', () => {
    // 全角冒号在 Windows 文件名里合法：不替换（不去动用户的中文标点）
    expect(defaultArtifactName('季度小结：Q3/Q4', 'html')).toBe('季度小结：Q3 Q4.html')
    expect(defaultArtifactName('季度小结:Q3', 'html')).toBe('季度小结 Q3.html')
    expect(defaultArtifactName('a<b>c|d?e*f"g', 'pdf')).toBe('a b c d e f g.pdf')
  })

  it('摘掉自带扩展名（免得 报告.pdf.pdf）、去掉首尾点与空格、防路径穿越', () => {
    expect(defaultArtifactName('报告.pdf', 'pdf')).toBe('报告.pdf')
    expect(defaultArtifactName('  报告 .md  ', 'docx')).toBe('报告.docx')
    expect(defaultArtifactName('../evil', 'html')).toBe('evil.html')
    expect(defaultArtifactName('..', 'html')).toBe('产出物.html')
  })

  it('空标题 / Windows 保留名 / 超长标题都有兜底', () => {
    expect(defaultArtifactName('   ', 'xlsx')).toBe('产出物.xlsx')
    expect(defaultArtifactName('nul', 'xlsx')).toBe('产出物_nul.xlsx')
    const long = defaultArtifactName('哈'.repeat(200), 'html')
    expect(Array.from(long.replace(/\.html$/, '')).length).toBe(60)
  })

  it('控制字符（换行/制表/0x01）直接丢掉，不把非法字符带进文件名', () => {
    expect(defaultArtifactName('报告\n名\u0001单', 'html')).toBe('报告名单.html')
    expect(defaultArtifactName('a\u0000b', 'pdf')).toBe('ab.pdf')
  })
})

describe('renderXlsx：真解包 + 同库读回', () => {
  const sheets = [
    {
      name: '销量',
      rows: [
        ['名称', '数量', '备注'],
        ['甲', 42, null],
        ['乙', 3.5, '缺货'],
        ['丙', 0, true]
      ]
    },
    { name: '空表', rows: [] }
  ]

  it('解包：是要害部件齐备的 OOXML 工作簿（[Content_Types].xml + 两张表）', async () => {
    const entries = readZipEntries(await renderXlsx([sheets[0]]))
    const names = [...entries.keys()]

    expect(names).toContain('[Content_Types].xml')
    expect(names).toContain('xl/workbook.xml')
    expect(names).toContain('xl/worksheets/sheet1.xml')
    expect(zipText(entries, 'xl/workbook.xml')).toContain('销量')
    expect(zipText(entries, '[Content_Types].xml')).toContain('spreadsheetml.sheet.main+xml')
  })

  it('同库读回：行数与值都在，数字仍是数字（保号）', async () => {
    const workbook = await loadWorkbook(await renderXlsx(sheets))

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['销量', '空表'])

    const sheet = workbook.getWorksheet('销量')
    expect(sheet?.rowCount).toBe(4)
    expect(sheet?.getCell('A1').value).toBe('名称')
    expect(sheet?.getCell('B2').value).toBe(42)
    expect(typeof sheet?.getCell('B2').value).toBe('number')
    expect(sheet?.getCell('B3').value).toBe(3.5)
    expect(sheet?.getCell('C3').value).toBe('缺货')
    // null → 空单元格；布尔值原样
    expect(sheet?.getCell('C2').value).toBeNull()
    expect(sheet?.getCell('C4').value).toBe(true)
  })

  it('表名归一：非法字符换空格、超 31 截断、重名加序号', async () => {
    const workbook = await loadWorkbook(
      await renderXlsx([
        { name: '销售[2026]:Q3/Q4*?\\', rows: [['a']] },
        { name: '同名表', rows: [[1]] },
        { name: '同名表', rows: [[2]] },
        { name: '这个表名特别特别特别特别特别特别特别长超过三十一个字符了', rows: [[3]] }
      ])
    )

    const names = workbook.worksheets.map((sheet) => sheet.name)
    expect(names[0]).toBe('销售 2026 Q3 Q4')
    expect(names[1]).toBe('同名表')
    expect(names[2]).toBe('同名表(2)')
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(31)
      expect(name).not.toMatch(/[\\/?*[\]:]/)
    }
  })

  it('一张工作表都没有：抛错（不产出空工作簿）', async () => {
    await expect(renderXlsx([])).rejects.toThrow(/至少要有一张工作表/)
  })
})

describe('renderPptx：真解包', () => {
  it('解包：16:9 演示文稿，封面 + 每页一张 slide，文字进 slideN.xml', async () => {
    const { data: bytes, slides } = await renderPptx({
      title: '季度汇报',
      slides: [
        { title: '结论', bullets: ['营收增长 12%', '成本持平'] },
        // 空对象是模型常见的多余项：跳过，不产出一张空页
        {},
        { bullets: ['下一步：扩产'] }
      ]
    })

    // 页数按"实际写入"算：封面 + 两页有内容的（空对象那页被跳过）；模型没给结尾页就没有结尾页
    expect(slides).toBe(3)

    const entries = readZipEntries(bytes)
    const names = [...entries.keys()]
    expect(names).toContain('[Content_Types].xml')
    expect(names).toContain('ppt/presentation.xml')
    expect(names).toContain('ppt/slides/slide1.xml')
    expect(names).toContain('ppt/slides/slide2.xml')
    expect(names).toContain('ppt/slides/slide3.xml')
    expect(names).not.toContain('ppt/slides/slide4.xml')

    expect(zipText(entries, 'ppt/slides/slide1.xml')).toContain('季度汇报')
    const second = zipText(entries, 'ppt/slides/slide2.xml')
    expect(second).toContain('结论')
    expect(second).toContain('营收增长 12%')
    expect(second).toContain('成本持平')
    expect(zipText(entries, 'ppt/slides/slide3.xml')).toContain('下一步：扩产')
    // 末页就是模型给的那一页（round 62 的自动结尾页已删，见 ppt.ts 的 planPages）
    expect(zipText(entries, 'ppt/slides/slide3.xml')).not.toContain('谢谢观看')
    // 页尺寸按 16:9 落（LAYOUT_16x9 = 10in × 5.625in @914400 EMU/in）
    expect(zipText(entries, 'ppt/presentation.xml')).toContain('sldSz')
  })

  // round 77 改口径：`<a:normAutofit/>`（不带 fontScale）在"生成 → 导出"这条路上**不生效**
  // （pptxgenjs 的注释自己就写着"Shrink does not work automatically"），所以它**不是**防溢出机制——
  // 真正的防溢出是 ppt-fit.ts 的排版预算。这条用例只钉"文本框仍然带着它"这个结构事实。
  it('每个文本框仍带 <a:normAutofit（**不是**防溢出，真正的兜底见 ppt-fit.ts）', async () => {
    const { data } = await renderPptx({
      title: '季度汇报',
      slides: [{ title: '结论', bullets: ['营收增长 12%'] }]
    })

    const entries = readZipEntries(data)
    const boxes = (name: string): number =>
      (zipText(entries, name).match(/<a:normAutofit\b/g) ?? []).length

    // 封面一处（大标题）；正文页四处（页标题、要点块、页脚左右两格）
    expect(boxes('ppt/slides/slide1.xml')).toBe(1)
    expect(boxes('ppt/slides/slide2.xml')).toBe(4)
  })

  it('内容全空：仍然产出一页占位（不能是零页演示文稿）', async () => {
    const { data, slides } = await renderPptx({ slides: [{}] })
    expect(slides).toBe(1)
    expect(zipText(readZipEntries(data), 'ppt/slides/slide1.xml')).toContain('没有内容')
  })
})

describe('renderDocx：真解包', () => {
  it('解包：OOXML 文档，标题/段落/项目符号/表格都落到 word/document.xml', async () => {
    const bytes = await renderDocx({
      title: '实施方案',
      blocks: [
        { type: 'heading', text: '目标', level: 2 },
        { type: 'paragraph', text: '三步走完。' },
        { type: 'bullets', items: ['第一步：立项', '第二步：试点'] },
        {
          type: 'table',
          headers: ['阶段', '时间'],
          rows: [
            ['立项', 'Q4'],
            ['试点', 'Q1']
          ]
        },
        // 空段落与空表格跳过
        { type: 'paragraph', text: '   ' },
        { type: 'table', rows: [] }
      ]
    })

    const entries = readZipEntries(bytes)
    expect([...entries.keys()]).toContain('[Content_Types].xml')
    expect([...entries.keys()]).toContain('word/document.xml')

    const document = zipText(entries, 'word/document.xml')
    expect(document).toContain('实施方案')
    expect(document).toContain('Title')
    expect(document).toContain('Heading2')
    expect(document).toContain('目标')
    expect(document).toContain('三步走完。')
    expect(document).toContain('第一步：立项')
    expect(document).toContain('<w:tbl>')
    expect(document).toContain('阶段')
    expect(document).toContain('Q1')
  })
})
