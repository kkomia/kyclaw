/**
 * read 工具：读授权工作区内的文本文件。
 *
 * - 行窗口：offset/limit（1 基行号）；越界的 offset 明确报错，不给静默空内容。
 * - 截断契约：文件 > 256KB 只读前 256KB 并附提示。**截断点在 UTF-8 字符边界上收口**
 *   （StringDecoder 丢弃尾部不完整的多字节序列），不会切出半个汉字/emoji。
 * - 读过的路径按会话记进 ToolState —— edit 的"未读先改"靠这份记录。
 */
import { StringDecoder } from 'node:string_decoder'
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

/** read 的输出上限：超过就截断（spec §5.1"输出截断限额"） */
export const READ_MAX_BYTES = 256 * 1024

export const readInputSchema = z.object({
  path: z.string().min(1).describe('文件路径；相对路径以授权工作区为基准'),
  offset: z.number().int().min(1).optional().describe('起始行号（从 1 开始）'),
  limit: z.number().int().min(1).optional().describe('最多读多少行')
})

export type ReadInput = z.infer<typeof readInputSchema>

export async function createReadTool(ctx: ToolContext): Promise<Tool<ReadInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'read',
    description:
      '读取授权工作区内的文本文件。offset/limit 按行取窗口（从 1 开始）；文件超过 256KB 时只返回前 256KB 并注明截断。改动文件前先用它看原文。',
    inputSchema: readInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'read', input, approvalSessionOf(approval)),
    execute: async (input, context) => {
      const { abs } = toolTarget(ctx, input.path, sessionKey(context))
      const fileStat = await statOrNull(ctx, abs)
      if (fileStat === null || !fileStat.isFile()) {
        throw new Error(`read 失败：${input.path} 不存在或不是文件（目录请用 glob 列出）`)
      }

      const clipped = fileStat.size > READ_MAX_BYTES
      const bytes = await ctx.fs.readFile(abs, clipped ? READ_MAX_BYTES : undefined)
      const text = new StringDecoder('utf8').write(bytes)

      const lines = text.split('\n')
      const offset = input.offset ?? 1
      if (offset > lines.length) {
        throw new Error(`offset=${offset} 超出文件行数：${input.path} 共 ${lines.length} 行`)
      }
      const from = offset - 1
      const to =
        input.limit === undefined ? lines.length : Math.min(lines.length, from + input.limit)
      const body = lines.slice(from, to).join('\n')

      ctx.state.markRead(sessionKey(context), abs)

      const notes: string[] = []
      if (clipped) {
        notes.push(`[已截断：文件共 ${fileStat.size} 字节，只显示前 ${READ_MAX_BYTES} 字节]`)
      }
      if (offset > 1 || to < lines.length) {
        const total = clipped ? '' : `，文件共 ${lines.length} 行`
        notes.push(`[只显示第 ${from + 1}-${to} 行${total}]`)
      }
      return notes.length === 0 ? body : `${body}\n\n${notes.join('\n')}`
    }
  })
}
