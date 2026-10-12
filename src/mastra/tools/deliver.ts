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
 *   - 输出是**结构化对象**（不是回执字符串）：渲染端的交付卡按字段渲染（`path` / `name` /
 *     `size` / `mimeType`），`message` 才是给模型看的人话回执。全仓其它工具输出字符串，
 *     这里是唯一例外 —— 卡片要的是字段，从回执文本里反解等于让 UI 猜。
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
    .describe('要交付的文件路径；相对路径以当前会话的工作区为基准（必须已经在工作区里）'),
  note: z.string().max(200).optional().describe('一句话说明这是什么文件（可选，显示在交付卡上）')
})

export type DeliverInput = z.infer<typeof deliverInputSchema>

/** 交付卡的字段（工具输出；渲染端按同一形状防御式地读，见 renderer 的 chat/deliverable.ts） */
export const deliverResultSchema = z.object({
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

export type DeliverResult = z.infer<typeof deliverResultSchema>

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
      '把工作区里的文件交付给用户看：对话里会出现一张文件卡，用户可以直接预览、复制路径或在文件资源管理器里定位。' +
      '产出物、整理好的材料都该用它交付，别只报一个路径。只交付**已经在工作区里**的文件（外部文件先用 bash 复制进工作区）；' +
      '不读内容、不改动文件。',
    inputSchema: deliverInputSchema,
    outputSchema: deliverResultSchema,
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'deliver_file', input, approvalSessionOf(approval)),
    execute: async (input, context) => {
      const { abs, workspace } = toolTarget(ctx, input.path, sessionKey(context))
      const fileStat = await statOrNull(ctx, abs)
      if (fileStat === null) {
        throw new Error(`deliver_file 失败：${input.path} 不存在（可以先用 glob 找一下它现在在哪）`)
      }
      if (fileStat.isDirectory()) {
        throw new Error(
          `deliver_file 失败：${input.path} 是一个目录，交付的是文件（目录内容可以先用 glob 列给用户看）`
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
