/**
 * create_docx：把结构化块写成 .docx 文档（模块 4 格式④）。
 *
 * 口径：
 *   - `blocks` 是**显式结构化**的（不是 Markdown 字符串）：heading / paragraph / bullets / table 四种块，
 *     模型不用赌"解析器认不认我的排版"——写什么块就是什么块（与 spec 的"结构化产出"一致）。
 *   - 有 `title` 就先落一个 Title 段（Word 的标题样式，导航窗格能认）。
 *   - 空块（空段落 / 无行列的表格）跳过，免得产出物里全是空行。
 *   - 内容与落盘分离：`renderDocx` 是纯入口（块数据 → 字节，无 IO）。
 *   - 依赖：docx（纯 JS，无原生依赖；Node 侧 `Packer.toBuffer` 直接回 Buffer）。
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

export const docxBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    text: z.string().min(1).describe('标题文字'),
    level: z.number().int().min(1).max(6).optional().describe('标题级别 1-6（缺省 1）')
  }),
  z.object({
    type: z.literal('paragraph'),
    text: z.string().describe('一段正文（空串会被跳过）')
  }),
  z.object({
    type: z.literal('bullets'),
    items: z.array(z.string()).min(1).describe('项目符号列表的条目')
  }),
  z.object({
    type: z.literal('table'),
    headers: z.array(z.string()).optional().describe('表头（可选；给了就加粗成第一行）'),
    rows: z.array(z.array(z.string())).describe('数据行（二维字符串数组）')
  })
])

export const docxInputSchema = z.object({
  title: z.string().optional().describe('文档标题（写成 Title 段；不给 path 时也用它派生文件名）'),
  blocks: z.array(docxBlockSchema).min(1).describe('文档内容块（按顺序排列）'),
  path: z.string().optional().describe('落盘路径（相对当前会话工作区；不给就按标题派生文件名）')
})

export type DocxInput = z.infer<typeof docxInputSchema>

export type DocxBlockInput =
  | { type: 'heading'; text: string; level?: number }
  | { type: 'paragraph'; text: string }
  | { type: 'bullets'; items: readonly string[] }
  | { type: 'table'; headers?: readonly string[]; rows: ReadonlyArray<readonly string[]> }

type DocxModule = typeof import('docx')
type DocxChild = InstanceType<DocxModule['Paragraph']> | InstanceType<DocxModule['Table']>

/** 表格占满页宽（Word 的百分比宽度口径） */
const TABLE_WIDTH_PERCENT = 100

/** 渲染文档（纯入口：没有 IO，测试拿返回值解包断言） */
export async function renderDocx(input: {
  title?: string
  blocks: readonly DocxBlockInput[]
}): Promise<Buffer> {
  const {
    Document,
    HeadingLevel,
    Packer,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType
  } = await import('docx')

  const headings: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    1: HeadingLevel.HEADING_1,
    2: HeadingLevel.HEADING_2,
    3: HeadingLevel.HEADING_3,
    4: HeadingLevel.HEADING_4,
    5: HeadingLevel.HEADING_5,
    6: HeadingLevel.HEADING_6
  }

  const children: DocxChild[] = []
  const title = input.title?.trim() ?? ''
  if (title !== '') children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }))

  for (const block of input.blocks) {
    switch (block.type) {
      case 'heading': {
        const text = block.text.trim()
        if (text === '') break
        children.push(
          new Paragraph({ text, heading: headings[block.level ?? 1] ?? HeadingLevel.HEADING_1 })
        )
        break
      }
      case 'paragraph': {
        if (block.text.trim() === '') break
        children.push(new Paragraph({ text: block.text }))
        break
      }
      case 'bullets': {
        const items = block.items.map((item) => item.trim()).filter((item) => item !== '')
        for (const item of items) children.push(new Paragraph({ text: item, bullet: { level: 0 } }))
        break
      }
      case 'table': {
        const rows = block.rows
          .map((row) => row.map((cell) => String(cell)))
          .filter((row) => row.length > 0)
        const headers = (block.headers ?? []).map((header) => String(header))
        if (headers.length === 0 && rows.length === 0) break

        children.push(
          new Table({
            width: { size: TABLE_WIDTH_PERCENT, type: WidthType.PERCENTAGE },
            rows: [
              ...(headers.length === 0
                ? []
                : [
                    new TableRow({
                      children: headers.map(
                        (header) =>
                          new TableCell({
                            children: [
                              new Paragraph({
                                children: [new TextRun({ text: header, bold: true })]
                              })
                            ]
                          })
                      )
                    })
                  ]),
              ...rows.map(
                (row) =>
                  new TableRow({
                    children: row.map(
                      (cell) => new TableCell({ children: [new Paragraph({ text: cell })] })
                    )
                  })
              )
            ]
          })
        )
        break
      }
    }
  }

  // 全部块都是空的（极端情况）：给一段占位，免得产出物是一份空文档
  if (children.length === 0) children.push(new Paragraph({ text: '（这份文档没有内容）' }))

  return await Packer.toBuffer(new Document({ sections: [{ children }] }))
}

export async function createDocxTool(ctx: ToolContext): Promise<Tool<DocxInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  const planInput = (input: DocxInput): ArtifactInput => ({ title: input.title, path: input.path })

  return createTool({
    id: 'create_docx',
    description:
      '生成 Word 文档（.docx）：结构化块按顺序排——heading（标题）、paragraph（正文）、' +
      'bullets（项目符号）、table（表格，可带表头）。落到当前会话工作区并返回文件路径与字节数。' +
      '适合要给别人改的正式文档、合同式条文、带表格的说明；只要阅读/打印用 create_pdf，' +
      '要演示用 create_ppt。执行前会请求用户批准。',
    inputSchema: docxInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) =>
      artifactNeedsApproval(ctx, 'create_docx', planInput(input), 'docx', '文档'),
    execute: async (input, context) => {
      const session = sessionKey(context)
      const abs = artifactTarget(ctx, planInput(input), 'docx', '文档', session)
      const bytes = await renderDocx(input)

      return await saveArtifact(ctx, abs, bytes, `${input.blocks.length} 个内容块`, { session })
    }
  })
}
