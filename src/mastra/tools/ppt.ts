/**
 * create_ppt：把结构化内容写成**带设计系统**的 .pptx 演示文稿（模块 4 格式③；round 62 模板化）。
 *
 * 口径：
 *   - **新做一份**：改一份已有的演示文稿请用 `edit_ppt`（只发改动，见 tools/ppt-edit.ts）——
 *     两者共用 `renderPptx` 与 `checkPackage`，没有第二套渲染/自检实现。
 *   - round 76：落盘成功后把这份 deck 的**源结构 + 文件指纹**记进会话级映射
 *     （`session_ppt_sources`，装配时经 options.sources 注入）；记不上不影响这次产出。
 *   - **模板**：十套（配色 / 字体 / 封面构图 / 强调形状风格，数据在 shared/ppt-templates.ts）。
 *     用哪一套（round 66）：显式 `theme` > **本会话**在对话页固定的模板（会话级映射，按 threadId
 *     现读）> 按（文档标题 + 各页标题）确定性自动挑 —— 同一输入两次同主题（见 resolveTheme）。
 *   - **版式**八种：cover / section / content / stats / table / two-column / quote / closing。
 *     每页可用 `layout` 指定；不指定（或指定的版式缺数据）按内容**确定性自动挑**（见 resolveLayout）。
 *   - **统一点缀**：正文类页面标题下一条 accent 短线；除封面外每页页脚「左=文档标题、右=页码」；
 *     封面按模板构图加装饰（居中 = 该模板 motif 的色块；band = 左侧通栏色带 + 左对齐标题），
 *     章节页 / 结尾页按模板 motif 加装饰色块；要点每条一个 accent 圆点。
 *   - **向后兼容**：老的 `title` + `slides[{title,bullets}]` 形状照旧 —— 文档标题出封面、有
 *     title/bullets 的页走 content。**结尾页以模型给的为准**：不再自动补一页只写「谢谢观看」的
 *     占位页 —— 那是无信息页，技能里明令禁止，工具层不该反过来批量生产它。没给就没有。
 *   - 一页既排不出内容（没有任何版式可挑）也没有显式 layout 时跳过（JSON 里常有多余空对象）；
 *     全都空则补一页占位，免得产出物是"零页演示文稿"（PowerPoint 打不开）。
 *   - 版式固定 **16:9**（LAYOUT_16x9）；所有文本框开 `fit: 'shrink'`（PowerPoint 侧"溢出自动缩小"）。
 *   - **断言**（`expect`）：用户说"必须 6 页""第 3 页必须有这句话"时写进来。落盘前真解包逐条核
 *     （页数按包内 slide 部件数；文本只看那一页的 slide 部件，图表文字与演讲者备注不算），
 *     没过**不拦落盘**，但回执会点名"哪一条没过、差在哪"，改不改由模型决定。
 *   - 内容与落盘分离：`renderPptx` 是纯入口（幻灯片数据 → 字节 + 实际页数 + 主题名，无 IO）。
 *   - 依赖：pptxgenjs（纯 JS，无原生依赖；Node 侧 `write({outputType:'nodebuffer'})` 直接回 Buffer）。
 */
import type { Tool } from '@mastra/core/tools'
import { coverPlan, motifBoxes, type PptBox } from '../../shared/ppt-templates'
import { z } from '../../shared/zod'
import { sha256Of, type SessionPptSourceStore } from '../session-ppt-sources'
import { assertPackage, checkPackage } from './artifact-check'
import {
  artifactNeedsApproval,
  artifactTarget,
  saveArtifact,
  type ArtifactInput
} from './artifacts'
import { approvalSessionOf, sessionKey, type ToolContext } from './guard'
import { PPT_FONT, PPT_TEMPLATE_NAMES, resolveTheme, type PptTheme } from './ppt-themes'

/** 输入上限（round 38 登记"输入规模无上限" + round 62 覆盖新字段）：超限让模型知道怎么改 */
export const MAX_SLIDES = 60
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
/** 断言条数上限：回执里要逐条报，太多会把上下文吃光 */
const MAX_EXPECTS = 20

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

const statSchema = z.object({
  value: z
    .string()
    .min(1)
    .max(MAX_STAT_VALUE_CHARS, `数字卡的数值最长 ${MAX_STAT_VALUE_CHARS} 字，请精简（如 "12%"）`)
    .describe('Large figure, shown verbatim, for example "12%" or "3.2 亿"'),
  label: z
    .string()
    .min(1)
    .max(MAX_STAT_LABEL_CHARS, `数字卡的标签最长 ${MAX_STAT_LABEL_CHARS} 字，请精简`)
    .describe('Caption under the figure')
})

const tableSchema = z.object({
  headers: z
    .array(z.string().max(MAX_CELL_CHARS, `单元格最长 ${MAX_CELL_CHARS} 字，请精简`))
    .max(MAX_TABLE_COLS, `表格最多 ${MAX_TABLE_COLS} 列，请减少列数`)
    .optional()
    .describe('Header row; when given it is bold on a theme-coloured fill'),
  rows: z
    .array(
      z
        .array(z.string().max(MAX_CELL_CHARS, `单元格最长 ${MAX_CELL_CHARS} 字，请精简`))
        .max(MAX_TABLE_COLS, `表格最多 ${MAX_TABLE_COLS} 列，请减少列数`)
    )
    .min(1, 'table 版式至少要有一行数据；不要表格请改用 content 版式')
    .max(MAX_TABLE_ROWS, `表格最多 ${MAX_TABLE_ROWS} 行，请拆分页面或只留关键行`)
    .describe(
      'Data rows, a two-dimensional string array with one array per row; numbers are written as strings too'
    )
})

const quoteSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_QUOTE_CHARS, `引言最长 ${MAX_QUOTE_CHARS} 字，请精简`)
    .describe('Quote body, shown in large type'),
  source: z
    .string()
    .max(MAX_QUOTE_SOURCE_CHARS, `出处最长 ${MAX_QUOTE_SOURCE_CHARS} 字，请精简`)
    .optional()
    .describe('Source, small text in the bottom right, for example "—— 彼得·德鲁克"')
})

const columnSchema = z.object({
  title: z
    .string()
    .max(MAX_TITLE_CHARS, `分栏标题最长 ${MAX_TITLE_CHARS} 字，请精简`)
    .optional()
    .describe('Small heading for this column (optional)'),
  bullets: z
    .array(z.string().max(MAX_BULLET_CHARS, `单条要点最长 ${MAX_BULLET_CHARS} 字，请精简`))
    .max(MAX_COLUMN_BULLETS, `一栏最多 ${MAX_COLUMN_BULLETS} 条要点，请精简或拆页`)
    .optional()
    .describe('Bullet points in this column, one dot each')
})

/**
 * 一页（`slides` 的元素）：create_ppt 与 edit_ppt 的 replace / insert **共用这一份**。
 * 分开写两份的下场是字段说明漂移 —— 而模型看到的是描述，漂了就等于两个工具教它两套填法。
 */
export const pptSlideSchema = z.object({
  layout: z
    .enum(PPT_LAYOUTS)
    .optional()
    .describe(
      'Layout for this slide: cover / section / content for bullet points / stats for number cards / ' +
        'table / two-column / quote / closing. When omitted it is picked from the data given for this slide'
    ),
  title: z
    .string()
    .max(MAX_TITLE_CHARS, `每页标题最长 ${MAX_TITLE_CHARS} 字，请精简`)
    .optional()
    .describe('Slide title; adding it shows the title with a theme-coloured rule under it'),
  subtitle: z
    .string()
    .max(MAX_SUBTITLE_CHARS, `副标题最长 ${MAX_SUBTITLE_CHARS} 字，请精简`)
    .optional()
    .describe('Slide subtitle, used by the cover layout only'),
  bullets: z
    .array(z.string().max(MAX_BULLET_CHARS, `单条要点最长 ${MAX_BULLET_CHARS} 字，请精简`))
    .max(MAX_BULLETS_PER_SLIDE, `一页最多 ${MAX_BULLETS_PER_SLIDE} 条要点，请拆分页面`)
    .optional()
    .describe('Body bullet points, each with a theme-coloured dot; shorter reads better'),
  section: z
    .string()
    .max(MAX_SECTION_CHARS, `章节名最长 ${MAX_SECTION_CHARS} 字，请精简`)
    .optional()
    .describe('Section name; setting it makes a section slide with a large auto-numbered index'),
  stats: z
    .array(statSchema)
    .max(MAX_STATS, `一页最多 ${MAX_STATS} 张数字卡，请精简或拆页`)
    .optional()
    .describe('KPI number cards, which make a stats slide with the cards side by side'),
  table: tableSchema
    .optional()
    .describe('Table, which makes a table slide with a themed header row and banded data rows'),
  quote: quoteSchema
    .optional()
    .describe(
      'Quote, which makes a quote slide with large type and the source at the bottom right'
    ),
  columns: z
    .array(columnSchema)
    .length(2, 'two-column 版式要正好两栏（columns 给两个元素）')
    .optional()
    .describe(
      'Two columns, which make a two-column slide and must be exactly two: for comparisons or before/after'
    )
})

export type PptSlide = z.infer<typeof pptSlideSchema>

/** 页数上下限单独拎出来：edit_ppt 在插入/替换后也要按同一把尺子量一次 */
export const pptSlidesSchema = z
  .array(pptSlideSchema)
  .min(1)
  .max(MAX_SLIDES, `最多 ${MAX_SLIDES} 页，请拆分演示文稿`)

/** 硬要求（用户说"必须 6 页""第 3 页必须有这句话"）：create_ppt 与 edit_ppt 共用 */
export const pptExpectSchema = z
  .object({
    pages: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Page count the user asked for, counted as PowerPoint would count it, including the cover and any closing slide you add'
      ),
    contains: z
      .array(
        z.object({
          page: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Page number, 1-based and including the cover, matching PowerPoint page order; when omitted any page may contain the text'
            ),
          text: z
            .string()
            .min(1)
            .describe('Text that must appear verbatim on that page, as one contiguous run')
        })
      )
      .max(MAX_EXPECTS, `最多 ${MAX_EXPECTS} 条断言，请精选`)
      .optional()
      .describe(
        'Text the user named as required, checked per page; chart text and speaker notes do not count'
      )
  })
  .describe(
    'Hard requirements the user stated, such as an exact page count or text on a given page; each one is checked and misses are reported in the result'
  )

/**
 * round 67：字段说明**只留"这是什么 + 关键边界"**，字数与版式细节由 pptx 技能手册承载
 * （指令里已写明"动手前先 use_skill 读 pptx 那份"）。
 * 为什么非改不可：实测这套 schema 的中文说明在 DeepSeek 分词器下 2.39 字/token，
 * 每多写 100 个中文字 = 每轮多 42 个 token（见 .superpowers/sdd/.../_r67-probe/）。
 */
export const pptInputSchema = z.object({
  title: z
    .string()
    .max(MAX_TITLE_CHARS, `标题最长 ${MAX_TITLE_CHARS} 字，请精简`)
    .optional()
    .describe('Deck title; also adds a cover slide and derives the file name when path is omitted'),
  subtitle: z
    .string()
    .max(MAX_SUBTITLE_CHARS, `副标题最长 ${MAX_SUBTITLE_CHARS} 字，请精简`)
    .optional()
    .describe('Cover subtitle, shown on the cover slide only, for example a date or a team name'),
  theme: z
    .enum(PPT_TEMPLATE_NAMES)
    .optional()
    .describe(
      `Colour theme, ten of them; pairing themes with occasions is covered in the pptx skill manual: ${PPT_TEMPLATE_NAMES.join(' / ')}. ` +
        'When omitted the theme fixed by the user for this conversation is used, otherwise one is picked from the title. Set it only when the user asks for a different theme'
    ),
  slides: pptSlidesSchema.describe('Slides in order, placed after the cover'),
  expect: pptExpectSchema.optional(),
  path: z
    .string()
    .optional()
    .describe(
      'Output path relative to the session workspace; when omitted the file name derives from the title'
    )
})

/**
 * **落库的源结构**（round 76）：渲染这份 .pptx 用的那份输入 —— create_ppt 落盘时记、edit_ppt 读回来改。
 *
 * 就是输入里除 `expect` / `path` 之外的全部字段（那两个是"这一次调用"的要求，不是文档本身）。
 * `theme` 记的是**当时实际用的那套名**（渲染回执里的 rendered.theme）：改版沿用同一套模板，
 * 免得用户换了一次会话模板、下一版整份换了配色。
 */
export const pptDeckSourceSchema = pptInputSchema.pick({
  title: true,
  subtitle: true,
  theme: true,
  slides: true
})

export type PptDeckSource = z.infer<typeof pptDeckSourceSchema>

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

/**
 * 渲染侧的只读视图：字段与 `pptSlideSchema` **一一对应**（那份面向模型、这份面向渲染；
 * `readonly` 是"渲染不改输入"的表态）。加字段时两处一起改 —— 这是唯一一处刻意的重复。
 */
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
 * 页数 = 封面（有文档标题时）+ 每张排得出版式的页（含模型显式给的 `closing` 页）。
 * **没有自动结尾页**：模型不给结尾页就没有结尾页。
 * `defaultTheme` = **这个会话**在对话页固定的模板名（按 threadId 现读；空串 / 不认得都退到自动挑，
 * 见 resolveTheme）。
 */
export async function renderPptx(input: PptxInput, defaultTheme?: string): Promise<PptxResult> {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'

  const theme = resolveTheme(input, defaultTheme)
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

/** createPptTool 的装配选项（round 66：**这个会话**在对话页固定的模板） */
export interface CreatePptToolOptions {
  /**
   * 这条会话在对话页「PPT」胶囊里固定的模板名（**现读**的取值函数，参数 = 会话 id）。
   * 缺省 = 没有固定模板（按内容自动挑）。空串 / 不认得的名字同样退到自动挑。
   *
   * 为什么按 threadId 问：模板选择是**会话级**的（round 66）—— 同一时刻不同会话各有一套，
   * 甚至有的会话没选。取值函数在工具执行那一刻用 `sessionKey(context)` 调（那时拿得到线程 id）。
   */
  getDefaultTheme?: (threadId: string) => string
  /**
   * round 76：这份 deck 的**源结构**记到哪（`edit_ppt` 之后就在它的基础上发增量）。
   * 缺省 = 不记（本部署没挂存储；产出照常，只是之后 edit_ppt 会照实说"没有源结构"）。
   */
  sources?: Pick<SessionPptSourceStore, 'record'>
}

export async function createPptTool(
  ctx: ToolContext,
  options: CreatePptToolOptions = {}
): Promise<Tool<PptInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  const planInput = (input: PptInput): ArtifactInput => ({
    title: input.title ?? input.slides[0]?.title,
    path: input.path
  })

  return createTool({
    id: 'create_ppt',
    description:
      'Build a .pptx deck from a template system; saved to the session workspace, returns path and bytes. ' +
      'Each `slides` entry is one page; an omitted `layout` is picked from that page data. A document `title` adds a cover slide; ' +
      'when you want a closing slide, add it yourself with real content (nothing is appended for you). ' +
      'A deck made earlier in this conversation is changed page by page with edit_ppt, which takes only the edits. ' +
      'Not for a document to read or print (create_docx / create_pdf), a report (create_report) or a data table (create_excel).',
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
      // 缺省模板按**本会话**取（round 66：模板选择是会话级的）；显式 theme 仍然最优先（见 resolveTheme）
      const rendered = await renderPptx(input, options.getDefaultTheme?.(session))

      // 产出后结构自检：包都读不通（fatal）就不落盘；某项不过照写但回执注明（断言没过也照写，
      // 让模型自己决定改还是报用户 —— 见 artifact-check 的 assertItems）
      const check = checkPackage(rendered.data, {
        kind: 'pptx',
        slides: rendered.slides,
        texts: pptSampleText(input),
        assert: { count: input.expect?.pages, contains: input.expect?.contains }
      })
      assertPackage(check)

      // 回执带**最终用的模板名**（用户与测试都靠它确认"选的模板真用上了"）
      const receipt = await saveArtifact(
        ctx,
        abs,
        rendered.data,
        `${input.slides.length} 页演示文稿，模板「${rendered.theme}」`,
        { session, check: check.note }
      )

      // round 76：把这份 deck 的**源结构**记进会话级映射，edit_ppt 之后就在它的基础上改。
      // 记的是**实际用的模板名**（rendered.theme）——改版沿同一套配色，不会因为用户在对话页换了
      // 模板、下一版整份换风格。落库失败**不影响这次产出**（文件已经写好了）：记一条日志，
      // 之后 edit_ppt 会照实说"这个会话里没有它的源结构"，不会假装成功。
      if (options.sources !== undefined) {
        try {
          await options.sources.record({
            threadId: session,
            path: abs,
            sourceJson: JSON.stringify(deckSourceOf(input, rendered.theme)),
            pages: rendered.slides,
            sha256: sha256Of(rendered.data),
            size: rendered.data.byteLength
          })
        } catch (error: unknown) {
          console.warn('[kyclaw] create_ppt 的源结构没能落库（edit_ppt 会照实说没有源）', error)
        }
      }

      return receipt
    }
  })
}

/** 入参 → 落库的源结构（除 `expect` / `path` 之外的全部；theme 用实际生效的那套名） */
function deckSourceOf(input: PptInput, theme: string): PptDeckSource {
  // 过一遍 schema：把"实际用的模板名"收成十套之一（渲染器只可能回注册表里的名字），
  // 顺带保证落库的 JSON 一定是能读回来的形状
  return pptDeckSourceSchema.parse({
    title: input.title,
    subtitle: input.subtitle,
    theme,
    slides: [...input.slides]
  })
}

/**
 * 自检的样本文本：封面标题优先，否则第一页第一个非空文本（取不到就给空数组，该检查项不出现）。
 * edit_ppt 改完也走这一份（同一个"这份包该有什么文字"的口径）。
 */
export function pptSampleText(input: PptxInput): string[] {
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

/**
 * 排定的一页：**画什么**（layout + slide）＋ **它是从哪来的**（`slideIndex`）。
 *
 * `slideIndex` 是 `edit_ppt` 的"页号 → 源结构下标"映射的依据（见 tools/ppt-edit.ts），
 * 所以它必须与 planPages 的挑选逻辑**同一处**算 —— 另算一份就会漂：
 *   - `-1` = 封面（由文档 `title` 生成，源 `slides` 里没有对应条目）；
 *   - `-2` = 内容全空时的那张占位页（见 renderPptx：零页演示文稿打不开）。
 */
export const PPT_PAGE_COVER = -1
export const PPT_PAGE_PLACEHOLDER = -2

export interface PlannedPage {
  layout: PptLayout
  slide: PptSlideInput
  /** 章节页的序号（1 起，按章节页出现顺序；非章节页为 0） */
  sectionIndex: number
  /** 源 `slides` 里的下标；封面 / 占位页见 PPT_PAGE_COVER / PPT_PAGE_PLACEHOLDER */
  slideIndex: number
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
 * **不自动补结尾页**：篇幅以模型给的为准（想要结尾页就自己写一张有内容的 `closing` 页）。
 * 从前这里会补一张只写「谢谢观看」的占位页 —— 技能里明令禁止这种"无信息页"，工具层不该反过来
 * 批量生产它。
 *
 * 导出给 edit_ppt 用（"物理页序 → 源结构下标"的唯一依据；`slides` 里排不出内容的页不占页号）。
 */
export function planPages(input: PptxInput): PlannedPage[] {
  const pages: PlannedPage[] = []
  const coverTitle = input.title?.trim() ?? ''
  if (coverTitle !== '') {
    pages.push({
      layout: 'cover',
      slide: { title: coverTitle, subtitle: trimText(input.subtitle) },
      sectionIndex: 0,
      slideIndex: PPT_PAGE_COVER
    })
  }

  let sections = 0
  input.slides.forEach((slide, index) => {
    const layout = resolveLayout(slide)
    if (layout === null) return
    if (layout === 'section') sections += 1
    pages.push({
      layout,
      slide,
      sectionIndex: layout === 'section' ? sections : 0,
      slideIndex: index
    })
  })

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
      // 没有兜底文案了：空 closing 页排不出来（退到自动挑，挑不出来就跳过）—— 免得出一张空页
      return trimText(slide.title) !== undefined
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

/**
 * 封面：大标题 + 副标题 + 主题色短线 + 装饰（不出页脚，页码从第 2 页起）。
 * 构图照 `coverPlan(theme)` 走 —— 居中封面（装饰块 = 该模板 motif）与 band 封面（左侧色带 + 左对齐标题块）
 * 是同一份几何的两个分支，渲染端的预览卡也读它（"画廊里看到的"就是"生成出来的"）。
 */
function drawCover(ctx: PageContext, page: PlannedPage): void {
  paintCanvas(ctx.slide, ctx.theme)
  const plan = coverPlan(ctx.theme)
  for (const box of plan.decor) addRect(ctx, box, ctx.theme.accent)

  addBox(ctx.slide, trimText(page.slide.title) ?? '', {
    ...plan.title,
    fontSize: plan.titleSize,
    bold: true,
    color: ctx.theme.title,
    align: plan.align,
    valign: 'middle'
  })
  addRect(ctx, plan.rule, ctx.theme.accent)

  const subtitle = trimText(page.slide.subtitle)
  if (subtitle !== undefined) {
    addBox(ctx.slide, subtitle, {
      ...plan.subtitle,
      fontSize: plan.subtitleSize,
      color: ctx.theme.muted,
      align: plan.align,
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

/** 结尾页：一句话 + 短线 + 装饰块（文字 = 模型给的 `title`；没有兜底文案，见 layoutReady） */
function drawClosing(ctx: PageContext, page: PlannedPage): void {
  paintCanvas(ctx.slide, ctx.theme)
  addMotif(ctx)
  addBox(ctx.slide, trimText(page.slide.title) ?? '', {
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
  addRect(ctx, { x, y, w, h: FRAME.ruleH }, ctx.theme.accent)
}

/** 一个矩形色块（装饰色块 / 短线 / 封面色带共用这一处；颜色一律走模板 token） */
function addRect(ctx: PageContext, box: PptBox, color: string): void {
  ctx.slide.addShape(ctx.pptx.ShapeType.rect, {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    fill: { color }
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
 * 封面 / 章节页 / 结尾页的装饰色块（形状风格跟模板走，同一模板三处一致）。
 * 形状几何在 shared/ppt-templates.ts 的 motifBoxes（渲染端的预览卡读同一份）；三套形状都
 * **避开页脚区**（y ≥ 4.9 的横带只留给页脚细线与页码）：章节页/结尾页也带页脚，
 * 装饰压在页脚上会让 muted 字色贴在强调色底上（对比度不够）。
 */
function addMotif(ctx: PageContext): void {
  for (const box of motifBoxes(ctx.theme.motif)) addRect(ctx, box, ctx.theme.accent)
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
