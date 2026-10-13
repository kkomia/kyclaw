/**
 * edit_ppt：在**上一版**产出物的基础上改（round 76）—— 模型只发增量，不发整份。
 *
 * 为什么要有它（用户判断 + 实测）：`create_ppt` 每次都要模型把**完整** `slides` 重发一遍，
 * 工具层没有"只改第 3 页"的入口。一次"简单做 PPT"的任务里，自检后改版 4 次 = 4 次整份重生成，
 * 输出 token 7.9K → 20.2K、成本 ¥0.0242 → ¥0.0438（1.8×）。钱花在**模型输出**上，不在本地渲染上，
 * 所以出路是"只让模型发改动"，而不是"去改 pptx 的 XML 做微创"（那条路易碎，且会绕开自检/断言链路）。
 *
 * 落盘口径：**仍然整份重新渲染一次**（本地的 pptxgenjs，不花 token）。源结构从
 * `session_ppt_sources` 读（create_ppt 落盘时记的，见 mastra/session-ppt-sources.ts），
 * 改完再把新的源结构 + 新文件指纹写回去 —— 下一次编辑就在这一次的基础上改。
 *
 * 四个操作（每个都能表达"改哪一页 + 改什么"）：
 *   - `replace`：换掉某一页的内容（页数不变）；
 *   - `insert`：在某一页之后插一页；
 *   - `delete`：删掉某一页（封面删不了）；
 *   - `meta`：改封面标题 / 副标题 / 配色模板（"改封面这类单字段"）。
 * 页号一律按 **PowerPoint 的页序**（1 起、**含封面**）—— 与 `expect.contains[].page` 同一把尺子。
 *
 * 三条**干净失败**（都不动盘上的文件、都说清下一步该怎么走）：
 *   ① 这个会话里没有它的源结构（没做过 / 库里没记上）→ 引导用 `create_ppt` 重做一份；
 *   ② 盘上那份和上一版**指纹对不上**（用户手改过 / 删过）→ 列出入口（以源为准覆盖 / 以文件为准
 *      重建源 / 谁也别动），默认**停**，绝不静默覆盖用户的改动；
 *   ③ 应用重启后照样能改 —— 源结构落库（不是内存），换一个进程读同一张表。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { sha256Of, type SessionPptSourceStore } from '../session-ppt-sources'
import { assertPackage, checkPackage, packageSlideTexts } from './artifact-check'
import {
  artifactNeedsApproval,
  artifactTarget,
  saveArtifact,
  type ArtifactInput
} from './artifacts'
import { approvalSessionOf, sessionKey, statOrNull, type ToolContext } from './guard'
import { lookupTemplate, PPT_TEMPLATE_NAMES } from '../../shared/ppt-templates'
import {
  MAX_SLIDES,
  PPT_PAGE_COVER,
  PPT_PAGE_PLACEHOLDER,
  planPages,
  pptDeckSourceSchema,
  pptExpectSchema,
  pptInputSchema,
  pptSampleText,
  pptSlideSchema,
  renderPptx,
  resolveLayout,
  type PptDeckSource,
  type PptLayout,
  type PptSlide,
  type PptSlideInput
} from './ppt'

/** 一次调用最多几处改动（改十几处的任务是"重做"，该走 create_ppt） */
export const MAX_PPT_OPS = 40

/** 回执里"改后页序"每页标题的截断长度（回执要短，认得出来是哪一页就够了） */
const OUTLINE_HEAD_CHARS = 16

export const pptEditOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('replace'),
      page: z
        .number()
        .int()
        .positive()
        .describe('Page to overwrite, 1-based as PowerPoint counts pages (the cover is page 1)'),
      slide: pptSlideSchema
    })
    .describe('Overwrite one page with new content; the page count does not change'),
  z
    .object({
      op: z.literal('insert'),
      after: z
        .number()
        .int()
        .min(0)
        .describe(
          'Add the page right after this page number; 0 = immediately after the cover, before the first content page'
        ),
      slide: pptSlideSchema
    })
    .describe('Add one page to the deck'),
  z
    .object({
      op: z.literal('delete'),
      page: z
        .number()
        .int()
        .positive()
        .describe('Page to remove, 1-based; the cover cannot be removed')
    })
    .describe('Remove one page from the deck'),
  z
    .object({
      op: z.literal('meta'),
      title: pptInputSchema.shape.title.describe(
        'New cover title; an empty string drops the cover'
      ),
      subtitle: pptInputSchema.shape.subtitle,
      theme: pptInputSchema.shape.theme.describe(
        `New colour theme: ${PPT_TEMPLATE_NAMES.join(' / ')}`
      )
    })
    .describe('Change the deck itself: cover title, cover subtitle or colour theme')
])

export type PptEditOp = z.infer<typeof pptEditOpSchema>

export const pptEditInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'The .pptx to change, relative to the session workspace — the same path create_ppt reported'
    ),
  ops: z
    .array(pptEditOpSchema)
    .min(1)
    .max(MAX_PPT_OPS, `一次最多改 ${MAX_PPT_OPS} 处，全篇重写请用 create_ppt`)
    .describe('Edits applied in order; send only the pages you change, never the whole deck'),
  ifChanged: z
    .enum(['stop', 'overwrite', 'adopt'])
    .optional()
    .describe(
      'Only used when the file on disk is no longer the one we rendered: stop (default) reports both ways out; ' +
        'overwrite regenerates from the stored deck (manual edits to the file are lost); adopt rebuilds from the file text (layout is re-done from content)'
    ),
  expect: pptExpectSchema.optional()
})

export type PptEditInput = z.infer<typeof pptEditInputSchema>

/** 本部署没挂源结构存储时的回执（不是"工具不存在"，而是"这条链路没接上"） */
export const NO_PPT_SOURCE_STORE =
  'edit_ppt 用不了：这个运行环境没有挂 PPT 源结构存储。请用 create_ppt 把整份内容重做一遍（要改哪几页就按改后的样子写）。'

/** 版式的中文短名（回执的"改后页序"用） */
const LAYOUT_LABEL: Record<PptLayout, string> = {
  cover: '封面',
  section: '章节',
  content: '要点',
  stats: '数字',
  table: '表格',
  'two-column': '分栏',
  quote: '引言',
  closing: '结尾'
}

/**
 * 物理页序（1 起、含封面）→ 源 `slides` 下标；封面 = PPT_PAGE_COVER，占位页 = PPT_PAGE_PLACEHOLDER，
 * 页号越界 = null。**唯一一份映射**：`replace` / `insert` / `delete` 全走它，不许各算一份。
 */
export function slideIndexOfPage(source: PptDeckSource, page: number): number | null {
  const plan = planPages(source)
  if (plan.length === 0) return page === 1 ? PPT_PAGE_PLACEHOLDER : null
  return plan[page - 1]?.slideIndex ?? null
}

/** 这份源结构渲染出来有几页（与 renderPptx 同一口径：排不出内容时有一张占位页） */
export function pageCountOf(source: PptDeckSource): number {
  const plan = planPages(source)
  return plan.length === 0 ? 1 : plan.length
}

/**
 * 应用改动（**纯函数**：给一份源结构 + 一串操作，回一份新的源结构；盘与库都不碰）。
 *
 * 每一处改动都按**当前**页序重新映射一次（所以 "替换第 3 页" 之后再 "删掉第 4 页"，
 * 删的是替换之后那个第 4 页 —— 与模型读回执时的直觉一致）。
 * 校验全部前置：页号越界、改封面、新页排不出内容、超页数上限，一律**抛中文人话**、一个字都不改。
 */
export function applyPptOps(source: PptDeckSource, ops: readonly PptEditOp[]): PptDeckSource {
  const slides: PptSlide[] = [...source.slides]
  /** 覆盖 deck 级字段（title/subtitle/theme）；undefined 的字段不许顶掉源里原有的值 */
  let meta: { title?: string; subtitle?: string; theme?: PptDeckSource['theme'] } = {}

  for (const op of ops) {
    const current: PptDeckSource = { ...source, ...meta, slides }
    const total = pageCountOf(current)

    switch (op.op) {
      case 'replace': {
        const index = slideIndexOfPage(current, op.page)
        if (index === null) throw new Error(outOfRange(op.page, total))
        if (index === PPT_PAGE_COVER) throw new Error(COVER_EDIT_HINT)
        requireRenderable(op.slide, `替换进来的第 ${op.page} 页`)
        if (index === PPT_PAGE_PLACEHOLDER) slides.splice(0, slides.length, op.slide)
        else slides[index] = op.slide
        break
      }
      case 'insert': {
        if (op.after > total) throw new Error(insertRange(total))
        requireRenderable(op.slide, `插进来的这一页（插在第 ${op.after} 页之后）`)
        // after = 0 → 源 slides 的最前面（封面之后、第一个内容页之前）；
        // 目标是封面（-1）时是同一个位置；目标是占位页时只能落在末尾
        const index = op.after === 0 ? PPT_PAGE_COVER : slideIndexOfPage(current, op.after)
        const at = index === null || index === PPT_PAGE_PLACEHOLDER ? slides.length : index + 1
        slides.splice(at, 0, op.slide)
        break
      }
      case 'delete': {
        const index = slideIndexOfPage(current, op.page)
        if (index === null) throw new Error(outOfRange(op.page, total))
        if (index === PPT_PAGE_COVER) throw new Error(COVER_EDIT_HINT)
        if (index === PPT_PAGE_PLACEHOLDER) {
          throw new Error(
            `第 ${op.page} 页是这张空演示文稿的占位页（源结构里没有内容页），删不动：要改就整份重做。`
          )
        }
        slides.splice(index, 1)
        break
      }
      case 'meta': {
        // 逐字段照抄（显式 undefined 不许把源里原有的值顶掉：absent 与 "给了个 undefined" 要分清）
        const fields: { title?: string; subtitle?: string; theme?: PptDeckSource['theme'] } = {}
        if (op.title !== undefined) fields.title = op.title
        if (op.subtitle !== undefined) fields.subtitle = op.subtitle
        if (op.theme !== undefined) {
          if (lookupTemplate(op.theme) === undefined) {
            throw new Error(
              `没有「${op.theme}」这套模板。可用的十套：${PPT_TEMPLATE_NAMES.join(' / ')}。`
            )
          }
          fields.theme = op.theme
        }
        if (Object.keys(fields).length === 0) {
          throw new Error(
            'meta 至少要给一个字段：title（封面标题）/ subtitle（封面副标题）/ theme（配色模板）。'
          )
        }
        meta = { ...meta, ...fields }
        break
      }
    }

    if (slides.length > MAX_SLIDES) {
      throw new Error(`改完会有 ${slides.length} 页，超过上限 ${MAX_SLIDES} 页：请拆分演示文稿。`)
    }
  }

  return { ...source, ...meta, slides }
}

/** 页号越界的人话（附上"现在有几页"，模型下一轮就能改对） */
function outOfRange(page: number, total: number): string {
  return `改不了第 ${page} 页：这份演示文稿现在只有 ${total} 页（页号含封面，第 1 页是封面）。`
}

const COVER_EDIT_HINT =
  '第 1 页是封面，它由文档标题生成，不能按普通页替换/删除：改封面用 { op: "meta", title / subtitle }。'

function insertRange(total: number): string {
  return `after 只能填 0（封面之后、第一个内容页之前）到 ${total}（现在的最后一页）。`
}

/** 新页必须排得出版式（否则它会被静默跳过、页数悄悄少一页 —— 那是"改一页"里最坏的一种意外） */
function requireRenderable(slide: PptSlide, where: string): void {
  if (resolveLayout(slide) === null) {
    throw new Error(
      `${where}排不出任何版式：至少要给 title / bullets / stats / table / columns / quote / section 之一。`
    )
  }
}

/**
 * 以**文件为准**重建源（文件被用户手改过时的第二条路）：把包里的逐页文字读回来。
 *
 * 认得的只有**文字**：每页第一个段落当标题、其余当要点（去掉页脚那两格：页码与文档标题），
 * 封面那页的第二个段落当副标题。版式由内容重新自动挑 —— 也就是说，用户手改的**版式/配色细节会丢**。
 * 这一点在失败回执里写明，不装作无损。
 *
 * `base` 只用来判断"这份演示文稿当初有没有封面"以及页脚左边那格是什么（= 文档标题）。
 */
export function adoptSourceFromPackage(
  bytes: Uint8Array,
  base: PptDeckSource,
  path = '这份演示文稿'
): PptDeckSource {
  const pages = packageSlideTexts(bytes)
  const hadCover = (base.title ?? '').trim() !== ''
  const footerTitle = (base.title ?? '').trim()

  const slideOf = (page: { page: number; text: string }): PptSlide => {
    const paragraphs = page.text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    // 页脚那两格：先摘页码（纯数字），再摘文档标题（与 create_ppt 的 footerLeft 同一处口径）
    if (/^\d{1,3}$/.test(paragraphs[paragraphs.length - 1] ?? '')) paragraphs.pop()
    if (paragraphs[paragraphs.length - 1] === footerTitle) paragraphs.pop()

    const title = paragraphs[0]
    const bullets = paragraphs.slice(1).map((line) => line.replace(/^●\s*/, ''))
    return title === undefined ? {} : bullets.length === 0 ? { title } : { title, bullets }
  }

  const cover = pages[0]
  const title = hadCover ? coverParagraphs(cover).title : undefined
  const subtitle = hadCover ? coverParagraphs(cover).subtitle : undefined
  const slides = (hadCover ? pages.slice(1) : pages).map(slideOf)

  const rebuilt: PptDeckSource = {
    ...(title === undefined ? {} : { title }),
    ...(subtitle === undefined ? {} : { subtitle }),
    theme: base.theme,
    slides
  }

  // 重建后必须与文件里一样多页：少一页说明有一页的文字我们没认出来（空页 / 纯图形页）。
  // 也拦下"只有封面"的那种：源结构至少要有一个内容页（形状与 create_ppt 的入参一致）。
  const rebuiltPages = pageCountOf(rebuilt)
  if (rebuiltPages !== pages.length || slides.length === 0) {
    throw new Error(
      `《${path}》读回来的逐页文字重建后有 ${rebuiltPages} 页、文件里 ${pages.length} 页（内容页 ${slides.length} 个），对不上 —— ` +
        '多半有页面没有文字（或者版式认不出来）。这条路改不动它：要么用 ifChanged: "overwrite" 以源为准覆盖，' +
        '要么用 create_ppt 按新内容另做一份。'
    )
  }

  return rebuilt
}

/** 封面的两个段落（标题 / 副标题）；页里没文字给 undefined */
function coverParagraphs(page: { text: string } | undefined): {
  title?: string
  subtitle?: string
} {
  const paragraphs = (page?.text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return { title: paragraphs[0], subtitle: paragraphs[1] }
}

/**
 * 回执尾部的「改后页序」：`1 封面〈年度规划〉｜2 要点〈用户规模〉…`。
 * 模型靠它对页码（"第 3 页"到底是哪一页），比让它重新 render 一遍便宜得多。
 */
export function pptOutline(source: PptDeckSource): string {
  const plan = planPages(source)
  if (plan.length === 0) return '改后页序：1 占位（没有内容页）'
  return `改后页序：${plan
    .map((page, index) => {
      const head = pageHead(page.slide)
      const label = LAYOUT_LABEL[page.layout]
      return head === '' ? `${index + 1} ${label}` : `${index + 1} ${label}〈${head}〉`
    })
    .join('｜')}`
}

/** 一页的"怎么称呼它"：标题 > 章节名 > 引言 > 首条要点 > 首张数字卡（都取不到就给空串） */
function pageHead(slide: PptSlideInput): string {
  const candidates = [
    slide.title,
    slide.section,
    slide.quote?.text,
    slide.bullets?.[0],
    slide.stats?.[0]?.value
  ]
  for (const candidate of candidates) {
    const text = candidate?.trim() ?? ''
    if (text !== '') return clip(text)
  }
  return ''
}

function clip(text: string): string {
  return text.length <= OUTLINE_HEAD_CHARS ? text : `${text.slice(0, OUTLINE_HEAD_CHARS)}…`
}

/** 指纹的短写法（回执里对比用；完整 sha256 太长） */
function shortSha(sha: string): string {
  return sha.slice(0, 12)
}

export interface EditPptToolOptions {
  /** 会话↔PPT 源结构（create_ppt 记、这里读改）；缺省 = 没挂存储，edit_ppt 回人话 */
  sources?: SessionPptSourceStore
}

export async function createEditPptTool(
  ctx: ToolContext,
  options: EditPptToolOptions = {}
): Promise<Tool<PptEditInput, string>> {
  const { createTool } = await import('@mastra/core/tools')
  const sources = options.sources

  const planInput = (input: PptEditInput): ArtifactInput => ({ path: input.path })

  return createTool({
    id: 'edit_ppt',
    description:
      'Change pages of a .pptx this conversation already made: replace one page, insert one after a page, delete a page, ' +
      'or set the cover title / subtitle / theme. Send only the edits — never the whole deck — and the file is rendered again for you ' +
      '(same receipt as create_ppt, plus the resulting page order). Page numbers are PowerPoint page numbers, cover included. ' +
      'Use create_ppt for a new deck or a rewrite of most of it.',
    inputSchema: pptEditInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      artifactNeedsApproval(
        ctx,
        'edit_ppt',
        planInput(input),
        'pptx',
        '演示文稿',
        approvalSessionOf(approval)
      ),
    execute: async (input, context) => {
      if (sources === undefined) throw new Error(NO_PPT_SOURCE_STORE)

      const session = sessionKey(context)
      // 与审批走同一个目标解析（"批的是 A、写的是 B"这类错配在这里被结构性排除：path 是必填的）
      const abs = artifactTarget(ctx, planInput(input), 'pptx', '演示文稿', session)

      const record = await findRecord(sources, session, abs)
      if (record === null) throw new Error(await noSourceMessage(sources, session, input.path))

      const source = parseSource(record.sourceJson, input.path)
      const disk = await readDisk(ctx, abs)

      // 指纹：内容 sha256 对不上（或文件不在了）就**不静默覆盖**，让调用方显式选口径
      let base = source
      const notes: string[] = []
      if (disk === null) {
        if (input.ifChanged !== 'overwrite') throw new Error(missingFileMessage(input.path, record))
        notes.push('盘上那份不在了：按记的源重新生成了一份')
      } else if (disk.sha256 !== record.sha256) {
        if (input.ifChanged === 'overwrite') {
          notes.push('盘上那份被改过：按你选的口径以源为准覆盖（手动改动没保留）')
        } else if (input.ifChanged === 'adopt') {
          base = adoptSourceFromPackage(disk.bytes, source, input.path)
          notes.push('盘上那份被改过：以文件里的文字为准重建了源，版式按内容重排')
        } else {
          throw new Error(
            changedFileMessage(input.path, record, disk.sha256, disk.bytes.byteLength)
          )
        }
      }

      const next = applyPptOps(base, input.ops)
      // 模板：源结构里记的是**上一版实际用的那套**（create_ppt 落的 rendered.theme），改版沿用
      const rendered = await renderPptx(next)

      const check = checkPackage(rendered.data, {
        kind: 'pptx',
        slides: rendered.slides,
        texts: pptSampleText(next),
        assert: { count: input.expect?.pages, contains: input.expect?.contains }
      })
      assertPackage(check)

      const receipt = await saveArtifact(
        ctx,
        abs,
        rendered.data,
        `${rendered.slides} 页演示文稿，模板「${rendered.theme}」`,
        { session, check: check.note }
      )

      // 新的源结构 + 新指纹写回去：下一次编辑就在这一版的基础上改
      let stored = true
      try {
        await sources.record({
          threadId: session,
          path: abs,
          sourceJson: JSON.stringify(next),
          pages: rendered.slides,
          sha256: sha256Of(rendered.data),
          size: rendered.data.byteLength
        })
      } catch (error: unknown) {
        stored = false
        console.warn('[kyclaw] edit_ppt 的源结构没能落库（下次改它会被当成"文件被改过"）', error)
      }

      const parts = [receipt, pptOutline(next), ...notes]
      if (!stored) parts.push('（这次改动没能记进会话：下次改它要先选 ifChanged）')
      return parts.join('；')
    }
  })
}

/** 读记录：库读写失败给人话（不是把 SQL 报错甩给模型） */
async function findRecord(
  sources: SessionPptSourceStore,
  session: string,
  abs: string
): Promise<Awaited<ReturnType<SessionPptSourceStore['find']>>> {
  try {
    return await sources.find(session, abs)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`读不到这个会话的 PPT 源结构（本地库读写失败）：${detail}`)
  }
}

/**
 * "这个会话里没有它的源结构"—— 人话 + 下一步。顺带把这个会话里**有的那几份**报出来
 * （模型常常只是把文件名写歪了，给了清单下一轮就能改对）。
 */
async function noSourceMessage(
  sources: SessionPptSourceStore,
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
    `《${path}》没有可改的源结构：这个会话里没记过它（只有 create_ppt 做出来的那份才记）。${known}` +
    '要改，就先用 create_ppt 按改后的样子重做一份。'
  )
}

/** 库里那行 JSON → 源结构；坏了也回人话（不是把 zod 报错甩出去） */
function parseSource(sourceJson: string, path: string): PptDeckSource {
  let raw: unknown
  try {
    raw = JSON.parse(sourceJson)
  } catch {
    raw = null
  }
  const parsed = pptDeckSourceSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `《${path}》在库里记的源结构读不出来（形状对不上）：整份重做一次 create_ppt 就好。`
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
  if (stat.isDirectory()) throw new Error(`改不了 ${abs}：它是一个目录，不是演示文稿。`)
  const bytes = await ctx.fs.readFile(abs)
  return { bytes, sha256: sha256Of(bytes) }
}

/** 文件不在了：说清"我记的是哪一份"，给两条出口 */
function missingFileMessage(path: string, record: { pages: number; size: number }): string {
  return (
    `《${path}》在盘上找不到了（我记着的是 ${record.pages} 页、${record.size} 字节的那一份）—— 是你删了还是移走了？` +
    '我没有动任何文件。两个出口：' +
    '① 按记的源结构在这个路径重新生成一份（再应用这次的改动）：ifChanged: "overwrite"；' +
    '② 这条路径就别要了，用 create_ppt 另做一份。'
  )
}

/** 文件被改过：说清两边的指纹，给三条出口（默认什么都不做） */
function changedFileMessage(
  path: string,
  record: { pages: number; size: number; sha256: string },
  diskSha: string,
  diskSize: number
): string {
  return (
    `《${path}》已经不是上一版生成的那份了：我记的是 ${record.pages} 页 / ${record.size} 字节 / sha256 ${shortSha(record.sha256)}，` +
    `盘上现在是 ${diskSize} 字节 / sha256 ${shortSha(diskSha)}。我没有动它 —— 你要哪个口径？` +
    '① 以源为准覆盖（把你手动改的那份丢掉，按我记的结构重生成 + 应用这次改动）：ifChanged: "overwrite"；' +
    '② 以文件为准重建源（只认回文件里的文字当新源，再用这次改动；版式会按内容重排，手改的版式细节会丢）：ifChanged: "adopt"；' +
    '③ 谁也别动：先问用户，或者把新内容整份交给 create_ppt 另起一份。'
  )
}
