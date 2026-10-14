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
 *   - **源结构**（增量编辑的地基）：落盘成功后把这份文档的源结构 + 文件指纹记进会话级映射
 *     （`session_docx_sources`，装配时经 `options.sources` 注入）——`edit_docx` 只发改动，
 *     其余块从这份源里读（见 tools/docx-edit.ts）。记不上不影响这次产出，但回执会明确写
 *     "源结构未登记，edit_docx 不可用"。
 *   - 依赖：docx（纯 JS，无原生依赖；Node 侧 `Packer.toBuffer` 直接回 Buffer）。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { MAX_DOCX_SOURCE_BYTES } from '../../shared/session-docx-sources'
import { sha256Of, type SessionDocxSourceStore } from '../session-docx-sources'
import { assertPackage, checkPackage } from './artifact-check'
import {
  artifactNeedsApproval,
  artifactTarget,
  saveArtifact,
  type ArtifactInput
} from './artifacts'
import { approvalSessionOf, sessionKey, type ToolContext } from './guard'

/** 输入上限（依据：模块 4 报告 §六.6 登记的"输入规模无上限"）：超限让模型知道怎么改 */
export const MAX_BLOCKS = 1000
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

/**
 * **落库的源结构**：渲染这份 .docx 用的那份输入 —— create_docx 落盘时记、edit_docx 读回来改。
 *
 * 字段就是输入里除 `expect` / `path` 之外的那两个（那两个是"这一次调用"的要求，不是文档本身：
 * `path` 是文件落在哪，`expect` 是这一轮要核的断言）。形状与 `docxInputSchema` 同源，所以库里的
 * JSON 一定读得回来（`docxSourceSchema.parse`）。
 *
 * 与入参的**唯一**差别：`blocks` 允许为空。删光所有内容块是编辑里的合法终点
 * （`delete` 每块都行，渲染器对空 blocks 有占位语义，见 renderDocx），create 的入参则要求至少一块。
 */
export const docxSourceSchema = docxInputSchema.pick({ title: true }).extend({
  blocks: z.array(docxBlockSchema).max(MAX_BLOCKS, `文档最多 ${MAX_BLOCKS} 个内容块，请拆分或精简`)
})

export type DocxSource = z.infer<typeof docxSourceSchema>

export type DocxBlock = z.infer<typeof docxBlockSchema>

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

/**
 * create_docx 的装配选项。
 *
 * `sources` 缺省 = 不记源结构（单测、或某个部署没挂存储）：产出照常，只是之后 `edit_docx`
 * 会照实说"这个会话里没有它的源结构"，绝不假装改得动。
 */
export interface CreateDocxToolOptions {
  /** 这份文档的**源结构**记到哪（`edit_docx` 之后就在它的基础上发增量） */
  sources?: Pick<SessionDocxSourceStore, 'record'>
}

export async function createDocxTool(
  ctx: ToolContext,
  options: CreateDocxToolOptions = {}
): Promise<Tool<DocxInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  const planInput = (input: DocxInput): ArtifactInput => ({ title: input.title, path: input.path })

  return createTool({
    id: 'create_docx',
    description:
      'Build a Word document (.docx) from ordered blocks: heading, paragraph, bullets and table, the table optionally with a header row. ' +
      'Saved to the session workspace, returns path and bytes. ' +
      'A document made earlier in this conversation is changed block by block with edit_docx, which takes only the edits. ' +
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
        texts: docxSampleText(input),
        assert: { contains: input.expect?.contains }
      })
      assertPackage(check)

      const receipt = await saveArtifact(ctx, abs, bytes, `${input.blocks.length} 个内容块`, {
        session,
        check: check.note
      })

      // 把这份文档的**源结构**记进会话级映射，edit_docx 之后就在它的基础上改。记不上**不影响**
      // 这次的产出（文件已经写好了）：回执如实说"源结构未登记，edit_docx 不可用"，
      // 绝不假装还能增量改（见 recordDocxSource）。
      const source = docxSourceOf(input)
      const miss = await recordDocxSource(options.sources, {
        threadId: session,
        path: abs,
        source,
        bytes
      })
      return miss === null ? receipt : `${receipt}；${unrecordedNote(miss)}`
    }
  })
}

/** 入参 → 落库的源结构（除 `expect` / `path` 之外的全部；过一遍 schema，保证落库的 JSON 读得回来） */
export function docxSourceOf(input: {
  title?: string
  blocks: readonly DocxBlockInput[]
}): DocxSource {
  return docxSourceSchema.parse({
    ...(input.title === undefined ? {} : { title: input.title }),
    blocks: [...input.blocks]
  })
}

/** 源结构没记上的两种缘由（回执里的定性） */
export type DocxSourceMiss = 'too-large' | 'store-error'

/**
 * 记源结构。返回 `null` = 记上了；`'too-large'` / `'store-error'` = **没记上**
 * （调用方如实回执，绝不宣称 edit_docx 还能用）。
 *
 * 两个**不抛**的理由：
 *   ① 落盘已经完成 —— 因为记源失败就"撤销"那份文件是更坏的选择（用户拿到的东西没了）；
 *   ② 源结构超 2MB 是合法输入（一份长文档而已），只是**记不起**它，不能因此整次调用失败。
 * 没挂 store（`sources === undefined`，单测/未接线）同样回 null：那一路本来就不记，
 * 不是"失败了"。
 */
export async function recordDocxSource(
  sources: Pick<SessionDocxSourceStore, 'record'> | undefined,
  entry: { threadId: string; path: string; source: DocxSource; bytes: Uint8Array }
): Promise<DocxSourceMiss | null> {
  if (sources === undefined) return null

  const sourceJson = JSON.stringify(entry.source)
  if (Buffer.byteLength(sourceJson, 'utf8') > MAX_DOCX_SOURCE_BYTES) return 'too-large'

  try {
    await sources.record({
      threadId: entry.threadId,
      path: entry.path,
      sourceJson,
      blocks: entry.source.blocks.length,
      sha256: sha256Of(entry.bytes),
      size: entry.bytes.byteLength
    })
    return null
  } catch (error: unknown) {
    console.warn('[kyclaw] docx 的源结构没能落库（edit_docx 之后会照实说没有源）', error)
    return 'store-error'
  }
}

/** create_docx 回执里"源结构没记上"的说法（用户口径的原话：明确说 edit_docx 不可用） */
export function unrecordedNote(miss: DocxSourceMiss): string {
  return `源结构未登记${miss === 'too-large' ? `（超过 ${maxSourceMb()}MB 记不下）` : '（本地库写入失败）'}，edit_docx 不可用（要改只能整份重发 create_docx）`
}

function maxSourceMb(): number {
  return Math.round(MAX_DOCX_SOURCE_BYTES / (1024 * 1024))
}

/**
 * 自检的样本文本：标题优先，否则第一个非空块文本（取不到就给空数组，该检查项不出现）。
 * edit_docx 改完也走这一份（同一个"这份包该有什么文字"的口径）。
 */
export function docxSampleText(input: {
  title?: string
  blocks: readonly DocxBlockInput[]
}): string[] {
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
