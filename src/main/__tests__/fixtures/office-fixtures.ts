/**
 * 主进程测试的 **office 夹具工厂**（PB-028 的后继；只给测试用，不进产品代码）。
 *
 * 背景（2026-10-19 取证）：`src/mastra/tools/{docx,excel,ppt}.ts` 的 `renderDocx/renderXlsx/renderPptx`
 * 在 **`src/main/**` 的非 spec 代码里零调用**（workbench 预览走 LibreOffice：`src/main/office-preview.ts`）。
 * 它们唯一的"存活用途"是给这几个 main 侧 spec 造**真文件夹具**。Step 2 删 `src/mastra` 之前，
 * 把夹具生产挪到这里，以免删除时以「import 解析红」的形式炸掉别人的主干。
 *
 * 三条口径：
 * 1. **不消费 src/mastra**，只用仓库现有生产依赖 `docx` / `exceljs` / `pptxgenjs`；
 * 2. 不照抄那套排版量算（`ppt-fit` 41KB 不进这里）：夹具只需要"被测解析器能读懂的真文件"，
 *    结构性语义（标题样式、'✦ ' 项目符号、页脚 标题+页码、表格行）按断言需要构造；
 * 3. 函数名用 `fixture*`；spec 侧用 `fixtureDocx as renderDocx` 这类别名，**断言与调用点一行不动**。
 */
import { z } from '../../../shared/zod'

export type FixtureDocxBlock =
  | { type: 'heading'; text: string; level?: number }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: readonly string[] }

export interface FixtureDocxInput {
  title?: string
  blocks: readonly FixtureDocxBlock[]
}

/** 真 docx 字节（标题=Word Title 样式；heading 用 N 级标题；项目符号用 bullet 段落） */
export async function fixtureDocx(input: FixtureDocxInput): Promise<Buffer> {
  const { Document, HeadingLevel, Packer, Paragraph } = await import('docx')
  const headings: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6
  }
  const children: InstanceType<typeof Paragraph>[] = []
  const title = input.title?.trim() ?? ''
  if (title !== '') children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }))
  for (const block of input.blocks) {
    if (block.type === 'heading') {
      const text = block.text.trim()
      if (text === '') continue
      children.push(new Paragraph({ text, heading: headings[block.level ?? 1] ?? HeadingLevel.HEADING_1 }))
      continue
    }
    if (block.type === 'paragraph') {
      if (block.text.trim() === '') continue
      children.push(new Paragraph({ text: block.text }))
      continue
    }
    for (const item of block.items) {
      const text = item.trim()
      if (text !== '') children.push(new Paragraph({ text, bullet: { level: 0 } }))
    }
  }
  if (children.length === 0) children.push(new Paragraph({ text: '（这份文档没有内容）' }))
  return await Packer.toBuffer(new Document({ sections: [{ children }] }))
}

export type FixtureCell = string | number | boolean | null

export interface FixtureSheet {
  name: string
  rows: ReadonlyArray<ReadonlyArray<FixtureCell>>
}

const SHEET_NAME_MAX = 31
const SHEET_NAME_ILLEGAL = /[\\/?*[\]:]/g

/**
 * exceljs 的动态装载：CJS 出口经过 `module.exports`，Node ESM 互操作只拿得到 `default`
 * （与产品侧同一口径，见 `src/mastra/tools/excel.ts` 的 `loadExcelJs` 注释）。
 */
async function loadExcelJs(): Promise<typeof import('exceljs')> {
  const loaded = (await import('exceljs')) as unknown as { default: typeof import('exceljs') }
  return loaded.default
}

/** 真 xlsx 字节（多表、数字按单元格值写；尾部的 null 行照写，让解析器自己决定丢不丢） */
export async function fixtureXlsx(sheets: readonly FixtureSheet[]): Promise<Buffer> {
  if (sheets.length === 0) throw new Error('fixtureXlsx：至少要有一张工作表')
  const ExcelJS = await loadExcelJs()
  const workbook = new ExcelJS.Workbook()
  const used = new Set<string>()
  sheets.forEach((sheet, index) => {
    const worksheet = workbook.addWorksheet(uniqueSheetName(sheet.name, index, used))
    for (const row of sheet.rows) worksheet.addRow([...row])
  })
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

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

export const fixtureSlideSchema = z.object({
  title: z.string().optional(),
  bullets: z.array(z.string()).optional(),
  /** 大数字块（value + label 两个文本框就够了：夹具只保证"文字能被解析出来"） */
  stats: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  layout: z.string().optional(),
  table: z
    .object({
      headers: z.array(z.string()),
      rows: z.array(z.array(z.string()))
    })
    .optional()
})

export interface FixturePptxInput {
  title?: string
  slides: ReadonlyArray<z.infer<typeof fixtureSlideSchema>>
}

export interface FixturePptxResult {
  data: Buffer
  slides: number
}

/**
 * 真 pptx 字节。**只构造被测解析器需要读到的结构**（不复制排版量算）：
 * - 有 `title` 时先来一张只有标题的封面页；
 * - 每张内容页：标题文本框 + 项目符号文本框（`✦ ` 前缀）+ 页脚（文档标题、页码）；
 * - `layout:'table'` 的页把表格写成真正的 `a:tbl`，解析器按行用 ` | ` 拼。
 */
export async function fixturePptx(input: FixturePptxInput): Promise<FixturePptxResult> {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'
  const deckTitle = input.title?.trim() ?? ''
  let page = 0

  if (deckTitle !== '') {
    const cover = pptx.addSlide()
    cover.addText(deckTitle, { x: 0.6, y: 0.6, w: 8, h: 1 })
    page += 1
  }

  for (const slideInput of input.slides) {
    const slide = pptx.addSlide()
    page += 1
    const title = slideInput.title?.trim() ?? ''
    if (title !== '') slide.addText(title, { x: 0.6, y: 0.5, w: 8, h: 0.8 })
    const bullets = (slideInput.bullets ?? []).map((bullet) => `● ${bullet}`)
    if (bullets.length > 0) {
      slide.addText(
        bullets.map((line) => ({ text: line, options: { bullet: false, breakLine: true } })),
        { x: 0.6, y: 1.6, w: 8, h: 3 }
      )
    }
    if (slideInput.layout === 'table' && slideInput.table !== undefined) {
      const rows = [
        slideInput.table.headers.map((cell) => ({ text: cell })),
        ...slideInput.table.rows.map((row) => row.map((cell) => ({ text: cell })))
      ]
      slide.addTable(rows, { x: 0.6, y: 1.6, w: 8, fontSize: 12 })
    }
    const stats = slideInput.stats ?? []
    if (stats.length > 0) {
      slide.addText(
        stats.map((stat) => ({ text: `${stat.value} ${stat.label}`, options: { breakLine: true } })),
        { x: 0.6, y: 1.6, w: 8, h: 2 }
      )
    }
    if (deckTitle !== '') slide.addText(deckTitle, { x: 0.6, y: 5.3, w: 5, h: 0.3, fontSize: 9 })
    slide.addText(String(page), { x: 9.1, y: 5.3, w: 0.6, h: 0.3, fontSize: 9 })
  }

  if (page === 0) {
    const slide = pptx.addSlide()
    slide.addText('（这份演示文稿没有内容）', { x: 0.6, y: 0.6, w: 8, h: 1 })
    page = 1
  }

  const data = await pptx.write({ outputType: 'nodebuffer' })
  return {
    data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
    slides: page
  }
}
