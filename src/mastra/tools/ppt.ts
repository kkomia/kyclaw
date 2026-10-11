/**
 * create_ppt：把标题/要点列表写成 .pptx 演示文稿（模块 4 格式③）。
 *
 * 口径：
 *   - 有 `title` 就生成一张**封面**，之后每个 `slides` 项一页（页标题 + 逐条项目符号）；
 *     一页既没有标题又没有要点时跳过（JSON 里常有多余空对象）；全都空则补一页占位，
 *     免得产出物是"零页演示文稿"（PowerPoint 打不开）。
 *   - 版式固定 **16:9**（LAYOUT_16x9），字号/位置写死在模板里 —— v1 不做版式控制（留后续）。
 *   - 内容与落盘分离：`renderPptx` 是纯入口（幻灯片数据 → 字节，无 IO）。
 *   - 依赖：pptxgenjs（纯 JS，无原生依赖；Node 侧 `write({outputType:'nodebuffer'})` 直接回 Buffer）。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import {
  artifactNeedsApproval,
  artifactTarget,
  saveArtifact,
  type ArtifactInput
} from './artifacts'
import { sessionKey, type ToolContext } from './guard'

export const pptInputSchema = z.object({
  title: z
    .string()
    .optional()
    .describe('演示文稿标题（会单独生成一张封面；不给 path 时也用它派生文件名）'),
  slides: z
    .array(
      z.object({
        title: z.string().optional().describe('这一页的标题'),
        bullets: z.array(z.string()).optional().describe('这一页的要点，每条一个项目符号')
      })
    )
    .min(1)
    .describe('幻灯片列表（按顺序排在封面之后）'),
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

/** 渲染演示文稿（纯入口：没有 IO，测试拿返回值解包断言） */
export async function renderPptx(input: {
  title?: string
  slides: readonly PptSlideInput[]
}): Promise<Buffer> {
  const { default: PptxGenJS } = await import('pptxgenjs')
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_16x9'

  const coverTitle = input.title?.trim() ?? ''
  if (coverTitle !== '') {
    const cover = pptx.addSlide()
    cover.addText(coverTitle, {
      x: LAYOUT.left,
      y: 2.1,
      w: LAYOUT.width,
      h: 1.4,
      fontSize: 36,
      bold: true,
      align: 'center',
      color: INK
    })
  }

  let contentSlides = 0
  for (const slide of input.slides) {
    const slideTitle = slide.title?.trim() ?? ''
    const bullets = (slide.bullets ?? []).map((text) => text.trim()).filter((text) => text !== '')
    if (slideTitle === '' && bullets.length === 0) continue

    const page = pptx.addSlide()
    contentSlides += 1
    if (slideTitle !== '') {
      page.addText(slideTitle, {
        x: LAYOUT.left,
        y: LAYOUT.titleY,
        w: LAYOUT.width,
        h: LAYOUT.titleH,
        fontSize: 24,
        bold: true,
        color: INK
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
          color: INK_SOFT
        }
      )
    }
  }

  if (contentSlides === 0 && coverTitle === '') {
    const page = pptx.addSlide()
    page.addText('（这份演示文稿没有内容）', {
      x: LAYOUT.left,
      y: 2.4,
      w: LAYOUT.width,
      h: 0.8,
      fontSize: 18,
      align: 'center',
      color: INK_SOFT
    })
  }

  const data = await pptx.write({ outputType: 'nodebuffer' })
  return Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
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
      'slides 每项一页，bullets 是这一页的项目符号条目。适合汇报、提案、讲解稿；' +
      '要打印成文档用 create_pdf / create_docx，要数据表用 create_excel。执行前会请求用户批准。',
    inputSchema: pptInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) =>
      artifactNeedsApproval(ctx, 'create_ppt', planInput(input), 'pptx', '演示文稿'),
    execute: async (input, context) => {
      const session = sessionKey(context)
      const abs = artifactTarget(ctx, planInput(input), 'pptx', '演示文稿', session)
      const bytes = await renderPptx(input)

      return await saveArtifact(ctx, abs, bytes, `${input.slides.length} 页演示文稿`, { session })
    }
  })
}
