/**
 * delete 工具：删除工作区内的文件 / 空目录 / 整棵目录树。
 *
 * 分级是 **dangerous**（permission/classify）：永远弹审批，Full access 与"永久允许"规则都
 * 不放行（spec §5.2；"永久允许"不落到删除上 —— 用户点过的"以后都别问"不该覆盖删除）。
 * 执行路径照旧只认引擎给的 abs（fail closed）；删除与写入共用同文件队列（同一目标串行）。
 * 明确不做的事：不删工作区根目录本身（`path: "."` 一类的手滑直接拒掉，要删根请用 bash 自担）。
 * 目录非空且没传 recursive 时报错并给出下一步（而不是让 Node 的英文错误上卡）。
 */
import { relative } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { needsApproval, sessionKey, statOrNull, toolTarget, type ToolContext } from './guard'

export const deleteInputSchema = z.object({
  path: z.string().min(1).describe('要删除的文件或目录（工作区内）'),
  recursive: z
    .boolean()
    .optional()
    .describe('目录非空时是否整树删除（缺省 false：只删文件与空目录）')
})

export type DeleteInput = z.infer<typeof deleteInputSchema>

export async function createDeleteTool(ctx: ToolContext): Promise<Tool<DeleteInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'delete',
    description:
      '删除工作区内的文件或目录（recursive=true 才允许删非空目录；缺省只删文件与空目录）。' +
      '这是危险操作：每次都会请求用户批准（没有"以后都别问"的豁免）。',
    inputSchema: deleteInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) => needsApproval(ctx, 'delete', input),
    execute: async (input, context) => {
      const { abs, workspace } = toolTarget(ctx, input.path, sessionKey(context))
      if (relative(workspace.path, abs) === '') {
        throw new Error(
          'delete 失败：不能删除工作区根目录本身；如确需清空，请用 bash 工具（会请求审批）'
        )
      }

      const stats = await statOrNull(ctx, abs)
      if (stats === null) throw new Error(`delete 失败：${input.path} 不存在`)

      const recursive = input.recursive === true
      return await ctx.state.runExclusive(abs, async () => {
        try {
          await ctx.fs.remove(abs, { recursive })
        } catch (error) {
          if (isNotEmpty(error)) {
            throw new Error(
              `delete 失败：${input.path} 目录非空；要连同内容一起删除请传 recursive: true`
            )
          }
          throw new Error(`delete 失败：${input.path}（${messageOf(error)}）`)
        }

        const kind = stats.isDirectory() ? (recursive ? '目录（含内容）' : '空目录') : '文件'
        return `已删除${kind} ${abs}`
      })
    }
  })
}

/** 目录非空（不同平台/实现的两种错误码） */
function isNotEmpty(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOTEMPTY' || code === 'EEXIST'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
