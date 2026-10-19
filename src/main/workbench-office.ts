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
import { posix } from 'node:path'
import { readZipEntries } from './tools/artifact-check'
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

/** 解析出来的一张表（行列都按上限封顶，同时**记下截断前的真实规模**） */
interface ParsedTable {
  rows: string[][]
  /** 见过的总行数（含没抽进来的那些） */
  rowCount: number
  /** 见过的一行里最多的单元格数（含没抽进来的那些） */
  columnCount: number
  /** 行数到上限（后面的行没抽） */
  truncatedRows: boolean
  /** 列数到上限（后面的列没抽） */
  truncatedColumns: boolean
}

/**
 * csv/tsv 的核心解析（简版 RFC4180：双引号包裹、`""` 是引号本身、引号内可以换行）。
 * 行列各自封顶，**并且继续往下数**（顶掉的是"还有多少"，回执要如实说）；调用方只管给上限。
 */
function parseTableRows(
  text: string,
  delimiter: string,
  rowLimit: number,
  columnLimit: number
): ParsedTable {
  const rows: string[][] = []
  let cell = ''
  let row: string[] = []
  let quoted = false
  let rowCount = 0
  let columnCount = 0
  let cellsInRow = 0
  let truncatedRows = false
  let truncatedColumns = false

  const closeCell = (): void => {
    cellsInRow += 1
    if (row.length < columnLimit) row.push(cell)
    else truncatedColumns = true
    cell = ''
  }
  const closeRow = (): void => {
    closeCell()
    rowCount += 1
    columnCount = Math.max(columnCount, cellsInRow)
    cellsInRow = 0
    if (rows.length < rowLimit) rows.push(row)
    else truncatedRows = true
    row = []
  }

  // 去掉 BOM（Excel 导出的 csv 常带；UTF-16 的 BOM 在解码那一步已经处理掉）
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

  // 尾部的空行去掉；没被行上限截断时，行数也要跟着扣掉（不然"共 N 行"会多报）
  let popped = 0
  while (rows.length > 0 && rows[rows.length - 1].every((value) => value === '')) {
    rows.pop()
    popped += 1
  }
  if (!truncatedRows) rowCount -= popped
  return { rows, rowCount, columnCount, truncatedRows, truncatedColumns }
}

/**
 * csv/tsv → 一张表（简版 RFC4180：双引号包裹、`""` 是引号本身、引号内可以换行）。
 * 分隔符按后缀定（`.tsv` 用制表符）；行列各自封顶，超了标 `truncated`。
 * 文本只读头部 2MB（调用方截好），所以这里的"截断"是**内容**层面的，字节层面另算。
 *
 * **工作台预览的输出合同**：形状一字不动（`PreviewSheet`），read 那条路走
 * `readTableForRead`（要"截到第几行/第几列"的准确说法，预览不需要）。
 */
export function parseTableText(text: string, name: string, delimiter: string): PreviewSheet {
  const parsed = parseTableRows(text, delimiter, SHEET_ROW_LIMIT, SHEET_COLUMN_LIMIT)
  return {
    name,
    rows: parsed.rows,
    truncated: parsed.truncatedRows || parsed.truncatedColumns
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/* ── read 专用提取（0.1.2）：完整读 xlsx / pptx / csv ───────────────────────────────
 * 为什么不改造上面那三个抽取器：它们的形状是**工作台预览的 IPC 合同**（shared/workbench 的
 * PreviewSheet / PreviewSlide，渲染端照着画），改形状要同时动渲染端与 IPC schema；
 * 而 read 要的东西不一样 ——
 *   - 单元格要**地址定位**（行列号）、公式要分开"缓存 0"与"没缓存"、日期要稳定、空格不许吞；
 *   - PPT 要按 presentation 关系的**真实页序**，图片页/图表要说清"没读"而不是留白；
 *   - csv 要**准确**说清截在第几行 / 第几列。
 * 这些语义塞进预览合同只会把两边都搞坏，所以预览那三个导出**原样不动**，这里新增 read 专用入口
 * （内部共用 zip 解析 / exceljs 装载 / slide XML 抽取这三处的实现）。
 *
 * 输出统一是"块"（一张工作表 / 一页幻灯片），块正文已渲染成行；`maxChars` 是**跨块**的字符预算，
 * 装不下的块不抽、由 `unread` 如实报出数量 —— 调用方据此写"还有 N 张表 / N 页没读"。
 *
 * **上限沿用工作台预览那一组**（`SHEET_LIMIT` 20 张 / `SHEET_ROW_LIMIT` 2000 行 /
 * `SHEET_COLUMN_LIMIT` 100 列 / `SLIDE_LIMIT` 100 页）：这些数是本产品已经拍过的量，
 * read 不再另立一套（更宽的上限=更多内存与更长的回执，没有需求支撑）；真正的总闸是
 * `maxChars`（64000 字符，与附件那条路同一个数）。
 */

/** read 的一块内容：标题（read 渲染成 `### 标题`）+ 已渲染的正文 */
export interface ReadBlock {
  title: string
  body: string
}

/** read 的抽取结果（块 + 准确的截断账） */
export interface ReadBlocks {
  blocks: ReadBlock[]
  /** 一共多少块（工作表数 / 页数 / 表格行数见各块标题） */
  total: number
  /** 因为字符预算没能抽进来的块数（0 = 全在） */
  unread: number
  /** 有没有任何形式的截断（块自己的上限 / 字符预算 / 页数上限） */
  truncated: boolean
  /** 全局提示（如"页序按文件名排的"），由调用方拼在开头 */
  note?: string
}

export interface ReadExtractOptions {
  /** 这次抽取总共最多产出多少字符（跨块；**只在行/页边界上切**，不切半行） */
  maxChars: number
}

/** 两个数字对齐用的补零 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * exceljs 的日期 → 稳定文本。**为什么用 UTC**：exceljs 解析日期序列号走 `utils.excelToDate`
 * （`new Date(25569 起算的毫秒数)`，UTC 零点），所以 UTC 取值拿回来的就是文件里写的那个日期；
 * 用本地时区取值会随宿主机时区把日期挪一天（东八区 2026-10-15 00:00Z 会显示成 10-15 08:00）。
 * 只有"纯日期"（时分秒都为 0）才省略时间部分。
 */
function formatExcelDate(value: Date): string {
  const date = `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}-${pad2(value.getUTCDate())}`
  const time = `${pad2(value.getUTCHours())}:${pad2(value.getUTCMinutes())}`
  if (time === '00:00' && value.getUTCSeconds() === 0) return date
  return value.getUTCSeconds() === 0
    ? `${date} ${time}`
    : `${date} ${time}:${pad2(value.getUTCSeconds())}`
}

/**
 * 公式的**结果**部分：`undefined`（没有缓存值）与 `0`（缓存的就是 0）必须分开 ——
 * exceljs 自己的 `cell.text` 走 `result ? result.toString() : ''`，把两者都吞成空串（实测）。
 */
function formulaResultText(result: unknown): string {
  if (result === undefined || result === null) return '（没有缓存的计算结果）'
  if (result instanceof Date) return formatExcelDate(result)
  if (typeof result === 'object' && 'error' in (result as Record<string, unknown>)) {
    return String((result as Record<string, unknown>).error)
  }
  return String(result)
}

/**
 * 一个单元格的值 → 文本（**不 trim**：首尾空格是用户写进去的内容，吞掉就是改数据）。
 * 认得出公式/超链接/富文本/错误值这些形状；认不出的对象原样 JSON（如实展示，不猜）。
 */
function cellValueText(cell: import('exceljs').Cell): string {
  // 合并区域的"从属格"在 exceljs 里会回主人的值：照 Excel 的样子只显示主人那一格
  if (cell.isMerged && cell.master !== cell) return ''

  const value: unknown = cell.value
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return formatExcelDate(value)
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value !== 'object') return String(value)

  const record = value as Record<string, unknown>
  if ('error' in record) return String(record.error)
  if ('formula' in record || 'sharedFormula' in record) {
    const formula =
      typeof cell.formula === 'string'
        ? cell.formula
        : String(record.formula ?? record.sharedFormula ?? '')
    // **结果要从 `cell.result` 取，不能从 `cell.value` 里取**：`cell.value` 是 exceljs 的
    // `_copyModel` 副本，falsy 的 `result`（0 / '' / false）在里面已经被丢掉了（实测：一份
    // `<v>0</v>` 的工作簿读出来 `cell.value.result === undefined`，而 `cell.result === 0`）。
    return `=${formula} → ${formulaResultText(cell.result)}`
  }
  const richText = record.richText
  if (Array.isArray(richText)) {
    return richText.map((run) => String((run as { text?: unknown }).text ?? '')).join('')
  }
  if (typeof record.text === 'string') {
    return typeof record.hyperlink === 'string' && record.hyperlink !== record.text
      ? `${record.text}（${record.hyperlink}）`
      : record.text
  }
  return JSON.stringify(value)
}

/**
 * 单元格文本 → 一行里的一格：换行转义成 `\n`（不然一行会被撑成多行），
 * 首尾空白 / 竖线 / 引号这类"看不出来"的地方加引号（CSV 口径）。
 * **不另设单格字符上限**：Excel 硬上限就是 32767 字符，超出的行由字符预算在**行边界**上截（可解释），
 * 不是把一格切两半（不可解释）。
 */
function cellForRead(cell: import('exceljs').Cell): string {
  const text = cellValueText(cell)
  if (text === '') return ''
  const escaped = text.replace(/\r\n|\r|\n/g, '\\n')
  const needsQuote = escaped !== escaped.trim() || escaped.includes('|') || escaped.includes('"')
  return needsQuote ? `"${escaped.replace(/"/g, '""')}"` : escaped
}

/** 一张工作表 → read 的一块（按字符预算在**行边界**上切；行/列/预算三处截断都如实写进尾部） */
function readSheetBlock(
  sheet: import('exceljs').Worksheet,
  budget: number
): { block: ReadBlock | null; used: number; cut: boolean; hitBudget: boolean } {
  const rowCount = sheet.rowCount
  const columnCount = sheet.columnCount
  const scanRows = Math.min(rowCount, SHEET_ROW_LIMIT)
  const readColumns = Math.min(columnCount, SHEET_COLUMN_LIMIT)
  const title =
    rowCount === 0
      ? `工作表「${sheet.name}」（空工作表）`
      : `工作表「${sheet.name}」（${rowCount} 行 × ${columnCount} 列）`

  const headerCost = title.length + 4
  if (headerCost >= budget) return { block: null, used: headerCost, cut: false, hitBudget: false }

  const lines: string[] = []
  let used = headerCost
  let lastRow = 0
  let cutByBudget = false
  for (let index = 1; index <= scanRows; index++) {
    const row = sheet.getRow(index)
    const cells: string[] = []
    for (let column = 1; column <= readColumns; column++)
      cells.push(cellForRead(row.getCell(column)))
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
    if (cells.length === 0) continue
    const line = `行 ${index}: ${cells.join(' | ')}`
    if (used + line.length + 1 > budget) {
      cutByBudget = true
      break
    }
    lines.push(line)
    used += line.length + 1
    lastRow = index
  }

  const notes: string[] = []
  if (rowCount > SHEET_ROW_LIMIT) {
    notes.push(
      `这张表共 ${rowCount} 行，只读到第 ${scanRows} 行（一张表最多读 ${SHEET_ROW_LIMIT} 行）`
    )
  }
  if (columnCount > SHEET_COLUMN_LIMIT) {
    notes.push(`这张表共 ${columnCount} 列，只读了前 ${SHEET_COLUMN_LIMIT} 列`)
  }
  if (cutByBudget) {
    notes.push(
      lastRow === 0
        ? '这张表一行都没装下（读出总量有上限）'
        : `这张表只读到第 ${lastRow} 行（读出总量有上限），后面的行不在这里`
    )
  }
  if (lines.length === 0 && notes.length === 0 && rowCount > 0) {
    notes.push('这张表里没有可读的单元格内容')
  }

  const tail = notes.map((note) => `\n[${note}]`).join('')
  return {
    block: { title, body: lines.join('\n') + tail },
    used: used + tail.length,
    cut: rowCount > SHEET_ROW_LIMIT || columnCount > SHEET_COLUMN_LIMIT || cutByBudget,
    hitBudget: cutByBudget
  }
}

/**
 * Excel（.xlsx）→ read 的块。**只抽数据**：单元格一律带行列定位（`行 3: …` 从 A 列起按 ` | ` 分隔）、
 * 公式写成 `=公式 → 结果`（结果 0 与没有缓存分开）、日期走稳定格式、空格不吞、合并区域只显示主人那格。
 * 超长、超行、超列、超预算四处截断都写清"共多少、读到哪"。
 */
export async function extractXlsxForRead(
  bytes: Uint8Array,
  options: ReadExtractOptions
): Promise<ReadBlocks> {
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
  const readCount = Math.min(worksheets.length, SHEET_LIMIT)
  const blocks: ReadBlock[] = []
  let unread = 0
  let truncated = false
  let budget = options.maxChars

  for (let index = 0; index < readCount; index++) {
    const read = readSheetBlock(worksheets[index], budget)
    // 第一块无论如何收下（不然空输出比超一点的标题更难用）；后面的装不下就如实记"没读"
    if (read.block === null || (read.used > budget && blocks.length > 0)) {
      unread = worksheets.length - index
      truncated = true
      break
    }
    blocks.push(read.block)
    budget -= read.used
    if (read.cut) truncated = true
    // 这张表是被**字符预算**截住的：后面的表一律不抽（预算已经不够了），如实记数量
    if (read.hitBudget) {
      unread = worksheets.length - index - 1
      truncated = true
      break
    }
  }
  if (unread === 0 && worksheets.length > readCount) unread = worksheets.length - readCount
  if (unread > 0) truncated = true

  const note =
    worksheets.length > readCount
      ? `（这份工作簿共 ${worksheets.length} 张工作表，一次最多读 ${SHEET_LIMIT} 张）`
      : undefined
  return {
    blocks,
    total: worksheets.length,
    unread,
    truncated,
    ...(note === undefined ? {} : { note })
  }
}

/**
 * 一页 slide 里"有内容但没读"的东西（图片 / 图表 / SmartArt 图示）：read 抽的是文字，
 * 这些只报数量 —— **不冒称空白页**。认不出就是没有（宁可不报，也不猜）。
 */
function mediaListOf(xml: string): string | null {
  const count = (pattern: RegExp): number => xml.match(pattern)?.length ?? 0
  const pictures = count(/<p:pic[\s>]/g)
  const charts = count(/<a:graphicData[^>]*uri="[^"]*\/chart[^"]*"/g)
  const diagrams = count(/<a:graphicData[^>]*uri="[^"]*\/diagram[^"]*"/g)

  const parts: string[] = []
  if (pictures > 0) parts.push(`${pictures} 张图片`)
  if (charts > 0) parts.push(`${charts} 个图表`)
  if (diagrams > 0) parts.push(`${diagrams} 个图示（SmartArt）`)
  return parts.length === 0 ? null : parts.join('、')
}

/** 一页 slide 的正文：标题 + 文字行 + "还有什么没读"（没有文字时就靠这句话，不留白） */
function slideBodyOf(xml: string, slide: PreviewSlide): string {
  const lines: string[] = []
  if (slide.title !== undefined) lines.push(`标题：${slide.title}`)
  lines.push(...slide.lines)

  const media = mediaListOf(xml)
  if (lines.length === 0) {
    return media === null ? '（这页没有抽到文字）' : `（这页没有文字：有 ${media}，内容没有读）`
  }
  if (media !== null) lines.push(`（这页还有 ${media}，内容没有读）`)
  return lines.join('\n')
}

/** `presentation.xml` 里的 `r:id` → 幻灯片部件名（相对 `ppt/` 解析，`..` 也归一） */
function resolveSlideTarget(target: string): string {
  const cleaned = target.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '')
  return posix.normalize(cleaned.startsWith('ppt/') ? cleaned : posix.join('ppt', cleaned))
}

/**
 * 幻灯片按**真实页序**排：`ppt/presentation.xml` 的 `<p:sldIdLst>` 引用关系
 * （`r:id` → `ppt/_rels/presentation.xml.rels` 的 `Target`）才是 PowerPoint 里看到的顺序，
 * 文件名数字序只是**多数情况下的巧合**（复制/删除页之后就不成立了）。
 * 关系读不出（没有这两个部件、解析不出引用）就退回文件名序，并由 `fromRels:false` 让调用方如实标注。
 */
function slideOrderOf(entries: Map<string, Buffer>): { names: string[]; fromRels: boolean } {
  const presentation = entries.get('ppt/presentation.xml')?.toString('utf8')
  const rels = entries.get('ppt/_rels/presentation.xml.rels')?.toString('utf8')
  if (presentation !== undefined && rels !== undefined) {
    const targets = new Map<string, string>()
    for (const tag of rels.match(/<Relationship\b[^>]*\/?>/g) ?? []) {
      const id = /\bId="([^"]+)"/.exec(tag)?.[1]
      const target = /\bTarget="([^"]+)"/.exec(tag)?.[1]
      if (id !== undefined && target !== undefined) targets.set(id, target)
    }
    const names: string[] = []
    for (const tag of presentation.match(/<p:sldId\b[^>]*\/?>/g) ?? []) {
      const id = /\br:id="([^"]+)"/.exec(tag)?.[1]
      if (id === undefined) continue
      const target = targets.get(id)
      if (target === undefined) continue
      const name = resolveSlideTarget(target)
      if (entries.has(name) && !names.includes(name)) names.push(name)
    }
    if (names.length > 0) return { names, fromRels: true }
  }

  const names = [...entries.keys()]
    .filter((name) => SLIDE_ENTRY.test(name))
    .sort((left, right) => slideNumberOf(left) - slideNumberOf(right))
  return { names, fromRels: false }
}

/**
 * PowerPoint（.pptx）→ read 的块：逐页文字提要（版式不还原）+ **页序按 presentation 关系**。
 * 一页只有图片/图表时明说"这页没有文字：有 N 张图片，内容没有读" —— read 不看图片内容，
 * 但也绝不把这种页当成空白页。页数上限、字符预算的截断都写进 `note` / `unread`。
 */
export function extractPptxForRead(bytes: Uint8Array, options: ReadExtractOptions): ReadBlocks {
  let entries: Map<string, Buffer>
  try {
    entries = readZipEntries(bytes)
  } catch (cause) {
    throw new Error(`读不出这个 PPT 文件（文件可能损坏）：${messageOf(cause)}`)
  }

  const { names, fromRels } = slideOrderOf(entries)
  const total = names.length
  const readCount = Math.min(total, SLIDE_LIMIT)
  const blocks: ReadBlock[] = []
  let unread = 0
  let truncated = false
  let budget = options.maxChars

  for (let position = 0; position < readCount; position++) {
    const xml = entries.get(names[position])?.toString('utf8') ?? ''
    const body = slideBodyOf(xml, readSlide(xml, position + 1))
    const title = `第 ${position + 1} 页`
    const cost = title.length + body.length + 4
    if (cost > budget && blocks.length > 0) {
      unread = total - position
      truncated = true
      break
    }
    blocks.push({ title, body })
    budget -= cost
  }
  if (unread === 0 && total > readCount) unread = total - readCount
  if (unread > 0) truncated = true

  const notes: string[] = []
  if (!fromRels)
    notes.push('（这份 PPT 的页序拿不到（presentation 关系读不出），按文件名顺序读的）')
  if (total > readCount) notes.push(`（这份 PPT 共 ${total} 页，一次最多读 ${SLIDE_LIMIT} 页）`)
  return {
    blocks,
    total,
    unread,
    truncated,
    ...(notes.length === 0 ? {} : { note: notes.join('') })
  }
}

/** csv/tsv 文本 → read 的一块（行列封顶、按字符预算在行边界切；截断写清"共多少、读到哪"） */
export function readTableForRead(
  text: string,
  name: string,
  delimiter: string,
  maxChars: number
): { block: ReadBlock; rowCount: number; columnCount: number; truncated: boolean } {
  const parsed = parseTableRows(text, delimiter, SHEET_ROW_LIMIT, SHEET_COLUMN_LIMIT)
  const title = `表格「${name}」（${parsed.rowCount} 行 × ${parsed.columnCount} 列）`

  const lines: string[] = []
  let used = title.length + 4
  let cutByBudget = false
  for (let index = 0; index < parsed.rows.length; index++) {
    const line = `行 ${index + 1}: ${parsed.rows[index].map(cellTextForRead).join(' | ')}`
    if (used + line.length + 1 > maxChars) {
      cutByBudget = true
      break
    }
    lines.push(line)
    used += line.length + 1
  }

  const notes: string[] = []
  if (parsed.truncatedRows) {
    notes.push(`这份表格共 ${parsed.rowCount} 行，只读了前 ${SHEET_ROW_LIMIT} 行`)
  }
  if (parsed.truncatedColumns) {
    notes.push(`这份表格共 ${parsed.columnCount} 列，只读了前 ${SHEET_COLUMN_LIMIT} 列`)
  }
  if (cutByBudget) {
    notes.push(
      lines.length === 0
        ? '这份表格一行都没装下（读出总量有上限）'
        : `这份表格只读到第 ${lines.length} 行（读出总量有上限），后面的行不在这里`
    )
  }
  if (lines.length === 0 && notes.length === 0) notes.push('这份表格里没有可读的内容')

  const tail = notes.map((note) => `\n[${note}]`).join('')
  return {
    block: { title, body: lines.join('\n') + tail },
    rowCount: parsed.rowCount,
    columnCount: parsed.columnCount,
    truncated: parsed.truncatedRows || parsed.truncatedColumns || cutByBudget
  }
}

/** 表里的一格 → 一行里的一格（与 Excel 那套同一口径：换行转义、首尾空白/竖线/引号加引号、不 trim） */
function cellTextForRead(text: string): string {
  if (text === '') return ''
  const escaped = text.replace(/\r\n|\r|\n/g, '\\n')
  return escaped !== escaped.trim() || escaped.includes('|') || escaped.includes('"')
    ? `"${escaped.replace(/"/g, '""')}"`
    : escaped
}
