/**
 * create_ppt：把标题/要点列表写成 .pptx 演示文稿（模块 4 格式③）。
 *
 * 口径：
 *   - 有 `title` 就生成一张**封面**，之后每个 `slides` 项一页（页标题 + 逐条项目符号）；
 *     一页既没有标题又没有要点时跳过（JSON 里常有多余空对象）；全都空则补一页占位，
 *     免得产出物是"零页演示文稿"（PowerPoint 打不开）。
 *   - 版式固定 **16:9**（LAYOUT_16x9），字号/位置写死在模板里 —— v1 不做版式控制（留后续）。
 *   - **防溢出**：所有文本框都开 `fit: 'shrink'`（PowerPoint 侧"溢出自动缩小"），到不了"文字顶出画布"。
 *   - 内容与落盘分离：`renderPptx` 是纯入口（幻灯片数据 → 字节 + 实际页数，无 IO）。
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
import { sessionKey, type ToolContext } from './guard'

/** 输入上限（依据：模块 4 报告 §六.6 登记的"输入规模无上限"）：超限让模型知道怎么改 */
const MAX_SLIDES = 60
const MAX_BULLETS_PER_SLIDE = 30
const MAX_BULLET_CHARS = 500
const MAX_TITLE_CHARS = 200

export const pptInputSchema = z.object({
  title: z
    .string()
    .max(MAX_TITLE_CHARS, `标题最长 ${MAX_TITLE_CHARS} 字，请精简`)
    .optional()
    .describe(
      `演示文稿标题（会单独生成一张封面；不给 path 时也用它派生文件名；最长 ${MAX_TITLE_CHARS} 字）`
    ),
  slides: z
    .array(
      z.object({
        title: z
          .string()
          .max(MAX_TITLE_CHARS, `每页标题最长 ${MAX_TITLE_CHARS} 字，请精简`)
          .optional()
          .describe(`这一页的标题（最长 ${MAX_TITLE_CHARS} 字）`),
        bullets: z
          .array(z.string().max(MAX_BULLET_CHARS, `单条要点最长 ${MAX_BULLET_CHARS} 字，请精简`))
          .max(MAX_BULLETS_PER_SLIDE, `一页最多 ${MAX_BULLETS_PER_SLIDE} 条要点，请拆分页面`)
          .optional()
          .describe(
            `这一页的要点，每条一个项目符号（最多 ${MAX_BULLETS_PER_SLIDE} 条，每条最长 ${MAX_BULLET_CHARS} 字）`
          )
      })
    )
    .min(1)
    .max(MAX_SLIDES, `最多 ${MAX_SLIDES} 页，请拆分演示文稿`)
    .describe(`幻灯片列表（按顺序排在封面之后；最多 ${MAX_SLIDES} 页）`),
  path: z.string().optional().describe('落盘路径（相对当前会话工作区；不给就按标题派生文件名）')
})

export type PptInput = z.infer<typeof pptInputSchema>

export interface PptSlideInput {
  title?: string
  bullets?: readonly string[]
}

/** 16:9 版式下正文区的位置（英寸）：标题一条、要点一块 */
const LAYOUT = {
  titleY: 0.4,
  titleH: 0.9,
  bodyY: 1.5,
  bodyH: 4.3,
  left: 0.6,
  width: 8.8
} as const

const INK = '1F1F1E'
const INK_SOFT = '3A3A38'

/** 渲染结果：字节 + **实际写入的页数**（封面 + 非空内容页 + 空占位页）——自检与调用方共用这一处口径 */
export interface PptxResult {
  data: Buffer
  slides: number
}

/** 渲染演示文稿（纯入口：没有 IO，测试拿返回值解包断言） */
export async function renderPptx(input: {
  title?: string
  slides: readonly PptSlideInput[]
}): Promise<PptxResult> {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'

  const coverTitle = input.title?.trim() ?? ''
  let slides = 0
  if (coverTitle !== '') {
    const cover = pptx.addSlide()
    slides += 1
    cover.addText(coverTitle, {
      x: LAYOUT.left,
      y: 2.1,
      w: LAYOUT.width,
      h: 1.4,
      fontSize: 36,
      bold: true,
      align: 'center',
      color: INK,
      fit: 'shrink'
    })
  }

  for (const slide of input.slides) {
    const slideTitle = slide.title?.trim() ?? ''
    const bullets = (slide.bullets ?? []).map((text) => text.trim()).filter((text) => text !== '')
    if (slideTitle === '' && bullets.length === 0) continue

    const page = pptx.addSlide()
    slides += 1
    if (slideTitle !== '') {
      page.addText(slideTitle, {
        x: LAYOUT.left,
        y: LAYOUT.titleY,
        w: LAYOUT.width,
        h: LAYOUT.titleH,
        fontSize: 24,
        bold: true,
        color: INK,
        fit: 'shrink'
      })
    }
    if (bullets.length > 0) {
      page.addText(
        bullets.map((text) => ({ text, options: { bullet: true } })),
        {
          x: LAYOUT.left + 0.2,
          y: LAYOUT.bodyY,
          w: LAYOUT.width - 0.4,
          h: LAYOUT.bodyH,
          fontSize: 16,
          color: INK_SOFT,
          fit: 'shrink'
        }
      )
    }
  }

  if (slides === 0) {
    const page = pptx.addSlide()
    slides += 1
    page.addText('（这份演示文稿没有内容）', {
      x: LAYOUT.left,
      y: 2.4,
      w: LAYOUT.width,
      h: 0.8,
      fontSize: 18,
      align: 'center',
      color: INK_SOFT,
      fit: 'shrink'
    })
  }

  const data = await pptx.write({ outputType: 'nodebuffer' })
  return { data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), slides }
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
      '生成 .pptx 演示文稿（一份 cover + 每页标题与要点），落到当前会话工作区并返回文件路径与字节数。' +
      'slides 每项一页，bullets 是这一页的项目符号条目（一页最多 30 条要点，超出请拆分页面）。' +
      '文字框开了"溢出自动缩小"，但要点还是要写短。适合汇报、提案、讲解稿；' +
      '要打印成文档用 create_pdf / create_docx，要数据表用 create_excel。执行前会请求用户批准。',
    inputSchema: pptInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) =>
      artifactNeedsApproval(ctx, 'create_ppt', planInput(input), 'pptx', '演示文稿'),
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
