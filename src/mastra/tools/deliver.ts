/**
 * deliver_file 工具：把工作区里**已经存在**的文件交付给用户看（读类，免审批）。
 *
 * 为什么需要它：模型的产出（报告 / 表格 / 文档）与它整理好的文件原本只说得出路径，用户还得
 * 自己去工作台里翻。这个工具是"交付"这个动作的接口 —— 调用后对话里出现一张文件卡，
 * 用户可以直接预览（右侧工作台新开预览标签）、复制路径或在文件资源管理器里定位。
 *
 * 口径：
 *   - **只 stat，不读内容、不写盘**，所以是 read 档（classify 里点名，免审批，见 main/permission/classify.ts）；
 *   - 目标走 guard 的引擎，根与 read 同一套（会话根；越界 fail closed）——不是"绕过路径校验的后门"；
 *   - 只交付工作区里的文件（外部文件先复制进来）；目录 / 越界 / 不存在都给人话错误，
 *     并捎一句下一步（模型据此换做法，不必反复换写法试）；
 *   - 交付成功时输出**结构化对象**（不是回执字符串）：渲染端的交付卡按字段渲染（`path` / `name` /
 *     `size` / `mimeType`），`message` 才是给模型看的人话回执。全仓其它工具输出字符串，
 *     这里是唯一例外 —— 卡片要的是字段，从回执文本里反解等于让 UI 猜。
 *     唯一的另一态是"超出单次上界"那句回执（纯字符串），见 deliverResultSchema 的说明。
 *
 * round 70 补的三条交付语义（说给模型听，写在 description 里）：
 *   ① **交付不复制字节**：交付的是**原文件本身**，它在工作区里原地不动。工具不会移动 / 改名 /
 *      清理源文件，所以"交付完把原件删掉"这一步得模型自己决定要不要做（默认不做）；
 *   ② **中间产物不交付**：页图目录（`*_页图/`）、校验记录（`checks.json` 之类）与临时脚本都不进
 *      交付 —— 它们是过程证据，不是成品（技能层同一口径，这里是防"绕过技能时乱交"的那一道）；
 *   ③ **单次上界 = 一件**：渲染端一张卡就是一个文件（`DeliverableCard` 只读单份字段），所以
 *      一次调用只交付一件，多件就分多次调用。给了多个路径时**不抛错**，回一句人话回执说清
 *      "这次一件都没交付、该拆成几次"——抛错会被模型当成工具坏了，回执才是可执行的下一步。
 */
import { basename, relative, sep } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import {
  approvalSessionOf,
  needsApproval,
  sessionKey,
  statOrNull,
  toolTarget,
  type ToolContext
} from './guard'

export const deliverInputSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Path of the single file to deliver; relative paths resolve against the session workspace and the file must already be inside it'
    ),
  note: z
    .string()
    .max(200)
    .optional()
    .describe('One sentence describing the file; optional and shown on the delivery card')
})

export type DeliverInput = z.infer<typeof deliverInputSchema>

/** 单次交付的上界（round 70）：渲染端一张交付卡就是一个文件，多件只能多次调用 */
export const DELIVER_MAX_PER_CALL = 1

/** 交付卡的字段（工具输出；渲染端按同一形状防御式地读，见 renderer 的 chat/deliverable.ts） */
export const deliveredFileSchema = z.object({
  /** 工作区相对路径（正斜杠） */
  path: z.string(),
  /** 文件名（不含目录） */
  name: z.string(),
  /** 字节数 */
  size: z.number(),
  /** 认得出扩展名时给的 MIME；认不出就没有这个字段（不猜） */
  mimeType: z.string().optional(),
  /** 交付说明（模型给的 note，原样带回） */
  note: z.string().optional(),
  /** 给模型的人话回执 */
  message: z.string()
})

/**
 * 工具的完整输出：**交付成功 = 卡片字段**；**超出单次上界 = 一句人话回执（纯字符串）**。
 *
 * 为什么回执用字符串而不是"字段缺省的卡片对象"：渲染端的 `deliverableOf` 拿不到 `path`/`name`
 * 就把这一条回落成**普通工具行**，那一行的结果预览是 `formatValue` —— 字符串原样显示，
 * 对象会显示成 JSON。回执是给人看的，不该是 `{"message":"…"}`。所以这里取两态联合，
 * 与全仓其它工具"输出字符串"的口径也对得上。
 */
export const deliverResultSchema = z.union([deliveredFileSchema, z.string()])

export type DeliveredFile = z.infer<typeof deliveredFileSchema>
export type DeliverResult = z.infer<typeof deliverResultSchema>

/**
 * 目标串里换行 = 模型一次给了多件（Windows 的文件名不含换行，这个判据不会误伤单个路径）。
 * 逗号**不能**当分隔符：文件名里合法（`报告,终稿.md`），按它切会把一个文件拆成两个。
 */
function listedPaths(path: string): string[] {
  return path
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** 认得出的扩展名 → MIME（只列常见档；认不出就如实不给，不编一个假的） */
const MIME_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  zip: 'application/zip'
}

/** 文件名 → MIME（按最后一个扩展名；没有扩展名或认不出回 undefined） */
export function mimeTypeOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  // dot === 0 是 ".gitignore" 这种点文件：不当扩展名看
  if (dot <= 0 || dot === name.length - 1) return undefined
  return MIME_TYPES[name.slice(dot + 1).toLowerCase()]
}

export async function createDeliverFileTool(
  ctx: ToolContext
): Promise<Tool<DeliverInput, DeliverResult>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'deliver_file',
    description:
      'Deliver one workspace file to the user: a card appears in the conversation, with preview, path copy and reveal in the file explorer. ' +
      'Delivers the original file in place and copies, moves, renames or cleans up nothing, so copy a file from elsewhere into the workspace with bash first. ' +
      'One file per call. Not for intermediates such as page-image directories (*_页图/), check records like checks.json or temporary scripts. ' +
      'Stats only: reads nothing, changes nothing, needs no approval.',
    inputSchema: deliverInputSchema,
    outputSchema: deliverResultSchema,
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'deliver_file', input, approvalSessionOf(approval)),
    execute: async (input, context) => {
      // 单次上界（round 70）：给多了回一句可执行的人话，不抛错（抛错会被当成工具坏了）
      const listed = listedPaths(input.path)
      if (listed.length > DELIVER_MAX_PER_CALL) {
        const items = listed.map((item) => `\n- ${item}`).join('')
        return (
          `deliver_file 一次只交付一件（对话里一张卡就是一个文件），这次给了 ${listed.length} 个路径，` +
          `**一件都没交付**：${items}\n请按上面的顺序分成 ${listed.length} 次调用。` +
          '中间产物（页图目录 / 校验记录 / 临时脚本）不要交付。'
        )
      }

      // 上界内就是一件：用归一化后的那一条（模型常在路径尾带个换行），空格只在两端被去掉
      const target = listed[0] ?? input.path
      const { abs, workspace } = toolTarget(ctx, target, sessionKey(context))
      const fileStat = await statOrNull(ctx, abs)
      if (fileStat === null) {
        throw new Error(`deliver_file 失败：${target} 不存在（可以先用 glob 找一下它现在在哪）`)
      }
      if (fileStat.isDirectory()) {
        throw new Error(
          `deliver_file 失败：${target} 是一个目录，交付的是文件（目录内容可以先用 glob 列给用户看）`
        )
      }

      const name = basename(abs)
      const relPath = relative(workspace.path, abs).split(sep).join('/')
      const note = input.note?.trim() ?? ''
      const mimeType = mimeTypeOf(name)

      return {
        path: relPath,
        name,
        size: fileStat.size,
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(note === '' ? {} : { note }),
        message: `已交付 ${relPath}（${fileStat.size} 字节）：对话里已经出现这张交付卡，用户可以直接预览`
      }
    }
  })
}
