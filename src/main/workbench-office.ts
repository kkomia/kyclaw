/**
 * 办公档的读取器（工作台预览用）：把 Word / Excel / PPT 的字节**抽成结构**，再交给渲染端画。
 *
 * 为什么在主进程抽而不是把字节丢给渲染端：
 *   - docx/xlsx/pptx 都是 OOXML zip 容器，渲染端没有（也不该有）解包能力，浏览器侧也没有可靠的
 *     "Word 转 markdown"这条路；抽好结构过 IPC 的载荷也比原字节小得多；
 *   - 抽的时候顺手设上限（表张数/行/列、页数、markdown 字符数）——**上限在这里一刀切**，
 *     渲染端只管画和如实标注，不重复实现"截到哪"。
 *
 * 依赖与装载口径：
 *   - `mammoth`（BSD-2-Clause，仓库唯一为本轮新增的依赖）：docx → markdown，**动态 import**
 *     （与 exceljs / pdfjs 同路数：主进程启动不付这份代价）。它的 CJS 出口是 `exports.xxx = …`，
 *     且**自带的 d.ts 少了 `convertToMarkdown`**，所以类型面在本地补一张（见 MammothModule）；
 *   - `exceljs`：与 `src/mastra/tools/excel.ts` 同一条装载口径（CJS 出口只有 default）；
 *   - pptx：自己解 zip + 抽 `<a:t>` 文本，读侧复用 `src/mastra/tools/artifact-check.ts` 的
 *     `readZipEntries`（**一处实现**：产出侧的落盘自检与预览侧的读回共用同一份 zip 解析，
 *     不为预览再写第二套 inflate/CRC；它只依赖 node:zlib/node:path，同进程 import 不拉进别的东西）。
 *
 * 失败一律抛**中文人话**（"读不出这个 Word 文档（文件可能损坏）"这种）：能走到这里的文件已经过了
 * 扩展名 + 文件头两道闸，再读不通就是文件本身坏了，不该含糊成"二进制文件"。
 */
import { readZipEntries } from '../mastra/tools/artifact-check'
import type { PreviewSheet, PreviewSlide } from '../shared/workbench'

/** Excel 最多抽多少张工作表（多出来的不抽，由 `truncated` 如实标注） */
export const SHEET_LIMIT = 20
/** 每张表最多抽多少行 */
export const SHEET_ROW_LIMIT = 2000
/** 每张表最多抽多少列 */
export const SHEET_COLUMN_LIMIT = 100
/** Word 转出来的 markdown 最多留多少字符（再多就不是"预览"了） */
export const DOCX_MARKDOWN_MAX_CHARS = 200_000
/** PPT 最多抽多少页 */
export const SLIDE_LIMIT = 100
/**
 * csv/tsv 解析前只读文件头这么多字节（不把 32MB 全读进内存）。
 * 与其它格式的 32MB 上限是两回事：这里截的是"喂给解析器的文本"，超了标 `truncated`。
 */
export const CSV_TEXT_MAX_BYTES = 2 * 1024 * 1024

/** mammoth 的实际出口（d.ts 少了 `convertToMarkdown`，这里按运行期事实补） */
interface MammothImage {
  contentType?: string
}

interface MammothModule {
  convertToMarkdown: (
    input: { buffer: Buffer },
    options?: {
      /** 内嵌图片一律不抽（返回空属性 → 图片在 markdown 里只留一句"（图片已省略）"） */
      convertImage?: { __mammothBrand: 'ImageConverter' }
      /** 追加的样式映射（排在默认映射前面） */
      styleMap?: readonly string[]
    }
  ) => Promise<{ value: string; messages: ReadonlyArray<{ message: string }> }>
  images: {
    imgElement: (convert: (image: MammothImage) => Promise<Record<string, string>>) => {
      __mammothBrand: 'ImageConverter'
    }
  }
}

/**
 * 装载 mammoth。两种形态都兜住：Node 的 ESM 互操作能拿到具名导出（`exports.convertToMarkdown`），
 * 打包后的 CJS 命名空间则可能只在 `default` 上（与 exceljs 同一类坑，见 src/mastra/tools/excel.ts）。
 */
async function loadMammoth(): Promise<MammothModule> {
  const loaded = (await import('mammoth')) as unknown as MammothModule & {
    default?: MammothModule
  }
  return typeof loaded.convertToMarkdown === 'function' ? loaded : (loaded.default as MammothModule)
}

/** exceljs 与实现同口径的装载（CJS 出口只有 default） */
async function loadExcelJs(): Promise<typeof import('exceljs')> {
  const loaded = (await import('exceljs')) as unknown as { default: typeof import('exceljs') }
  return loaded.default
}

/** docx 的抽取结果（与 shared 的判别分支同一个形状） */
export interface DocxExtract {
  markdown: string
  truncated: boolean
}

/** xlsx 的抽取结果 */
export interface XlsxExtract {
  sheets: PreviewSheet[]
  truncated: boolean
}

/** pptx 的抽取结果 */
export interface PptxExtract {
  slides: PreviewSlide[]
  truncated: boolean
}

/** 图片在 markdown 里的占位（mammoth 抽不了图片，也别把 base64 巨图灌进预览） */
const IMAGE_OMITTED = '（图片已省略）'

/**
 * 空属性 + 固定 alt：mammoth 的 markdown 写法对"没有 src 也没有 alt"的图片**整段丢掉**，
 * 那样文档里凭空少一块、用户不知道这儿原本有图。给一个固定 alt 就能留下一句占位，
 * 再把 `![（图片已省略）]()` 换成人话（见下面 replaceAll）。
 */
function omittedImage(mammoth: MammothModule): { __mammothBrand: 'ImageConverter' } {
  return mammoth.images.imgElement(async () => ({ src: '', alt: IMAGE_OMITTED }))
}

/**
 * docx → markdown 的自定义样式映射：Word 的**内置标题样式**（style id 固定叫 `Title`，
 * 中文版 Word 的显示名是「标题」但 id 不变）在默认映射里没有归宿，会塌成普通段落 ——
 * 预览里文档标题就不像标题了。这里补一条，让它在 markdown 里是 `#`。
 * 自定义条目排在默认映射**前面**（mammoth 的顺序是 custom → embedded → default），所以这一步生效。
 */
const DOCX_STYLE_MAP = ['p.Title => h1:fresh']

/** Word（.docx）→ markdown。内嵌图片一律不抽，只留一句占位。 */
export async function extractDocx(bytes: Uint8Array): Promise<DocxExtract> {
  const mammoth = await loadMammoth()

  let value: string
  try {
    const result = await mammoth.convertToMarkdown(
      { buffer: Buffer.from(bytes) },
      { convertImage: omittedImage(mammoth), styleMap: DOCX_STYLE_MAP }
    )
    value = result.value
  } catch (cause) {
    throw new Error(`读不出这个 Word 文档（文件可能损坏）：${messageOf(cause)}`)
  }

  // mammoth 把"没有 src 的图片"写成 `![alt]()`；统一换成人话占位
  // （用正则而不是精确串匹配：将来换文案或 mammoth 多转义一个字符都不会漏）
  const text = value.replace(/!\[[^\]]*\]\(\s*\)/g, IMAGE_OMITTED).trim()
  const clipped = text.length > DOCX_MARKDOWN_MAX_CHARS
  return {
    markdown: clipped ? text.slice(0, DOCX_MARKDOWN_MAX_CHARS) : text,
    truncated: clipped
  }
}

/** Excel（.xlsx）→ 每张工作表的单元格文本。 */
export async function extractXlsx(bytes: Uint8Array): Promise<XlsxExtract> {
  const ExcelJS = await loadExcelJs()
  const workbook = new ExcelJS.Workbook()
  try {
    // exceljs 的 d.ts 把自己的 Buffer 声明成 `extends ArrayBuffer`，而运行期收的就是 Node Buffer
    await workbook.xlsx.load(
      Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]
    )
  } catch (cause) {
    throw new Error(`读不出这个 Excel 文件（文件可能损坏）：${messageOf(cause)}`)
  }

  const worksheets = workbook.worksheets
  const sheets = worksheets.slice(0, SHEET_LIMIT).map(readSheet)
  return { sheets, truncated: worksheets.length > sheets.length }
}

/** 一张工作表 → 文本矩阵（行/列各自封顶，末尾的空行不算内容） */
function readSheet(sheet: import('exceljs').Worksheet): PreviewSheet {
  const lastRow = Math.min(sheet.rowCount, SHEET_ROW_LIMIT)
  const lastColumn = Math.min(sheet.columnCount, SHEET_COLUMN_LIMIT)

  const rows: string[][] = []
  for (let index = 1; index <= lastRow; index++) {
    const row = sheet.getRow(index)
    const cells: string[] = []
    for (let column = 1; column <= lastColumn; column++) cells.push(row.getCell(column).text ?? '')
    rows.push(cells)
  }

  // 尾部的空行是 Excel 的常态（格式残留），不算内容；中间的空行保留（那是真断行）
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === '')) rows.pop()

  return {
    name: sheet.name,
    rows,
    truncated: sheet.rowCount > SHEET_ROW_LIMIT || sheet.columnCount > SHEET_COLUMN_LIMIT
  }
}

/**
 * PowerPoint（.pptx）→ 逐页的文字提要。
 *
 * 版式不还原（调研结论：浏览器侧没有可信的高保真渲染），只把 `ppt/slides/slideN.xml` 里的
 * `<a:t>` 文本按段落抽出来：一页一张卡，读得到内容、读不到排版 —— 在界面上如实说明。
 * 抽的是**形状（`<p:sp>`）与表格（`<a:tbl>`）两类**：表格里的字同样在 `<a:t>` 里，不抽就会
 * 出现"这一页明明有表，预览只剩标题"（实测：一份带行情表的 deck，第 4 页只剩「市场速览」，
 * 表里的缺值 `—` 一个字都看不到）。
 */
export function extractPptx(bytes: Uint8Array): PptxExtract {
  let entries: Map<string, Buffer>
  try {
    entries = readZipEntries(bytes)
  } catch (cause) {
    throw new Error(`读不出这个 PPT 文件（文件可能损坏）：${messageOf(cause)}`)
  }

  const slideNames = [...entries.keys()]
    .filter((name) => SLIDE_ENTRY.test(name))
    .sort((left, right) => slideNumberOf(left) - slideNumberOf(right))

  const slides = slideNames.slice(0, SLIDE_LIMIT).map((name, position) => {
    const xml = entries.get(name)?.toString('utf8') ?? ''
    return readSlide(xml, slideNumberOf(name) || position + 1)
  })

  return { slides, truncated: slideNames.length > slides.length }
}

/** 一页一条 slide 部件（与 artifact-check 的产出侧口径同一个正则） */
const SLIDE_ENTRY = /^ppt\/slides\/slide\d+\.xml$/

/** `ppt/slides/slide12.xml` → 12（认不出给 0，由调用方兜底成顺序号） */
function slideNumberOf(name: string): number {
  const matched = /slide(\d+)\.xml$/.exec(name)
  return matched === null ? 0 : Number(matched[1])
}

/** 一个内容块（形状或表格）抽出来的文字：段落 + 是不是标题占位符（表格永远不是标题） */
interface ShapeText {
  title: boolean
  paragraphs: string[]
}

/**
 * slide 里的内容块，**按文档顺序**：形状 `<p:sp>` 与表格 `<a:tbl>` 都是 shape tree 里的同级元素，
 * 抽出来要跟眼睛看到的顺序一致（表格在形状下面时，行也不该跑到形状前面）。
 * 直接盯 `<a:tbl>` 而不是外面的 `<p:graphicFrame>`：chart / 图片也是 graphicFrame，它们不带表格；
 * 而表格偶尔会裹在 `<mc:AlternateContent>` 里，盯 `<a:tbl>` 两种写法都收得到。
 */
const SLIDE_BLOCK = /<p:sp>[\s\S]*?<\/p:sp>|<a:tbl(?:\s[^>]*)?>[\s\S]*?<\/a:tbl>|<a:tbl\/>/g

/** 表格里的一行 / 一个单元格（`<a:tc hMerge="1">` 这类带属性的、`<a:tc/>` 这类空的都要收） */
const TABLE_ROW = /<a:tr(?:\s[^>]*)?>[\s\S]*?<\/a:tr>/g
const TABLE_CELL = /<a:tc(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/a:tc>)/g

/**
 * 抽一页的文字。逐块走：标题占位符（`<p:ph type="title|ctrTitle">`）的第一个段落当标题，
 * 其余段落都进正文行 —— **认不出占位符就不给 title**（宁可不给，也不猜哪一行"看起来像标题"）。
 * 段落里的 `<a:br/>` 是真换行，拆成两行；`<a:t>` 的 XML 转义在这里还原。
 */
function readSlide(xml: string, index: number): PreviewSlide {
  const shapes: ShapeText[] = []
  for (const block of xml.match(SLIDE_BLOCK) ?? []) {
    if (block.startsWith('<a:tbl')) {
      const rows = tableLines(block)
      if (rows.length > 0) shapes.push({ title: false, paragraphs: rows })
      continue
    }

    const title = /<p:ph[^>]*\btype="(?:title|ctrTitle)"/.test(block)
    const paragraphs: string[] = []
    for (const paragraph of block.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? []) {
      for (const piece of paragraph.split(/<a:br\s*\/?>/)) {
        const text = runsText(piece)
        if (text !== '') paragraphs.push(text)
      }
    }
    if (paragraphs.length > 0) shapes.push({ title, paragraphs })
  }

  const titleShape = shapes.find((shape) => shape.title)
  const title = titleShape?.paragraphs[0]
  const lines: string[] = []
  for (const shape of shapes) {
    const start = shape === titleShape ? 1 : 0
    lines.push(...shape.paragraphs.slice(start))
  }

  return title === undefined ? { index, lines } : { index, title, lines }
}

/**
 * 一件 `<a:tbl>` → 每行一句（单元格按列序用 ` | ` 连起来）。
 *
 * 为什么拍平成行文本、不给 `PreviewSlide` 加结构化字段：`lines` 是预览（PptxPreview）与
 * `render_ppt` 的"逐页文字自检"共用的既有形状，改形状要同时动 IPC schema 与渲染端；
 * 而这里要解决的问题只是"表格里的字看不见"（`—` 这类缺值抽不到）。`甲 | — | 丙` 既让预览看得见，
 * 也让退化自检的模型读得出**列对列**的空值。
 *
 * 空单元格**保留空位**（不去掉），列才不会错位（合并单元格那些空 `<a:tc>` 同样占一列）；
 * 整行都没字的行不留（那是画表格时的空行）。
 */
function tableLines(table: string): string[] {
  const lines: string[] = []
  for (const row of table.match(TABLE_ROW) ?? []) {
    const cells = (row.match(TABLE_CELL) ?? []).map(cellText)
    if (cells.every((cell) => cell === '')) continue
    lines.push(cells.join(' | '))
  }
  return lines
}

/** 一个单元格的文字：段内换行（`<a:br/>`）与多段落都并成一句（一格就是一句，别把表格撑成多行） */
function cellText(cell: string): string {
  const text = (cell.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [])
    .map((paragraph) =>
      paragraph
        .split(/<a:br\s*\/?>/)
        .map(runsText)
        .filter((piece) => piece !== '')
        .join(' ')
    )
    .filter((paragraph) => paragraph !== '')
    .join(' ')
  return text.trim()
}

/** 一段（`<a:br/>` 之间的片段）里的 `<a:t>`：拼接 + 还原 XML 转义 + 去首尾空白 */
function runsText(fragment: string): string {
  return (fragment.match(/<a:t>[\s\S]*?<\/a:t>/g) ?? [])
    .map((run) => unescapeXml(run.replace(/<\/?a:t>/g, '')))
    .join('')
    .trim()
}

/** XML 文本转义还原（`<a:t>` 里只有这几个 + 数字实体） */
function unescapeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_all, hex: string) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_all, dec: string) => codePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 数字实体 → 字符（越界/非法就原样丢一个空串之外的空格，不抛） */
function codePoint(value: number): string {
  return Number.isFinite(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : ''
}

/**
 * csv/tsv → 一张表（简版 RFC4180：双引号包裹、`""` 是引号本身、引号内可以换行）。
 * 分隔符按后缀定（`.tsv` 用制表符）；行列各自封顶，超了标 `truncated`。
 * 文本只读头部 2MB（调用方截好），所以这里的"截断"是**内容**层面的，字节层面另算。
 */
export function parseTableText(text: string, name: string, delimiter: string): PreviewSheet {
  const rows: string[][] = []
  let truncated = false
  let cell = ''
  let row: string[] = []
  let quoted = false

  const closeCell = (): void => {
    if (row.length < SHEET_COLUMN_LIMIT) row.push(cell)
    else truncated = true
    cell = ''
  }
  const closeRow = (): void => {
    closeCell()
    if (rows.length < SHEET_ROW_LIMIT) rows.push(row)
    else truncated = true
    row = []
  }

  // 去掉 UTF-8 BOM（Excel 导出的 csv 常带）
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (quoted) {
      if (char !== '"') {
        cell += char
      } else if (body[index + 1] === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = false
      }
      continue
    }
    if (char === '"' && cell === '') quoted = true
    else if (char === delimiter) closeCell()
    else if (char === '\n') closeRow()
    else if (char !== '\r') cell += char
  }
  // 最后一行没有换行结尾时也要收
  if (cell !== '' || row.length > 0) closeRow()

  while (rows.length > 0 && rows[rows.length - 1].every((value) => value === '')) rows.pop()
  return { name, rows, truncated }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
