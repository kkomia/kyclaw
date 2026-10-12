/**
 * create_ppt：把结构化内容写成**带设计系统**的 .pptx 演示文稿（模块 4 格式③；round 62 模板化）。
 *
 * 口径：
 *   - **主题**：内置六套（见 ./ppt-themes，含配色 / 字体 / 强调形状风格）；入参 `theme` 不给就
 *     按（文档标题 + 各页标题）确定性自动挑 —— 同一输入两次同主题。
 *   - **版式**八种：cover / section / content / stats / table / two-column / quote / closing。
 *     每页可用 `layout` 指定；不指定（或指定的版式缺数据）按内容**确定性自动挑**（见 resolveLayout）。
 *   - **统一点缀**：正文类页面标题下一条 accent 短线；除封面外每页页脚「左=文档标题、右=页码」；
 *     封面 / 章节页 / 结尾页按主题 motif 加装饰色块；要点每条一个 accent 圆点。
 *   - **向后兼容**：老的 `title` + `slides[{title,bullets}]` 形状照旧 —— 文档标题出封面、有
 *     title/bullets 的页走 content、末尾自动补一页 closing（自己给了 closing 页就不补）。
 *   - 一页既排不出内容（没有任何版式可挑）也没有显式 layout 时跳过（JSON 里常有多余空对象）；
 *     全都空则补一页占位，免得产出物是"零页演示文稿"（PowerPoint 打不开）。
 *   - 版式固定 **16:9**（LAYOUT_16x9）；所有文本框开 `fit: 'shrink'`（PowerPoint 侧"溢出自动缩小"）。
 *   - 内容与落盘分离：`renderPptx` 是纯入口（幻灯片数据 → 字节 + 实际页数 + 主题名，无 IO）。
 *   - 依赖：pptxgenjs（纯 JS，无原生依赖；Node 侧 `write({outputType:'nodebuffer'})` 直接回 Buffer）。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { assertPackage, checkPackage } from './artifact-check'
import {
  artifactNeedsApproval,
  artifactTarget,
  saveArtifact,
  type ArtifactInput
} from './artifacts'
import { approvalSessionOf, sessionKey, type ToolContext } from './guard'
import { PPT_FONT, PPT_THEME_NAMES, resolveTheme, type PptTheme } from './ppt-themes'

/** 输入上限（round 38 登记"输入规模无上限" + round 62 覆盖新字段）：超限让模型知道怎么改 */
const MAX_SLIDES = 60
const MAX_BULLETS_PER_SLIDE = 30
const MAX_BULLET_CHARS = 500
const MAX_TITLE_CHARS = 200
const MAX_SUBTITLE_CHARS = 120
const MAX_SECTION_CHARS = 80
const MAX_STATS = 6
const MAX_STAT_VALUE_CHARS = 24
const MAX_STAT_LABEL_CHARS = 60
const MAX_TABLE_ROWS = 20
const MAX_TABLE_COLS = 8
const MAX_CELL_CHARS = 200
const MAX_QUOTE_CHARS = 300
const MAX_QUOTE_SOURCE_CHARS = 120
const MAX_COLUMN_BULLETS = 12

/** 八种版式（`layout` 取值；顺序也是文档里介绍的顺序） */
export const PPT_LAYOUTS = [
  'cover',
  'section',
  'content',
  'stats',
  'table',
  'two-column',
  'quote',
  'closing'
] as const

export type PptLayout = (typeof PPT_LAYOUTS)[number]

/** 结尾页没给文字时的兜底（自己给了 closing 页就用那页的 title） */
const DEFAULT_CLOSING = '谢谢观看'

const statSchema = z.object({
  value: z
    .string()
    .min(1)
    .max(MAX_STAT_VALUE_CHARS, `数字卡的数值最长 ${MAX_STAT_VALUE_CHARS} 字，请精简（如 "12%"）`)
    .describe('大号数字（原样显示，如 "12%" / "3.2 亿"；最长 24 字）'),
  label: z
    .string()
    .min(1)
    .max(MAX_STAT_LABEL_CHARS, `数字卡的标签最长 ${MAX_STAT_LABEL_CHARS} 字，请精简`)
    .describe('数字下面的说明文字（最长 60 字）')
})

const tableSchema = z.object({
  headers: z
    .array(z.string().max(MAX_CELL_CHARS, `单元格最长 ${MAX_CELL_CHARS} 字，请精简`))
    .max(MAX_TABLE_COLS, `表格最多 ${MAX_TABLE_COLS} 列，请减少列数`)
    .optional()
    .describe(`表头（可选；给了就按主题色底纹加粗，最多 ${MAX_TABLE_COLS} 列）`),
  rows: z
    .array(
      z
        .array(z.string().max(MAX_CELL_CHARS, `单元格最长 ${MAX_CELL_CHARS} 字，请精简`))
        .max(MAX_TABLE_COLS, `表格最多 ${MAX_TABLE_COLS} 列，请减少列数`)
    )
    .min(1, 'table 版式至少要有一行数据；不要表格请改用 content 版式')
    .max(MAX_TABLE_ROWS, `表格最多 ${MAX_TABLE_ROWS} 行，请拆分页面或只留关键行`)
    .describe(
      `数据行（二维字符串数组，每行一个数组；最多 ${MAX_TABLE_ROWS} 行、${MAX_TABLE_COLS} 列，` +
        `单元格最长 ${MAX_CELL_CHARS} 字；数字也写成字符串）`
    )
})

const quoteSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_QUOTE_CHARS, `引言最长 ${MAX_QUOTE_CHARS} 字，请精简`)
    .describe(`引言正文（大字号展示；最长 ${MAX_QUOTE_CHARS} 字）`),
  source: z
    .string()
    .max(MAX_QUOTE_SOURCE_CHARS, `出处最长 ${MAX_QUOTE_SOURCE_CHARS} 字，请精简`)
    .optional()
    .describe('出处（右下角小字，如 "—— 彼得·德鲁克"；最长 120 字）')
})

const columnSchema = z.object({
  title: z
    .string()
    .max(MAX_TITLE_CHARS, `分栏标题最长 ${MAX_TITLE_CHARS} 字，请精简`)
    .optional()
    .describe('这一栏的小标题（可选）'),
  bullets: z
    .array(z.string().max(MAX_BULLET_CHARS, `单条要点最长 ${MAX_BULLET_CHARS} 字，请精简`))
    .max(MAX_COLUMN_BULLETS, `一栏最多 ${MAX_COLUMN_BULLETS} 条要点，请精简或拆页`)
    .optional()
    .describe(`这一栏的要点（每条一个圆点；最多 ${MAX_COLUMN_BULLETS} 条）`)
})

export const pptInputSchema = z.object({
  title: z
    .string()
    .max(MAX_TITLE_CHARS, `标题最长 ${MAX_TITLE_CHARS} 字，请精简`)
    .optional()
    .describe(
      `演示文稿标题（会单独生成一张封面；不给 path 时也用它派生文件名；最长 ${MAX_TITLE_CHARS} 字）`
    ),
  subtitle: z
    .string()
    .max(MAX_SUBTITLE_CHARS, `副标题最长 ${MAX_SUBTITLE_CHARS} 字，请精简`)
    .optional()
    .describe(`封面副标题（只在封面出现，如日期/单位/一句话说明；最长 ${MAX_SUBTITLE_CHARS} 字）`),
  theme: z
    .enum(PPT_THEME_NAMES)
    .optional()
    .describe(
      `配色主题（决定底色/字色/强调色与装饰块风格）：${PPT_THEME_NAMES.join(' / ')}。` +
        '写方案/汇报用 商务蓝，技术/产品发布用 科技暗，创意/活动用 暖橙 或 紫罗兰，' +
        '克制/学术用 极简黑白 或 墨绿；不填就按标题自动配一套（同一份内容每次都配到同一套）'
    ),
  slides: z
    .array(
      z.object({
        layout: z
          .enum(PPT_LAYOUTS)
          .optional()
          .describe(
            '这一页的版式：cover 封面（大标题+subtitle）/ section 章节页（section 字段，自动带序号）/ ' +
              'content 正文要点（bullets）/ stats 数字卡片（stats）/ table 表格（table）/ ' +
              'two-column 左右分栏（columns 两栏）/ quote 引言（quote）/ closing 结尾页。' +
              '不填就按这一页给了什么数据自动选（见各字段的说明）'
          ),
        title: z
          .string()
          .max(MAX_TITLE_CHARS, `每页标题最长 ${MAX_TITLE_CHARS} 字，请精简`)
          .optional()
          .describe(`这一页的标题（最长 ${MAX_TITLE_CHARS} 字；加了它就会显示标题与主题色短线）`),
        subtitle: z
          .string()
          .max(MAX_SUBTITLE_CHARS, `副标题最长 ${MAX_SUBTITLE_CHARS} 字，请精简`)
          .optional()
          .describe('这一页的副标题（只在 cover 版式用）'),
        bullets: z
          .array(z.string().max(MAX_BULLET_CHARS, `单条要点最长 ${MAX_BULLET_CHARS} 字，请精简`))
          .max(MAX_BULLETS_PER_SLIDE, `一页最多 ${MAX_BULLETS_PER_SLIDE} 条要点，请拆分页面`)
          .optional()
          .describe(
            `正文要点（content / two-column 版式的 bullets 用这个）：每条前面一个主题色圆点，` +
              `最多 ${MAX_BULLETS_PER_SLIDE} 条、每条最长 ${MAX_BULLET_CHARS} 字；要点写短更像成品`
          ),
        section: z
          .string()
          .max(MAX_SECTION_CHARS, `章节名最长 ${MAX_SECTION_CHARS} 字，请精简`)
          .optional()
          .describe(
            `章节名（写了它就是一张 section 章节页：大号序号 + 章节名；序号按章节页出现顺序自动排；` +
              `最长 ${MAX_SECTION_CHARS} 字）`
          ),
        stats: z
          .array(statSchema)
          .max(MAX_STATS, `一页最多 ${MAX_STATS} 张数字卡，请精简或拆页`)
          .optional()
          .describe(
            `KPI 数字卡（写了它就是一张 stats 页）：一眼看的成绩，如 ` +
              `[{ value: "12%", label: "营收同比增长" }, { value: "3.2 亿", label: "全年营收" }]；` +
              `一页 1-${MAX_STATS} 张，卡片横排`
          ),
        table: tableSchema
          .optional()
          .describe('表格（写了它就是一张 table 页）：表头用主题色、数据行隔行浅底'),
        quote: quoteSchema
          .optional()
          .describe('引言（写了它就是一张 quote 页）：大字号引言 + 右下角出处'),
        columns: z
          .array(columnSchema)
          .length(2, 'two-column 版式要正好两栏（columns 给两个元素）')
          .optional()
          .describe(
            '左右分栏（写了它就是一张 two-column 页，必须正好两栏）：做对比、优缺点、"现状/目标"这类内容'
          )
      })
    )
    .min(1)
    .max(MAX_SLIDES, `最多 ${MAX_SLIDES} 页，请拆分演示文稿`)
    .describe(`幻灯片列表（按顺序排在封面之后；最多 ${MAX_SLIDES} 页）`),
  path: z.string().optional().describe('落盘路径（相对当前会话工作区；不给就按标题派生文件名）')
})

export type PptInput = z.infer<typeof pptInputSchema>

export interface PptStat {
  value: string
  label: string
}

export interface PptColumn {
  title?: string
  bullets?: readonly string[]
}

export interface PptTable {
  headers?: readonly string[]
  rows: readonly (readonly string[])[]
}

export interface PptQuote {
  text: string
  source?: string
}

export interface PptSlideInput {
  layout?: PptLayout
  title?: string
  subtitle?: string
  bullets?: readonly string[]
  section?: string
  stats?: readonly PptStat[]
  table?: PptTable
  quote?: PptQuote
  columns?: readonly PptColumn[]
}

export interface PptxInput {
  title?: string
  subtitle?: string
  theme?: string
  slides: readonly PptSlideInput[]
}

/** 渲染结果：字节 + **实际写入的页数** + 主题名（自检与调用方共用这一处口径） */
export interface PptxResult {
  data: Buffer
  slides: number
  theme: string
}

/** 16:9 画布（英寸）：pptxgenjs 的 LAYOUT_16x9 = 10 × 5.625 */
const CANVAS = { w: 10, h: 5.625 } as const

/** 正文类页面的栅格（英寸）：标题 → 强调短线 → 内容 → 页脚 */
const FRAME = {
  x: 0.6,
  w: 8.8,
  titleY: 0.4,
  titleH: 0.72,
  ruleY: 1.18,
  ruleW: 1.0,
  ruleH: 0.06,
  bodyY: 1.5,
  hairlineY: 5.02,
  footerY: 5.08,
  footerH: 0.3
} as const

/** 动态 import 的 pptxgenjs 实例 / Slide / 文本 run / 表格 类型（从默认导出推，不依赖它的 UMD 命名空间） */
type PptxModule = typeof import('pptxgenjs')
type PptxInstance = InstanceType<PptxModule['default']>
type PptxSlide = ReturnType<PptxInstance['addSlide']>
type PptxTextRun = Extract<Parameters<PptxSlide['addText']>[0], readonly unknown[]>[number]
type PptxTextOptions = NonNullable<Parameters<PptxSlide['addText']>[1]>
type PptxTableRows = Parameters<PptxSlide['addTable']>[0]
type PptxTableCell = PptxTableRows[number][number]

/**
 * 渲染演示文稿（纯入口：没有 IO，测试拿返回值解包断言）。
 * 页数 = 封面（有文档标题时）+ 每张排得出版式的页 + 自动结尾页（有封面且没给 closing 时）。
 */
export async function renderPptx(input: PptxInput): Promise<PptxResult> {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'

  const theme = resolveTheme(input)
  const plan = planPages(input)
  const footerLeft = input.title?.trim() ?? ''

  let slides = 0
  if (plan.length === 0) {
    // 内容全空也要产出一页：零页演示文稿 PowerPoint 打不开
    const slide = pptx.addSlide()
    slides += 1
    drawPlaceholder({ pptx, slide, theme, pageNumber: 1, footerLeft })
  } else {
    plan.forEach((page, index) => {
      const slide = pptx.addSlide()
      slides += 1
      drawPage({ pptx, slide, theme, pageNumber: index + 1, footerLeft }, page)
    })
  }

  const data = await pptx.write({ outputType: 'nodebuffer' })
  return {
    data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer),
    slides,
    theme: theme.name
  }
}

export async function createPptTool(ctx: ToolContext): Promise<Tool<PptInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  const planInput = (input: PptInput): ArtifactInput => ({
    title: input.title ?? input.slides[0]?.title,
    path: input.path
  })

  return createTool({
    id: 'create_ppt',
    description:
      '生成 .pptx 演示文稿（模板化：内置主题 + 八种版式 + 统一的标题短线与页脚），' +
      '落到当前会话工作区并返回文件路径与字节数。' +
      `theme 指定配色主题（${PPT_THEME_NAMES.join(' / ')}），不填就按标题自动配一套（同一份内容每次都同一套）。` +
      'slides 每项一页，可用 layout 指定版式（cover 封面 / section 章节 / content 正文要点 / ' +
      'stats 数字卡片 / table 表格 / two-column 左右分栏 / quote 引言 / closing 结尾），' +
      '不指定就按这一页给的数据自动选：给 stats 出 KPI 卡、给 table 出表格、给 quote 出引言、' +
      '给 columns 出分栏、给 bullets 出要点页。' +
      '文档 title 会另出一张封面，并在末尾自动补一页结尾页（自己给了 closing 页就不补）。' +
      `上限：一页最多 30 条要点、${MAX_STATS} 张数字卡、表格 ${MAX_TABLE_ROWS} 行 ${MAX_TABLE_COLS} 列，超出请拆分页面。` +
      '要点要写短（文本框开了"溢出自动缩小"，但短句才像成品）。适合汇报、提案、讲解稿；' +
      '要打印成文档用 create_pdf / create_docx，要数据表用 create_excel。执行前会请求用户批准。',
    inputSchema: pptInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      artifactNeedsApproval(
        ctx,
        'create_ppt',
        planInput(input),
        'pptx',
        '演示文稿',
        approvalSessionOf(approval)
      ),
    execute: async (input, context) => {
      const session = sessionKey(context)
      const abs = artifactTarget(ctx, planInput(input), 'pptx', '演示文稿', session)
      const rendered = await renderPptx(input)

      // 产出后结构自检：包都读不通（fatal）就不落盘；某项不过照写但回执注明
      const check = checkPackage(rendered.data, {
        kind: 'pptx',
        slides: rendered.slides,
        texts: sampleText(input)
      })
      assertPackage(check)

      return await saveArtifact(ctx, abs, rendered.data, `${input.slides.length} 页演示文稿`, {
        session,
        check: check.note
      })
    }
  })
}

/** 自检的样本文本：封面标题优先，否则第一页第一个非空文本（取不到就给空数组，该检查项不出现） */
function sampleText(input: PptInput): string[] {
  const cover = input.title?.trim() ?? ''
  if (cover !== '') return [cover]

  for (const slide of input.slides) {
    const title = slide.title?.trim() ?? ''
    if (title !== '') return [title]
    const bullet = (slide.bullets ?? []).find((text) => text.trim() !== '')
    if (bullet !== undefined) return [bullet]
  }
  return []
}

interface PlannedPage {
  layout: PptLayout
  slide: PptSlideInput
  /** 章节页的序号（1 起，按章节页出现顺序；非章节页为 0） */
  sectionIndex: number
}

interface PageContext {
  pptx: PptxInstance
  slide: PptxSlide
  theme: PptTheme
  /** 这一页在文档里的物理序号（1 起；封面是 1，但它不画页脚） */
  pageNumber: number
  /** 页脚左侧的文档标题（没有标题的文档为空，那一格就不画） */
  footerLeft: string
}

/**
 * 先把"要出哪几页"排定，再逐页画 —— 页码要知道总页数之前就定下来，不能边画边数。
 * 自动结尾页只补在"有封面且没有显式 closing 页"的文档里（显式页永远优先，不重复出）。
 */
function planPages(input: PptxInput): PlannedPage[] {
  const pages: PlannedPage[] = []
  const coverTitle = input.title?.trim() ?? ''
  if (coverTitle !== '') {
    pages.push({
      layout: 'cover',
      slide: { title: coverTitle, subtitle: trimText(input.subtitle) },
      sectionIndex: 0
    })
  }

  let sections = 0
  for (const slide of input.slides) {
    const layout = resolveLayout(slide)
    if (layout === null) continue
    if (layout === 'section') sections += 1
    pages.push({ layout, slide, sectionIndex: layout === 'section' ? sections : 0 })
  }

  if (coverTitle !== '' && !pages.some((page) => page.layout === 'closing')) {
    pages.push({ layout: 'closing', slide: {}, sectionIndex: 0 })
  }
  return pages
}

/**
 * 这一页用哪个版式：
 *   - 显式 `layout` 且这一页的数据撑得起来 → 用它；
 *   - 显式 `layout` 但缺数据 → 退到自动挑（宁可换个版式，也不出一张半空的页）；
 *   - 没给 `layout` → 按内容自动挑；什么都挑不出来 → null（跳过这页）。
 * 自动挑选顺序固定（stats → quote → table → two-column → section → content），故同一输入两次同版式。
 */
export function resolveLayout(slide: PptSlideInput): PptLayout | null {
  const requested = slide.layout
  if (requested !== undefined && layoutReady(requested, slide)) return requested
  return autoLayout(slide)
}

function autoLayout(slide: PptSlideInput): PptLayout | null {
  if ((slide.stats ?? []).length > 0) return 'stats'
  if (trimText(slide.quote?.text) !== undefined) return 'quote'
  if ((slide.table?.rows ?? []).length > 0) return 'table'
  if ((slide.columns ?? []).length === 2) return 'two-column'
  if (trimText(slide.section) !== undefined) return 'section'
  if (trimText(slide.title) !== undefined || cleanBullets(slide.bullets).length > 0)
    return 'content'
  return null
}

/** 显式指定的版式能不能排出来（缺数据就不硬排） */
function layoutReady(layout: PptLayout, slide: PptSlideInput): boolean {
  switch (layout) {
    case 'cover':
      return trimText(slide.title) !== undefined
    case 'section':
      return trimText(slide.section) !== undefined
    case 'content':
      return trimText(slide.title) !== undefined || cleanBullets(slide.bullets).length > 0
    case 'stats':
      return (slide.stats ?? []).length > 0
    case 'table':
      return (slide.table?.rows ?? []).length > 0
    case 'two-column':
      return (slide.columns ?? []).length === 2
    case 'quote':
      return trimText(slide.quote?.text) !== undefined
    case 'closing':
      return true
  }
}

function drawPage(ctx: PageContext, page: PlannedPage): void {
  switch (page.layout) {
    case 'cover':
      drawCover(ctx, page)
      return
    case 'section':
      drawSection(ctx, page)
      return
    case 'stats':
      drawStats(ctx, page)
      return
    case 'table':
      drawTable(ctx, page)
      return
    case 'two-column':
      drawTwoColumn(ctx, page)
      return
    case 'quote':
      drawQuote(ctx, page)
      return
    case 'closing':
      drawClosing(ctx, page)
      return
    case 'content':
      drawContent(ctx, page)
  }
}

/** 封面：大标题 + 副标题 + 主题色短线 + 主题装饰块（不出页脚，页码从第 2 页起） */
function drawCover(ctx: PageContext, page: PlannedPage): void {
  paintCanvas(ctx.slide, ctx.theme)
  addMotif(ctx)
  addBox(ctx.slide, trimText(page.slide.title) ?? '', {
    x: 0.8,
    y: 1.8,
    w: 8.4,
    h: 1.35,
    fontSize: 40,
    bold: true,
    color: ctx.theme.title,
    align: 'center',
    valign: 'middle'
  })
  addTitleRule(ctx, 4.5, 3.32)
  const subtitle = trimText(page.slide.subtitle)
  if (subtitle !== undefined) {
    addBox(ctx.slide, subtitle, {
      x: 0.8,
      y: 3.55,
      w: 8.4,
      h: 0.6,
      fontSize: 18,
      color: ctx.theme.muted,
      align: 'center',
      valign: 'middle'
    })
  }
}

/** 章节页：大号序号 + 章节名（序号自动排；给了 title 就当上方的小标签） */
function drawSection(ctx: PageContext, page: PlannedPage): void {
  paintCanvas(ctx.slide, ctx.theme)
  addMotif(ctx)
  const kicker = trimText(page.slide.title)
  if (kicker !== undefined) {
    addBox(ctx.slide, kicker, {
      x: 0.75,
      y: 0.72,
      w: 8.4,
      h: 0.4,
      fontSize: 13,
      color: ctx.theme.muted,
      valign: 'middle'
    })
  }
  addBox(ctx.slide, String(page.sectionIndex), {
    x: 0.72,
    y: 1.15,
    w: 2.2,
    h: 1.3,
    fontSize: 64,
    bold: true,
    color: ctx.theme.accent,
    valign: 'middle'
  })
  addBox(ctx.slide, trimText(page.slide.section) ?? '', {
    x: 0.75,
    y: 2.5,
    w: 8.4,
    h: 0.85,
    fontSize: 32,
    bold: true,
    color: ctx.theme.title,
    valign: 'middle'
  })
  addTitleRule(ctx, 0.78, 3.55, 1.2)
  addFooter(ctx)
}

/** 正文要点页：标题 + 短线 + 逐条要点（每条一个主题色圆点） */
function drawContent(ctx: PageContext, page: PlannedPage): void {
  paintCanvas(ctx.slide, ctx.theme)
  const title = trimText(page.slide.title)
  if (title !== undefined) addTitleBlock(ctx, title)

  const bullets = cleanBullets(page.slide.bullets)
  if (bullets.length > 0) {
    addBullets(ctx, bullets, {
      x: FRAME.x,
      y: title === undefined ? 1.25 : FRAME.bodyY,
      w: FRAME.w,
      h: title === undefined ? 3.6 : 3.35,
      fontSize: 15
    })
  }
  addFooter(ctx)
}

/** KPI 数字卡页：一行卡片，每张 = 浅底圆角卡 + 主题色顶条 + 大数字 + 标签 */
function drawStats(ctx: PageContext, page: PlannedPage): void {
  paintCanvas(ctx.slide, ctx.theme)
  const title = trimText(page.slide.title)
  if (title !== undefined) addTitleBlock(ctx, title)

  const stats = (page.slide.stats ?? []).filter((stat) => stat.value.trim() !== '')
  if (stats.length === 0) {
    addFooter(ctx)
    return
  }

  const top = title === undefined ? 1.3 : 1.85
  const gap = 0.25
  const cardW = (FRAME.w - gap * (stats.length - 1)) / stats.length
  const cardH = 2.2

  stats.forEach((stat, index) => {
    const x = FRAME.x + index * (cardW + gap)
    ctx.slide.addShape(ctx.pptx.ShapeType.roundRect, {
      x,
      y: top,
      w: cardW,
      h: cardH,
      fill: { color: ctx.theme.canvas },
      line: { color: ctx.theme.muted, width: 0.75 },
      rectRadius: 0.08
    })
    ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
      x,
      y: top,
      w: cardW,
      h: 0.07,
      fill: { color: ctx.theme.accent }
    })
    addBox(ctx.slide, stat.value.trim(), {
      x,
      y: top + 0.3,
      w: cardW,
      h: 1.0,
      fontSize: 30,
      bold: true,
      color: ctx.theme.accent,
      align: 'center',
      valign: 'middle'
    })
    addBox(ctx.slide, stat.label.trim(), {
      x: x + 0.08,
      y: top + 1.4,
      w: cardW - 0.16,
      h: 0.7,
      fontSize: 12,
      color: ctx.theme.body,
      align: 'center',
      valign: 'top'
    })
  })
  addFooter(ctx)
}

/** 表格页：主题色表头 + 数据行隔行浅底 + 主题色描边 */
function drawTable(ctx: PageContext, page: PlannedPage): void {
  paintCanvas(ctx.slide, ctx.theme)
  const title = trimText(page.slide.title)
  if (title !== undefined) addTitleBlock(ctx, title)

  const headers = (page.slide.table?.headers ?? []).map((text) => text.trim())
  const rows = (page.slide.table?.rows ?? []).map((row) => row.map((cell) => cell.trim()))
  const cols = Math.max(headers.length, ...rows.map((row) => row.length), 1)

  const body: PptxTableRows = []
  if (headers.length > 0) {
    body.push(
      headers.map((text): PptxTableCell => ({
        text,
        options: {
          fill: { color: ctx.theme.accent },
          color: ctx.theme.onAccent,
          bold: true
        }
      }))
    )
  }
  rows.forEach((row, index) => {
    body.push(
      Array.from({ length: cols }, (_, col): PptxTableCell => ({
        text: row[col] ?? '',
        options: {
          fill: { color: index % 2 === 0 ? ctx.theme.canvas : ctx.theme.bg },
          color: ctx.theme.body
        }
      }))
    )
  })

  ctx.slide.addTable(body, {
    x: FRAME.x,
    y: title === undefined ? 1.3 : 1.7,
    w: FRAME.w,
    colW: Array.from({ length: cols }, () => FRAME.w / cols),
    rowH: 0.4,
    fontSize: 12,
    fontFace: PPT_FONT,
    color: ctx.theme.body,
    valign: 'middle',
    border: { type: 'solid', color: ctx.theme.canvas, pt: 0.5 }
  })
  addFooter(ctx)
}

/** 左右分栏：两栏浅底卡（左缘一道主题色竖条）+ 小标题 + 要点 */
function drawTwoColumn(ctx: PageContext, page: PlannedPage): void {
  paintCanvas(ctx.slide, ctx.theme)
  const title = trimText(page.slide.title)
  if (title !== undefined) addTitleBlock(ctx, title)

  const top = title === undefined ? 1.3 : 1.7
  const height = title === undefined ? 3.4 : 3.05
  const gap = 0.5
  const colW = (FRAME.w - gap) / 2
  const columns = (page.slide.columns ?? []).slice(0, 2)

  columns.forEach((column, index) => {
    const x = FRAME.x + index * (colW + gap)
    ctx.slide.addShape(ctx.pptx.ShapeType.roundRect, {
      x,
      y: top,
      w: colW,
      h: height,
      fill: { color: ctx.theme.canvas },
      rectRadius: 0.06
    })
    ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
      x,
      y: top,
      w: 0.07,
      h: height,
      fill: { color: ctx.theme.accent }
    })

    const heading = trimText(column.title)
    if (heading !== undefined) {
      addBox(ctx.slide, heading, {
        x: x + 0.25,
        y: top + 0.15,
        w: colW - 0.45,
        h: 0.5,
        fontSize: 15,
        bold: true,
        color: ctx.theme.accent,
        valign: 'middle'
      })
    }

    const bullets = cleanBullets(column.bullets)
    if (bullets.length > 0) {
      addBullets(ctx, bullets, {
        x: x + 0.25,
        y: heading === undefined ? top + 0.2 : top + 0.75,
        w: colW - 0.45,
        h: height - (heading === undefined ? 0.35 : 0.9),
        fontSize: 13
      })
    }
  })
  addFooter(ctx)
}

/** 引言页：大字号引言 + 左侧主题色竖条 + 右下角出处（写了 title 就上面加标题块，否则加一个大引号） */
function drawQuote(ctx: PageContext, page: PlannedPage): void {
  paintCanvas(ctx.slide, ctx.theme)
  const title = trimText(page.slide.title)
  if (title !== undefined) {
    addTitleBlock(ctx, title)
  } else {
    addBox(ctx.slide, '“', {
      x: 0.5,
      y: 0.5,
      w: 1.5,
      h: 1.2,
      fontSize: 66,
      bold: true,
      color: ctx.theme.accent,
      valign: 'middle'
    })
  }

  const top = title === undefined ? 1.5 : 1.8
  ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
    x: FRAME.x,
    y: top,
    w: 0.08,
    h: 1.9,
    fill: { color: ctx.theme.accent }
  })
  addBox(ctx.slide, trimText(page.slide.quote?.text) ?? '', {
    x: 1.15,
    y: top,
    w: 7.7,
    h: 1.9,
    fontSize: 24,
    color: ctx.theme.title,
    lineSpacingMultiple: 1.25,
    valign: 'middle'
  })

  const source = trimText(page.slide.quote?.source)
  if (source !== undefined) {
    addBox(ctx.slide, `—— ${source}`, {
      x: 1.15,
      y: top + 2.0,
      w: 7.7,
      h: 0.4,
      fontSize: 13,
      color: ctx.theme.muted,
      align: 'right',
      valign: 'middle'
    })
  }
  addFooter(ctx)
}

/** 结尾页：一句话 + 短线 + 装饰块（文字默认"谢谢观看"，自己给了 title 就用它） */
function drawClosing(ctx: PageContext, page: PlannedPage): void {
  paintCanvas(ctx.slide, ctx.theme)
  addMotif(ctx)
  addBox(ctx.slide, trimText(page.slide.title) ?? DEFAULT_CLOSING, {
    x: 1.2,
    y: 2.25,
    w: 7.6,
    h: 1.0,
    fontSize: 36,
    bold: true,
    color: ctx.theme.title,
    align: 'center',
    valign: 'middle'
  })
  addTitleRule(ctx, 4.5, 3.42)
  addFooter(ctx)
}

/** 内容全空时的占位页（不能是零页演示文稿） */
function drawPlaceholder(ctx: PageContext): void {
  paintCanvas(ctx.slide, ctx.theme)
  addMotif(ctx)
  addBox(ctx.slide, '（这份演示文稿没有内容）', {
    x: 0.6,
    y: 2.4,
    w: 8.8,
    h: 0.8,
    fontSize: 18,
    align: 'center',
    color: ctx.theme.body,
    valign: 'middle'
  })
}

/** 底色：每页都铺主题 bg（深色主题靠它，浅色主题也统一口径） */
function paintCanvas(slide: PptxSlide, theme: PptTheme): void {
  slide.background = { color: theme.bg }
}

/** 文本框统一口径：字体「微软雅黑」+ 溢出自动缩小（round 38 的防溢出口径，新页一律沿用） */
function addBox(slide: PptxSlide, text: string | PptxTextRun[], options: PptxTextOptions): void {
  slide.addText(text, { fontFace: PPT_FONT, fit: 'shrink', ...options })
}

/** 正文类页面的标题块：标题 + 标题下的主题色短线（统一点缀系统的核心记号） */
function addTitleBlock(ctx: PageContext, title: string): void {
  addBox(ctx.slide, title, {
    x: FRAME.x,
    y: FRAME.titleY,
    w: FRAME.w,
    h: FRAME.titleH,
    fontSize: 26,
    bold: true,
    color: ctx.theme.title,
    valign: 'middle'
  })
  addTitleRule(ctx)
}

/** 标题下的一条 accent 短线 */
function addTitleRule(
  ctx: PageContext,
  x: number = FRAME.x,
  y: number = FRAME.ruleY,
  w: number = FRAME.ruleW
): void {
  ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
    x,
    y,
    w,
    h: FRAME.ruleH,
    fill: { color: ctx.theme.accent }
  })
}

/** 页脚：细线 + 左「文档标题」右「页码」（封面不出页脚，故正文从 2 起） */
function addFooter(ctx: PageContext): void {
  ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
    x: FRAME.x,
    y: FRAME.hairlineY,
    w: FRAME.w,
    h: 0.012,
    fill: { color: ctx.theme.muted }
  })
  if (ctx.footerLeft !== '') {
    addBox(ctx.slide, ctx.footerLeft, {
      x: FRAME.x,
      y: FRAME.footerY,
      w: FRAME.w / 2,
      h: FRAME.footerH,
      fontSize: 9,
      color: ctx.theme.muted,
      align: 'left',
      valign: 'middle'
    })
  }
  addBox(ctx.slide, String(ctx.pageNumber), {
    x: FRAME.x + FRAME.w / 2,
    y: FRAME.footerY,
    w: FRAME.w / 2,
    h: FRAME.footerH,
    fontSize: 9,
    color: ctx.theme.muted,
    align: 'right',
    valign: 'middle'
  })
}

/** 要点列表：每条一个主题色圆点（● 是独立 run，圆点颜色才跟得上主题）+ 1.25 倍行距、段后 10pt */
function addBullets(
  ctx: PageContext,
  bullets: readonly string[],
  area: { x: number; y: number; w: number; h: number; fontSize: number }
): void {
  const runs: PptxTextRun[] = []
  bullets.forEach((text, index) => {
    runs.push({
      text: '●',
      options: {
        color: ctx.theme.accent,
        fontSize: Math.max(8, Math.round(area.fontSize * 0.7)),
        bold: true
      }
    })
    runs.push({
      text: ` ${text}`,
      options: { color: ctx.theme.body, breakLine: index < bullets.length - 1 }
    })
  })

  addBox(ctx.slide, runs, {
    x: area.x,
    y: area.y,
    w: area.w,
    h: area.h,
    fontSize: area.fontSize,
    color: ctx.theme.body,
    lineSpacingMultiple: 1.25,
    paraSpaceAfter: 10,
    valign: 'top'
  })
}

/**
 * 封面 / 章节页 / 结尾页的装饰色块（形状风格跟主题走，同一主题三处一致）。
 * 三套形状都**避开页脚区**（y ≥ 4.9 的横带只留给页脚细线与页码）：章节页/结尾页也带页脚，
 * 装饰压在页脚上会让 muted 字色贴在强调色底上（对比度不够）。
 */
function addMotif(ctx: PageContext): void {
  const { pptx, slide, theme } = ctx
  if (theme.motif === 'bar') {
    // 左侧通栏竖条 + 左上横块（L 形）
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: 0.22,
      h: CANVAS.h,
      fill: { color: theme.accent }
    })
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.22,
      y: 0,
      w: 1.5,
      h: 0.22,
      fill: { color: theme.accent }
    })
    return
  }
  if (theme.motif === 'block') {
    // 顶部通栏色带 + 右下角方块
    slide.addShape(pptx.ShapeType.rect, {
      x: 0,
      y: 0,
      w: CANVAS.w,
      h: 0.35,
      fill: { color: theme.accent }
    })
    slide.addShape(pptx.ShapeType.rect, {
      x: CANVAS.w - 1,
      y: 4.35,
      w: 0.6,
      h: 0.6,
      fill: { color: theme.accent }
    })
    return
  }
  // corner：右上横块 + 右下横块
  slide.addShape(pptx.ShapeType.rect, {
    x: CANVAS.w - 2.6,
    y: 0,
    w: 2.6,
    h: 0.3,
    fill: { color: theme.accent }
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: CANVAS.w - 1.6,
    y: CANVAS.h - 0.225,
    w: 1.6,
    h: 0.225,
    fill: { color: theme.accent }
  })
}

/** 去掉空白的要点（模型偶尔给空串） */
function cleanBullets(bullets: readonly string[] | undefined): string[] {
  return (bullets ?? []).map((text) => text.trim()).filter((text) => text !== '')
}

/** 去空白；全空给 undefined（用于"这一页有没有这个字段"的判定） */
function trimText(value: string | undefined): string | undefined {
  const text = value?.trim() ?? ''
  return text === '' ? undefined : text
}
