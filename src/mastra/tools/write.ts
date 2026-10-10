/**
 * write 工具：在工作区内创建或整文件覆盖（父目录自动建）。
 *
 * - 走 guard（路径只认引擎给的 abs）；与 edit 共用同文件队列，避免"写一半被另一个写覆盖"。
 * - 写入后把文件记进会话的已读记录：内容对模型来说完全已知，后续 edit 不必再 read 一遍。
 * - 审批由 requireApproval 挂上（写类默认询问；目标工作区 full 时放行，见 guard.needsApproval）。
 */
import { dirname } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { needsApproval, sessionKey, statOrNull, toolTarget, type ToolContext } from './guard'

export const writeInputSchema = z.object({
  path: z.string().min(1).describe('文件路径；相对路径以授权工作区为基准'),
  content: z.string().describe('要写入的完整内容（覆盖原文件）')
})

export type WriteInput = z.infer<typeof writeInputSchema>

export async function createWriteTool(ctx: ToolContext): Promise<Tool<WriteInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'write',
    description:
      '在授权工作区内创建或整体覆盖一个文本文件（父目录会自动创建）。覆盖已有文件前先用 read 看内容；改动旧文件优先用 edit 做精确替换。',
    inputSchema: writeInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) => needsApproval(ctx, 'write', input),
    execute: async (input, context) => {
      const { abs } = toolTarget(ctx, input.path)

      return await ctx.state.runExclusive(abs, async () => {
        const existing = await statOrNull(ctx, abs)
        if (existing?.isDirectory() === true) {
          throw new Error(`write 失败：${input.path} 是一个目录，不能当文件写`)
        }

        await ctx.fs.mkdir(dirname(abs))
        await ctx.fs.writeFile(abs, input.content)
        ctx.state.markRead(sessionKey(context), abs)

        const action = existing === null ? '已创建' : '已覆盖'
        return `${action} ${abs}（${Buffer.byteLength(input.content, 'utf8')} 字节）`
      })
    }
  })
}
