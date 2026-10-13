/**
 * create_docx：把结构化块写成 .docx 文档（模块 4 格式④）。
 *
 * 口径：
 *   - `blocks` 是**显式结构化**的（不是 Markdown 字符串）：heading / paragraph / bullets / table 四种块，
 *     模型不用赌"解析器认不认我的排版"——写什么块就是什么块（与 spec 的"结构化产出"一致）。
 *   - 有 `title` 就先落一个 Title 段（Word 的标题样式，导航窗格能认）。
 *   - 空块（空段落 / 无行列的表格）跳过，免得产出物里全是空行。
 *   - **断言**（`expect`）：用户说"文档里必须有这句话"时写进来；只在正文部件（word/document.xml）
 *     里核，页眉页脚与批注不算；没过不拦落盘、但回执会点名差在哪。
 *   - 内容与落盘分离：`renderDocx` 是纯入口（块数据 → 字节，无 IO）。
 *   - 依赖：docx（纯 JS，无原生依赖；Node 侧 `Packer.toBuffer` 直接回 Buffer）。
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

/** 输入上限（依据：模块 4 报告 §六.6 登记的"输入规模无上限"）：超限让模型知道怎么改 */
const MAX_BLOCKS = 1000
const MAX_TABLE_ROWS = 2000
const MAX_PARAGRAPH_CHARS = 20000
const MAX_BULLET_ITEMS = 200
const MAX_BULLET_CHARS = 2000
/** 断言条数上限：回执里要逐条报，太多会把上下文吃光 */
const MAX_EXPECTS = 20

export const docxBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    text: z
      .string()
      .min(1)
      .max(MAX_PARAGRAPH_CHARS, `单段文字最长 ${MAX_PARAGRAPH_CHARS} 字，请拆成多段`)
      .describe(`Heading text, at most ${MAX_PARAGRAPH_CHARS} characters`),
    level: z.number().int().min(1).max(6).optional().describe('Heading level 1-6; defaults to 1')
  }),
  z.object({
    type: z.literal('paragraph'),
    text: z
      .string()
      .max(MAX_PARAGRAPH_CHARS, `单段文字最长 ${MAX_PARAGRAPH_CHARS} 字，请拆成多段`)
      .describe(
        `One paragraph; an empty string is skipped, at most ${MAX_PARAGRAPH_CHARS} characters`
      )
  }),
  z.object({
    type: z.literal('bullets'),
    items: z
      .array(z.string().max(MAX_BULLET_CHARS, `单条要点最长 ${MAX_BULLET_CHARS} 字，请精简`))
      .min(1)
      .max(MAX_BULLET_ITEMS, `一个列表最多 ${MAX_BULLET_ITEMS} 条，请拆分`)
      .describe(
        `Bullet list items, at most ${MAX_BULLET_ITEMS} of them and ${MAX_BULLET_CHARS} characters each`
      )
  }),
  z.object({
    type: z.literal('table'),
    headers: z
      .array(z.string())
      .optional()
      .describe('Header row; when given it becomes a bold first row'),
    rows: z
      .array(z.array(z.string()))
      .max(MAX_TABLE_ROWS, `一张表最多 ${MAX_TABLE_ROWS} 行，请拆分表格`)
      .describe(`Data rows, a two-dimensional string array, at most ${MAX_TABLE_ROWS} rows`)
  })
])

export const docxInputSchema = z.object({
  title: z
    .string()
    .optional()
    .describe(
      'Document title, written as a Title paragraph; also derives the file name when path is omitted'
    ),
  blocks: z
    .array(docxBlockSchema)
    .min(1)
    .max(MAX_BLOCKS, `文档最多 ${MAX_BLOCKS} 个内容块，请拆分或精简`)
    .describe(`Content blocks in order, at most ${MAX_BLOCKS}`),
  expect: z
    .object({
      contains: z
        .array(z.object({ text: z.string().min(1).describe('Text that must appear') }))
        .max(MAX_EXPECTS, `最多 ${MAX_EXPECTS} 条断言，请精选`)
        .optional()
        .describe(
          'Text the user named as required, checked in the body text only, ignoring headers, footers and comments'
        )
    })
    .optional()
    .describe(
      'Hard requirements the user stated, such as specific text that must appear; each one is checked and misses are reported in the result'
    ),
  path: z
    .string()
    .optional()
    .describe(
      'Output path relative to the session workspace; when omitted the file name derives from the title'
    )
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
      'Build a Word document (.docx) from ordered blocks: heading, paragraph, bullets and table, the table optionally with a header row. ' +
      'Saved to the session workspace, returns path and bytes. ' +
      'Not for something to read on screen or print (create_report / create_pdf), a deck (create_ppt) or a data table (create_excel).',
    inputSchema: docxInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      artifactNeedsApproval(
        ctx,
        'create_docx',
        planInput(input),
        'docx',
        '文档',
        approvalSessionOf(approval)
      ),
    execute: async (input, context) => {
      const session = sessionKey(context)
      const abs = artifactTarget(ctx, planInput(input), 'docx', '文档', session)
      const bytes = await renderDocx(input)

      // 产出后结构自检：包都读不通（fatal）就不落盘；某项不过照写但回执注明（断言没过也照写）
      const check = checkPackage(bytes, {
        kind: 'docx',
        texts: sampleText(input),
        assert: { contains: input.expect?.contains }
      })
      assertPackage(check)

      return await saveArtifact(ctx, abs, bytes, `${input.blocks.length} 个内容块`, {
        session,
        check: check.note
      })
    }
  })
}

/** 自检的样本文本：标题优先，否则第一个非空块文本（取不到就给空数组，该检查项不出现） */
function sampleText(input: DocxInput): string[] {
  const title = input.title?.trim() ?? ''
  if (title !== '') return [title]

  for (const block of input.blocks) {
    switch (block.type) {
      case 'heading':
      case 'paragraph': {
        if (block.text.trim() !== '') return [block.text]
        break
      }
      case 'bullets': {
        const first = block.items.find((item) => item.trim() !== '')
        if (first !== undefined) return [first]
        break
      }
      case 'table': {
        const header = (block.headers ?? []).find((text) => text.trim() !== '')
        if (header !== undefined) return [header]
        const cell = block.rows.flat().find((text) => text.trim() !== '')
        if (cell !== undefined) return [cell]
        break
      }
    }
  }
  return []
}
