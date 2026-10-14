/**
 * edit_docx：在**上一版**产出物的基础上改（增量编辑 v1）—— 模型只发增量，不发整份。
 *
 * 为什么要它（与 edit_ppt 同一份账，round 76 的量化结论）：`create_docx` 每次都要模型把**完整**
 * `blocks` 重发一遍，工具层没有"只改第二段"的入口。改一处 = 整份重生成，钱花在**模型输出**上，
 * 所以出路是"只让模型发改动"，而不是"去改 docx 的 XML 做微创"（那条路易碎，且会绕开自检/断言链路）。
 *
 * 落盘口径：**仍然整份重新渲染一次**（本地的 docx 库，不花 token）。源结构从 `session_docx_sources`
 * 读（create_docx 落盘时记的，见 mastra/session-docx-sources.ts），改完再把新的源结构 + 新指纹写回去
 * —— 下一次编辑就在这一次的基础上改。四个操作（每个都能表达"改哪一块 + 改什么"）：
 *
 *   - `replace`：换掉第 N 个内容块（块数不变）；
 *   - `insert`：在第 N 块之后插一块（`after: 0` = 插到最前）；
 *   - `delete`：删掉第 N 块（**允许删最后一块**：全删光时 create 渲染器的占位语义照旧 ——
 *     渲染出一段"（这份文档没有内容）"，不再是空文档）；
 *   - `meta`：改文档标题（"改标题这类单字段"），空串 = 去掉标题段。
 *
 * **块号一律是"内容块"的 1 起序号**（= create_docx 的 `blocks` 顺序），**标题不算一块**
 * （它在渲染里是独立的 Title 段，见 renderDocx）：`blocks[0]` 是第 1 块。
 *
 * 三条**干净失败**（都不动盘上的文件、都说清下一步该怎么走）：
 *   ① 这个会话里没有它的源结构（没做过 / 库里没记上 / 源结构超限没记）→ 引导用 `create_docx` 重做；
 *   ② 盘上那份和上一版**指纹对不上**（用户手改过 / 删过）→ 列出出口（以源为准覆盖 / 谁也别动），
 *      默认**停**，绝不静默覆盖用户的改动；
 *   ③ 应用重启后照样能改 —— 源结构落库（不是内存），换一个进程读同一张表。
 *
 * **v1 的边界（不装作支持）**：`ifChanged: "adopt"` 一律拒绝（读一份现有 .docx 的"旧内容"当新源
 * 做不到 —— Word 的文字与版式不是一一对应，读回来会丢结构/图片/批注）。要保留文件里的手改内容，
 * 就整份重发 `create_docx`。所以 v1 只有 stop（默认）/ overwrite 两种口径。
 *
 * **整段编辑是一个事务**：read/stat → 比对指纹 → 应用 ops → 渲染 → 结构自检 → 落盘 → 记源，
 * 全部在**同一个** `ctx.state.runExclusive(abs, …)` 里（同一份文件的两次编辑不会交错读同一份旧源）。
 * 锁内走 `writeArtifactLocked`（只做目录/建目录/写/回执）而**不是** `saveArtifact` ——
 * 后者会在同一目标上再排一次队，那条队列永远等不到自己。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import type { DocxSourceRecord } from '../../shared/session-docx-sources'
import { sha256Of, type SessionDocxSourceStore } from '../session-docx-sources'
import { assertPackage, checkPackage } from './artifact-check'
import {
  artifactNeedsApproval,
  artifactTarget,
  writeArtifactLocked,
  type ArtifactInput
} from './artifacts'
import { approvalSessionOf, sessionKey, statOrNull, type ToolContext } from './guard'
import {
  docxBlockSchema,
  docxInputSchema,
  docxSampleText,
  docxSourceOf,
  docxSourceSchema,
  MAX_BLOCKS,
  recordDocxSource,
  renderDocx,
  unrecordedNote,
  type DocxBlockInput,
  type DocxSource
} from './docx'

/** 一次调用最多几处改动（改几十处的任务是"重做"，该走 create_docx） */
export const MAX_DOCX_OPS = 60

/** 回执里"改后块序"每块文字的截断长度（回执要短，认得出来是哪一块就够了） */
const OUTLINE_HEAD_CHARS = 16

/** 回执里最多列几块（1000 块的文档不能整份抄进回执——那是把省下来的 token 又吐回去） */
const OUTLINE_MAX_BLOCKS = 40

export const docxEditOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('replace'),
      block: z
        .number()
        .int()
        .positive()
        .describe(
          'Content block to overwrite, 1-based over create_docx `blocks`; the title is not a block'
        ),
      content: docxBlockSchema.describe('The block that replaces it')
    })
    .describe('Overwrite one content block; the block count does not change'),
  z
    .object({
      op: z.literal('insert'),
      after: z
        .number()
        .int()
        .min(0)
        .describe('Insert right after this content block number; 0 puts it before the first block'),
      content: docxBlockSchema.describe('The block to add')
    })
    .describe('Add one content block'),
  z
    .object({
      op: z.literal('delete'),
      block: z
        .number()
        .int()
        .positive()
        .describe('Content block to remove, 1-based over create_docx `blocks`')
    })
    .describe('Remove one content block'),
  z
    .object({
      op: z.literal('meta'),
      title: z
        .string()
        .describe('New document title, written as the Title paragraph; an empty string drops it')
    })
    .describe('Change the document title')
])

export type DocxEditOp = z.infer<typeof docxEditOpSchema>

export const docxEditInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'The .docx to change, relative to the session workspace — the same path create_docx reported'
    ),
  ops: z
    .array(docxEditOpSchema)
    .min(1)
    .max(MAX_DOCX_OPS, `一次最多改 ${MAX_DOCX_OPS} 处，全篇重写请用 create_docx`)
    .describe(
      'Edits applied in order; send only the blocks you change, never the whole document. Block numbers are 1-based over create_docx blocks and never count the title'
    ),
  ifChanged: z
    .enum(['stop', 'overwrite', 'adopt'])
    .optional()
    .describe(
      'Only used when the file on disk is no longer the one create_docx rendered: stop (default) reports both ways out; ' +
        'overwrite regenerates from the stored blocks (manual edits to the file are lost). adopt is rejected: a Word document cannot be rebuilt from its text'
    ),
  expect: docxInputSchema.shape.expect
})

export type DocxEditInput = z.infer<typeof docxEditInputSchema>

/** 本部署没挂源结构存储时的回执（不是"工具不存在"，而是"这条链路没接上"） */
export const NO_DOCX_SOURCE_STORE =
  'edit_docx 用不了：这个运行环境没有挂 Word 源结构存储。请用 create_docx 把整份内容重做一遍（要改哪些块就按改后的样子写）。'

/**
 * `adopt` 的拒绝文案（v1 明确不支持，不装作能）：说清**为什么**做不到 + 两条真出口。
 * 这条不是"暂缓实现"的口径，是"Word 的旧内容读回来会丢"——读一份现有 .docx 得到的是
 * 文字流（段落/标题/列表的近似），拿它当新源渲染就是**把用户那份的版式、图片、批注整段丢掉**。
 */
export const ADOPT_UNSUPPORTED =
  'edit_docx 不支持 ifChanged: "adopt"：Word 文档没法用"读回来的旧内容"重建源（文字与版式不是一一对应，重建会丢掉版式、图片与批注）。' +
  '要改这份就用 ifChanged: "overwrite"（按会话里记的源重渲染 + 应用这次的改动）；' +
  '要保留文件里手改的内容，就先用 create_docx 按新内容重做一份。'

/**
 * 应用改动（**纯函数**：给一份源结构 + 一串操作，回一份新的源结构；盘与库都不碰）。
 *
 * 每一处改动都按**当前**块序算（所以"替换第 3 块"之后再"删掉第 4 块"，删的是替换之后那个第 4 块
 * —— 与模型读回执时的直觉一致）。校验全部前置：块号越界、超块数上限，一律**抛中文人话**、一字不改。
 */
export function applyDocxOps(source: DocxSource, ops: readonly DocxEditOp[]): DocxSource {
  // 元素类型用**源结构自己那一份**（不是渲染侧的 DocxBlockInput：那份的 items/rows 是只读的，
  // 从 op.content 赋不进去）。渲染侧照旧只读视图，两边不互相将就。
  const blocks: DocxSource['blocks'] = [...source.blocks]
  let title = source.title

  for (const op of ops) {
    switch (op.op) {
      case 'replace': {
        requireBlock(op.block, blocks.length, '替换')
        blocks[op.block - 1] = op.content
        break
      }
      case 'insert': {
        if (op.after > blocks.length) throw new Error(insertRange(blocks.length))
        blocks.splice(op.after, 0, op.content)
        break
      }
      case 'delete': {
        requireBlock(op.block, blocks.length, '删除')
        blocks.splice(op.block - 1, 1)
        break
      }
      case 'meta': {
        title = op.title
        break
      }
    }

    if (blocks.length > MAX_BLOCKS) {
      throw new Error(`改完会有 ${blocks.length} 个内容块，超过上限 ${MAX_BLOCKS} 块：请拆分文档。`)
    }
  }

  return { blocks, ...(title === undefined ? {} : { title }) }
}

/** 块号越界的人话（附上"现在有几块"，模型下一轮就能改对） */
function requireBlock(block: number, total: number, verb: string): void {
  if (Number.isInteger(block) && block >= 1 && block <= total) return
  throw new Error(
    `改不了第 ${block} 个内容块：这份文档现在只有 ${total} 个内容块（块号从 1 起、按 create_docx 的 blocks 顺序，标题不算一块）。${verb}哪一块要对得上。`
  )
}

function insertRange(total: number): string {
  return `after 只能填 0（插到第一个内容块之前）到 ${total}（现在的最后一个内容块之后）。现有 ${total} 个内容块。`
}

/**
 * 回执尾部的「改后块序」：`标题〈采购管理办法〉；块序（1 起，不含标题）：1 小节〈第一章 总则〉｜2 段落〈为规范采购流程…〉…`。
 * 模型靠它对块号（"第 3 块"到底是哪一块），比让它重新 render 一遍便宜得多。
 */
export function docxOutline(source: DocxSource): string {
  const title = (source.title ?? '').trim()
  const head = title === '' ? '标题：（无）' : `标题〈${clip(title)}〉`
  const shown = source.blocks.slice(0, OUTLINE_MAX_BLOCKS).map((block, index) => {
    return `${index + 1} ${blockLabel(block)}`
  })
  const rest = source.blocks.length > shown.length ? `｜…等 ${source.blocks.length} 个内容块` : ''
  const body = shown.length === 0 ? '（没有内容块）' : shown.join('｜')
  return `${head}；块序（1 起，不含标题）：${body}${rest}`
}

/** 一块的"怎么称呼它"：小节 > 段落 > 要点（第一条 + 条数）> 表格（列 × 行） */
function blockLabel(block: DocxBlockInput): string {
  switch (block.type) {
    case 'heading':
      return `小节〈${clip(block.text)}〉`
    case 'paragraph':
      return `段落〈${clip(block.text)}〉`
    case 'bullets':
      return `要点〈${clip(block.items[0] ?? '')}〉${block.items.length} 条`
    case 'table': {
      const columns = block.headers?.length ?? block.rows[0]?.length ?? 0
      const rows = block.rows.length + (block.headers === undefined ? 0 : 1)
      return `表格〈${columns} 列 × ${rows} 行〉`
    }
  }
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= OUTLINE_HEAD_CHARS ? flat : `${flat.slice(0, OUTLINE_HEAD_CHARS)}…`
}

/** 指纹的短写法（回执里对比用；完整 sha256 太长） */
function shortSha(sha: string): string {
  return sha.slice(0, 12)
}

export interface EditDocxToolOptions {
  /** 会话↔Word 源结构（create_docx 记、这里读改）；缺省 = 没挂存储，edit_docx 回人话 */
  sources?: SessionDocxSourceStore
}

export async function createEditDocxTool(
  ctx: ToolContext,
  options: EditDocxToolOptions = {}
): Promise<Tool<DocxEditInput, string>> {
  const { createTool } = await import('@mastra/core/tools')
  const sources = options.sources

  const planInput = (input: DocxEditInput): ArtifactInput => ({ path: input.path })

  return createTool({
    id: 'edit_docx',
    description:
      'Change a Word document (.docx) this conversation already made, block by block: replace one block, insert one after a block, ' +
      'delete a block, or set the title. Send only the edits — never the whole document — and the file is rendered again for you ' +
      '(the same receipt as create_docx, plus the resulting block order). Block numbers are 1-based over the blocks create_docx took ' +
      'and never count the title. Use create_docx for a new document or a rewrite of most of it.',
    inputSchema: docxEditInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      artifactNeedsApproval(
        ctx,
        'edit_docx',
        planInput(input),
        'docx',
        '文档',
        approvalSessionOf(approval)
      ),
    execute: async (input, context) => {
      if (sources === undefined) throw new Error(NO_DOCX_SOURCE_STORE)
      // v1 明确拒绝 adopt（见 ADOPT_UNSUPPORTED）：在动任何东西之前就拒，免得"文件没被改过"时
      // 它悄悄成功一次、让模型以为这一档真的可用
      if (input.ifChanged === 'adopt') throw new Error(ADOPT_UNSUPPORTED)

      const session = sessionKey(context)
      // 与审批走同一个目标解析（"批的是 A、写的是 B"这类错配在这里被结构性排除：path 是必填的）
      const abs = artifactTarget(ctx, planInput(input), 'docx', '文档', session)

      // 整段编辑是一个事务：读源、比指纹、改、渲染、自检、落盘、记源都在同一个目标的队列里。
      // 同一份文件的两次编辑因此不会交错读到同一份旧源（否则后写的那次会覆盖前一次，丢更新）。
      return await ctx.state.runExclusive(abs, async () => {
        const record = await findRecord(sources, session, abs)
        if (record === null) throw new Error(await noSourceMessage(sources, session, input.path))

        const source = parseSource(record.sourceJson, input.path)
        const disk = await readDisk(ctx, abs)

        // 指纹：sha256 与字节数都对得上才算"还是我们渲染的那一份"；对不上就**不静默覆盖**
        const notes: string[] = []
        if (disk === null) {
          if (input.ifChanged !== 'overwrite')
            throw new Error(missingFileMessage(input.path, record))
          notes.push('盘上那份不在了：按记的源重新生成了一份')
        } else if (disk.sha256 !== record.sha256 || disk.bytes.byteLength !== record.size) {
          if (input.ifChanged === 'overwrite') {
            notes.push('盘上那份被改过：按你选的口径以源为准覆盖（手动改动没保留）')
          } else {
            throw new Error(
              changedFileMessage(input.path, record, disk.sha256, disk.bytes.byteLength)
            )
          }
        }

        const next = applyDocxOps(source, input.ops)
        const bytes = await renderDocx(next)

        // 断言（用户点名的硬要求）在这里照样逐条核：改完那一版是不是真有那句话
        const check = checkPackage(bytes, {
          kind: 'docx',
          texts: docxSampleText(next),
          assert: { contains: input.expect?.contains }
        })
        assertPackage(check)

        // 锁内落盘（**不能**在锁里调 saveArtifact：那会在同一目标上再排一次队，死锁）
        const receipt = await writeArtifactLocked(
          ctx,
          abs,
          bytes,
          `${next.blocks.length} 个内容块`,
          { session, check: check.note }
        )

        // 新的源结构 + 新指纹写回去：下一次编辑就在这一版的基础上改
        const miss = await recordDocxSource(sources, {
          threadId: session,
          path: abs,
          source: docxSourceOf(next),
          bytes
        })

        const parts = [receipt, docxOutline(next), ...notes]
        if (miss !== null) parts.push(unrecordedNote(miss))
        return parts.join('；')
      })
    }
  })
}

/** 读记录：库读写失败给人话（不是把 SQL 报错甩给模型） */
async function findRecord(
  sources: SessionDocxSourceStore,
  session: string,
  abs: string
): Promise<DocxSourceRecord | null> {
  try {
    return await sources.find(session, abs)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`读不到这个会话的 Word 源结构（本地库读写失败）：${detail}`)
  }
}

/**
 * "这个会话里没有它的源结构"—— 人话 + 下一步。顺带把这个会话里**有的那几份**报出来
 * （模型常常只是把文件名写歪了，给了清单下一轮就能改对）。
 */
async function noSourceMessage(
  sources: SessionDocxSourceStore,
  session: string,
  path: string
): Promise<string> {
  let others: string[] = []
  try {
    others = (await sources.list(session)).map((record) => record.path)
  } catch {
    // 列不出来就只说这一件事（不把"清单也读挂了"混进失败原因里）
  }
  const known =
    others.length === 0
      ? ''
      : `这个会话里记着源结构的是：${others.join('、')}（用其中那个 path 再试）。`
  return (
    `《${path}》没有可改的源结构：这个会话里没记过它（只有 create_docx 做出来的那份才记；源结构超限时也不记）。${known}` +
    '要改，就先用 create_docx 按改后的样子重做一份。'
  )
}

/** 库里那行 JSON → 源结构；坏了也回人话（不是把 zod 报错甩出去） */
function parseSource(sourceJson: string, path: string): DocxSource {
  let raw: unknown
  try {
    raw = JSON.parse(sourceJson)
  } catch {
    raw = null
  }
  const parsed = docxSourceSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `《${path}》在库里记的源结构读不出来（形状对不上）：整份重做一次 create_docx 就好。`
    )
  }
  return parsed.data
}

/** 盘上那份：没有 → null（读得到内容就顺手算指纹，读不动给人话） */
async function readDisk(
  ctx: ToolContext,
  abs: string
): Promise<{ bytes: Buffer; sha256: string } | null> {
  const stat = await statOrNull(ctx, abs)
  if (stat === null) return null
  if (stat.isDirectory()) throw new Error(`改不了 ${abs}：它是一个目录，不是文档。`)
  const bytes = await ctx.fs.readFile(abs)
  return { bytes, sha256: sha256Of(bytes) }
}

/** 文件不在了：说清"我记的是哪一份"，给两条出口 */
function missingFileMessage(path: string, record: { blocks: number; size: number }): string {
  return (
    `《${path}》在盘上找不到了（我记着的是 ${record.blocks} 个内容块、${record.size} 字节的那一份）—— 是你删了还是移走了？` +
    '我没有动任何文件。两个出口：' +
    '① 按记的源结构在这个路径重新生成一份（再应用这次的改动）：ifChanged: "overwrite"；' +
    '② 这条路径就别要了，用 create_docx 另做一份。'
  )
}

/** 文件被改过：说清两边的指纹，给两条出口（默认什么都不做） */
function changedFileMessage(
  path: string,
  record: { blocks: number; size: number; sha256: string },
  diskSha: string,
  diskSize: number
): string {
  return (
    `《${path}》已经不是上一版生成的那份了：我记的是 ${record.blocks} 个内容块 / ${record.size} 字节 / sha256 ${shortSha(record.sha256)}，` +
    `盘上现在是 ${diskSize} 字节 / sha256 ${shortSha(diskSha)}。我没有动它 —— 你要哪个口径？` +
    '① 以源为准覆盖（把你手动改的那份丢掉，按我记的结构重生成 + 应用这次改动）：ifChanged: "overwrite"；' +
    '② 谁也别动：先问用户，或者把新内容整份交给 create_docx 另起一份。' +
    '（`ifChanged: "adopt"` 这一档不支持：Word 的旧内容读回来重建会丢版式、图片与批注。）'
  )
}
