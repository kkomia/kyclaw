/**
 * R90 验收探针的夹具：**自产现代格式 + 复用真实的旧版 Office 夹具**（只复制，绝不改源件）。
 *
 * 三种来源，逐条写在每个夹具的 `provenance` 里：
 *   1. **自产**：docx / pptx / xlsx 用仓库已有依赖（`docx` / `pptxgenjs` / `exceljs`）现场拼装，
 *      其余（csv / tsv / md / txt / ts / svg / html / pdf）是纯文本或脚本拼字节；
 *   2. **仓库资源**：`resources/icon.ico` 只读复制一份（真实 ICO，不必自己造一个假的）；
 *   3. **旧版真夹具**：`.superpowers/office-legacy-fixtures/`（本地件、不入库，来源见那目录的
 *      `SOURCES.md` / `sources.json`）里的真实 `.doc` / `.xls` / `.ppt`——**只 copyFileSync**，
 *      源件一个字节都不动；目录不在时这部分**跳过**并在结果里如实标出来（探针据此 skip 对应用例）。
 *
 * 落点永远是调用方给的临时工作区（`createInteractiveApp()` 的 `workspace`）：
 * 探针自带临时 profile，不碰用户的真实工作区与真实 profile。
 */
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 旧版 Office 真夹具（本地，不入库）。 */
export const LEGACY_FIXTURES_DIR = resolve('.superpowers', 'office-legacy-fixtures')
/** 仓库自带的真实 ICO（只读复制，不当夹具源件改）。 */
const REPO_ICON = resolve('resources', 'icon.ico')

export interface R90Fixture {
  /** 工作区里的文件名（探针按它定位 `[data-testid="file-row"][data-relative=…]`） */
  readonly name: string
  /** 期望的预览档（与 `preview/modes.ts` 的口径一致，供报告对账） */
  readonly mode: 'office' | 'table' | 'markdown' | 'text' | 'code' | 'image' | 'html' | 'pdf'
  /** 这份夹具从哪来（报告里逐条列） */
  readonly provenance: string
}

export interface R90FixtureSet {
  /** 夹具落点（临时工作区根） */
  readonly dir: string
  readonly written: readonly R90Fixture[]
  /** 没写成的（旧版夹具目录缺失等） */
  readonly skipped: readonly { fixture: R90Fixture; reason: string }[]
}

export const R90_MODERN_FIXTURES: readonly R90Fixture[] = [
  { name: '报告.docx', mode: 'office', provenance: '自产（docx 包：标题 + 三节中文正文）' },
  { name: '汇报.pptx', mode: 'office', provenance: '自产（pptxgenjs：8 页中文）' },
  { name: '压力.pptx', mode: 'office', provenance: '自产（pptxgenjs：20 页，切走取消用）' },
  { name: '台账.xlsx', mode: 'table', provenance: '自产（exceljs：两张中文表）' },
  { name: '名单.csv', mode: 'table', provenance: '自产（UTF-8 文本：中文 + 带引号逗号）' },
  { name: '名单.tsv', mode: 'table', provenance: '自产（UTF-8 文本：制表符分隔）' },
  { name: '说明.md', mode: 'markdown', provenance: '自产（含 $…$ 行内数学与表格）' },
  { name: '笔记.txt', mode: 'text', provenance: '自产（纯文本）' },
  {
    name: '长文.txt',
    mode: 'text',
    provenance: '自产（约 700 KB 纯文本：3 页分页 + 尾标记 R90-TAIL-END）'
  },
  { name: '轮询.txt', mode: 'text', provenance: '自产（约 200 B：磁盘改动后验自动刷新）' },
  { name: '片段.ts', mode: 'code', provenance: '自产（TypeScript 片段，走 shiki 高亮）' },
  { name: '预览.svg', mode: 'image', provenance: '自产（文本 SVG）' },
  { name: '图标.ico', mode: 'image', provenance: '仓库资源 resources/icon.ico（只读复制）' },
  { name: '网页.html', mode: 'html', provenance: '自产（含 <script> 与哨兵外链，验"不执行")' },
  { name: '样本.pdf', mode: 'pdf', provenance: '自产（脚本拼装：3 页 + /Outlines 供大纲断言）' }
]

export const R90_LEGACY_FIXTURES: readonly R90Fixture[] = [
  {
    name: '旧方案.doc',
    mode: 'office',
    provenance: '`.superpowers/office-legacy-fixtures/SampleDoc.doc`（真实 OLE 文档，只读复制）'
  },
  {
    name: '底表.xls',
    mode: 'table',
    provenance:
      '`.superpowers/office-legacy-fixtures/chinese-provinces.xls`（真实旧版工作簿，中文内容，只读复制）'
  },
  {
    name: '旧汇报.ppt',
    mode: 'office',
    provenance:
      '`.superpowers/office-legacy-fixtures/basic_test_ppt_file.ppt`（真实旧版演示文稿，只读复制）'
  }
]

/** 旧版夹具在本地目录里的文件名 → 工作区里的名字。 */
const LEGACY_SOURCES: Readonly<Record<string, string>> = {
  '旧方案.doc': 'SampleDoc.doc',
  '底表.xls': 'chinese-provinces.xls',
  '旧汇报.ppt': 'basic_test_ppt_file.ppt'
}

/**
 * 三个依赖的装载口径（**容错**）：e2e 由 Playwright 编译后再跑，`await import()` 在 CJS 产物里
 * 拿到的可能是模块命名空间、也可能把 `module.exports` 放在 `default` 上（三个包都是 CJS/dual
 * 混合、仓库里各处的写法也不统一）。两种形状都认 —— 因为一个互操作细节让**夹具阶段**挂掉，
 * 会把探针的测试槽白烧掉。
 */
function pickFrom<T>(module: Record<string, unknown>, name: string): T {
  const fallback = module['default']
  const value =
    module[name] ??
    (typeof fallback === 'object' && fallback !== null
      ? (fallback as Record<string, unknown>)[name]
      : undefined)
  if (value === undefined) throw new Error(`依赖里没有 ${name}（版本换了吗？）`)
  return value as T
}

/** 写一份中文 docx（标题 + 三节）。 */
async function docxBytes(): Promise<Buffer> {
  const module = (await import('docx')) as unknown as Record<string, unknown>
  const Document = pickFrom<new (options: object) => object>(module, 'Document')
  const Packer = pickFrom<{ toBuffer: (document: object) => Promise<Buffer> }>(module, 'Packer')
  const Paragraph = pickFrom<new (options: object) => object>(module, 'Paragraph')
  const TextRun = pickFrom<new (options: object) => object>(module, 'TextRun')
  const HeadingLevel = pickFrom<Record<string, string>>(module, 'HeadingLevel')

  const paragraphs = [
    new Paragraph({
      heading: HeadingLevel['HEADING_1'],
      children: [new TextRun({ text: 'R90 验收报告' })]
    }),
    ...['本周进展', '遇到的问题', '下周计划'].map(
      (title) =>
        new Paragraph({
          heading: HeadingLevel['HEADING_2'],
          children: [new TextRun({ text: title })]
        })
    ),
    new Paragraph({ children: [new TextRun({ text: '正文里有中文，用来验文字选择与复制。' })] })
  ]
  return Packer.toBuffer(new Document({ sections: [{ children: paragraphs }] }))
}

/** 写一份 pptx（`slides` 页，每页一句中文）。 */
async function pptxBytes(slides: number): Promise<Buffer> {
  const module = (await import('pptxgenjs')) as unknown as Record<string, unknown>
  const PptxGenJS = pickFrom<
    new () => {
      layout: string
      addSlide: () => { addText: (text: string, options: object) => void }
      write: (options: { outputType: string }) => Promise<unknown>
    }
  >(module, 'default')
  const deck = new PptxGenJS()
  deck.layout = 'LAYOUT_16x9'
  for (let index = 1; index <= slides; index += 1) {
    const page = deck.addSlide()
    page.addText(`第 ${String(index)} 页`, { x: 0.5, y: 0.4, w: 9, h: 1, fontSize: 28 })
    page.addText(`R90 页式预览验收 (${String(index)}/${String(slides)})`, {
      x: 0.5,
      y: 1.6,
      w: 9,
      h: 0.8,
      fontSize: 14
    })
  }
  return (await deck.write({ outputType: 'nodebuffer' })) as Buffer
}

/** 写一份两张表的 xlsx。 */
async function xlsxBytes(): Promise<Buffer> {
  const module = (await import('exceljs')) as unknown as Record<string, unknown>
  const workbook = new (pickFrom<
    new () => {
      addWorksheet: (name: string) => { addRow: (row: unknown[]) => void }
      xlsx: { writeBuffer: () => Promise<unknown> }
    }
  >(module, 'Workbook'))()
  const summary = workbook.addWorksheet('汇总')
  summary.addRow(['项目', '金额'])
  summary.addRow(['房租', 1200])
  summary.addRow(['水电', 340])
  const detail = workbook.addWorksheet('明细')
  detail.addRow(['备注'])
  detail.addRow(['第二张表'])
  return Buffer.from((await workbook.xlsx.writeBuffer()) as ArrayBuffer)
}

/**
 * 拼一份 3 页、带 `/Outlines` 书签的 PDF（不依赖任何库：对象 + 手工 xref）。
 * 字体用标准 Helvetica（不嵌字体、也不碰预定义 CMap），这样"缩略图 / 大纲"这条断言
 * 不会被资源加载问题搅进来（CMap 那件事另有 R89 探针）。
 *
 * 对象编号（**不留空号**，手工 xref 才自洽）：
 *   1 目录 · 2 页树 · 3/5/7 三页 · 4/6/8 三页内容流 · 9 大纲根 · 10 字体 · 11/12/13 三条书签
 */
function pdfBytes(): Buffer {
  const pageObjects = [3, 5, 7]
  const contentObjects = [4, 6, 8]
  const outlineObjects = [11, 12, 13]
  const objects: string[] = []

  objects[1] = '<< /Type /Catalog /Pages 2 0 R /Outlines 9 0 R /PageMode /UseOutlines >>'
  objects[2] = `<< /Type /Pages /Kids [${pageObjects
    .map((id) => `${String(id)} 0 R`)
    .join(' ')}] /Count ${String(pageObjects.length)} >>`
  pageObjects.forEach((pageId, index) => {
    const stream = `BT /F1 24 Tf 72 700 Td (R90 PDF page ${String(index + 1)}) Tj ET\n`
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 10 0 R >> >> /Contents ${String(contentObjects[index] ?? 0)} 0 R >>`
    const contentId = contentObjects[index] ?? 0
    objects[contentId] = `<< /Length ${String(stream.length)} >>\nstream\n${stream}endstream`
  })
  objects[9] =
    `<< /Type /Outlines /First ${String(outlineObjects[0] ?? 0)} 0 R ` +
    `/Last ${String(outlineObjects[outlineObjects.length - 1] ?? 0)} 0 R ` +
    `/Count ${String(pageObjects.length)} >>`
  objects[10] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  outlineObjects.forEach((outlineId, index) => {
    const previous = index === 0 ? null : outlineObjects[index - 1]
    const next = index === outlineObjects.length - 1 ? null : outlineObjects[index + 1]
    // 书签的 `/Dest` 指向**页对象**（不是书签自己）——pdf.js 靠它算跳哪一页
    objects[outlineId] =
      `<< /Title (Chapter ${String(index + 1)}) /Parent 9 0 R ` +
      `${previous === undefined || previous === null ? '' : `/Prev ${String(previous)} 0 R `}` +
      `${next === undefined || next === null ? '' : `/Next ${String(next)} 0 R `}` +
      `/Dest [${String(pageObjects[index] ?? 0)} 0 R /Fit] >>`
  })

  const lastId = outlineObjects[outlineObjects.length - 1] ?? 0
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id <= lastId; id += 1) {
    const object = objects[id]
    if (object === undefined) throw new Error(`PDF 对象 ${String(id)} 缺了（手工拼装要连号）`)
    offsets[id] = body.length
    body += `${String(id)} 0 obj\n${object}\nendobj\n`
  }
  const xrefOffset = body.length
  body += `xref\n0 ${String(lastId + 1)}\n0000000000 65535 f \n`
  for (let id = 1; id <= lastId; id += 1) {
    body += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`
  }
  body += `trailer\n<< /Size ${String(lastId + 1)} /Root 1 0 R >>\nstartxref\n${String(
    xrefOffset
  )}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

/** HTML 夹具：脚本要改标题、还要打两个哨兵请求——两件都不该发生。 */
function htmlFixture(sentinelUrl: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh"><head><meta charset="utf-8"><title>R90-HTML</title></head><body>',
    '<h1>脚本与网络都不该执行</h1>',
    `<p><img src="${sentinelUrl}/r90-img.png" alt="哨兵图片"></p>`,
    '<script>',
    "document.title = 'R90_SCRIPT_RAN';",
    `fetch('${sentinelUrl}/r90-fetch');`,
    '</script>',
    '</body></html>',
    ''
  ].join('\n')
}

const SVG_FIXTURE = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120" viewBox="0 0 240 120">',
  '  <rect width="240" height="120" fill="#1a7f37"/>',
  '  <text x="120" y="68" font-size="20" text-anchor="middle" fill="#ffffff">R90 SVG</text>',
  '</svg>',
  ''
].join('\n')

const MARKDOWN_FIXTURE = [
  '# R90 预览验收',
  '',
  '行内数学：$E = mc^2$，块级数学：',
  '',
  '$$',
  '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
  '$$',
  '',
  '| 列 | 值 |',
  '| --- | --- |',
  '| 甲 | 1 |',
  '',
  '正文里也有中文，选中复制用得上。',
  ''
].join('\n')

const CODE_FIXTURE = [
  'interface R90Ledger {',
  '  readonly amount: number',
  '}',
  '',
  'export function totalOf(rows: readonly R90Ledger[]): number {',
  '  return rows.reduce((sum, row) => sum + row.amount, 0)',
  '}',
  ''
].join('\n')

const TEXT_FIXTURE = 'R90 纯文本：中文一行，第二行。\n'
/** 轮询夹具的初值（探针随后会把它改写成 V2 —— 那一改就是磁盘编辑）。 */
export const POLL_FIXTURE = 'R90-V1 磁盘上还没改过\n第二行\n'
/** 长文夹具的尾标记（只有读到最后一页才该出现）。 */
export const LONG_TEXT_TAIL = 'R90-TAIL-END'
/**
 * 长文夹具：按字节堆到约 700 KB（一页 256 KB → 三页），每行都带中文，
 * 尾标记只放在最后一行 ——「加载更多」点到底才看得到它。
 */
function LONG_TEXT_FIXTURE(): string {
  const pad = '分页验收长行'.repeat(12)
  const lines: string[] = []
  let bytes = 0
  let index = 0
  while (bytes < 700 * 1024) {
    index += 1
    const line = `R90-LINE-${String(index).padStart(5, '0')} ${pad}\n`
    bytes += Buffer.byteLength(line, 'utf8')
    lines.push(line)
  }
  lines.push(`${LONG_TEXT_TAIL} 最后一页的标记\n`)
  return lines.join('')
}
const CSV_FIXTURE = '姓名,年龄,备注\n张三,28,"带,逗号的备注"\n李四,31,正常\n'
const TSV_FIXTURE = '姓名\t年龄\n张三\t28\n李四\t31\n'

/**
 * 把整套夹具写进工作区。
 * @param workspace 临时工作区根（探针用 `createInteractiveApp()` 给的那个）。
 * @param options `sentinelUrl` 是探针自己起的哨兵服务地址（HTML 夹具拿它当"不该被访问"的目标）。
 * @returns 写成了什么、跳过了什么（跳过的一定写明原因）。
 */
export async function writeR90Fixtures(
  workspace: string,
  options: { sentinelUrl: string }
): Promise<R90FixtureSet> {
  mkdirSync(workspace, { recursive: true })
  const written: R90Fixture[] = []
  const skipped: { fixture: R90Fixture; reason: string }[] = []
  const write = (name: string, data: Buffer | string): void => {
    writeFileSync(join(workspace, name), data)
  }

  write('报告.docx', await docxBytes())
  write('汇报.pptx', await pptxBytes(8))
  write('压力.pptx', await pptxBytes(20))
  write('台账.xlsx', await xlsxBytes())
  write('名单.csv', CSV_FIXTURE)
  write('名单.tsv', TSV_FIXTURE)
  write('说明.md', MARKDOWN_FIXTURE)
  write('笔记.txt', TEXT_FIXTURE)
  write('长文.txt', LONG_TEXT_FIXTURE())
  write('轮询.txt', POLL_FIXTURE)
  write('片段.ts', CODE_FIXTURE)
  write('预览.svg', SVG_FIXTURE)
  write('网页.html', htmlFixture(options.sentinelUrl))
  write('样本.pdf', pdfBytes())

  for (const fixture of R90_MODERN_FIXTURES) {
    if (fixture.name === '图标.ico') {
      if (existsSync(REPO_ICON) && statSync(REPO_ICON).isFile()) {
        copyFileSync(REPO_ICON, join(workspace, fixture.name))
        written.push(fixture)
      } else {
        skipped.push({ fixture, reason: `仓库里没有 ${REPO_ICON}` })
      }
      continue
    }
    written.push(fixture)
  }

  for (const fixture of R90_LEGACY_FIXTURES) {
    const source = LEGACY_SOURCES[fixture.name]
    const sourcePath = source === undefined ? null : join(LEGACY_FIXTURES_DIR, source)
    if (sourcePath === null || !existsSync(sourcePath)) {
      skipped.push({
        fixture,
        reason: `旧版真夹具不在本地：${sourcePath ?? LEGACY_FIXTURES_DIR}（该目录不入库）`
      })
      continue
    }
    copyFileSync(sourcePath, join(workspace, fixture.name))
    written.push(fixture)
  }

  return { dir: workspace, written, skipped }
}
