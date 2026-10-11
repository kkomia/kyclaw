/**
 * move 工具：移动 / 重命名工作区内的文件与目录。
 *
 * 分级同样是 **dangerous**（永远弹审批，Full access 与"永久允许"不适用）。
 * 契约：
 *   - 源与目标都要过引擎（`path` / `to`，fail closed），目标父目录自动创建（与 write 同口径）；
 *   - **默认不覆盖**：目标已存在就报错并给出口（`overwrite: true`）；目标存在且是目录时一律拒绝
 *     （覆盖目录语义在 v1 太危险，明确不做）；
 *   - 拒绝把目录移动进它自己内部（rename 会失败，先给人话）；拒绝移动工作区根目录本身；
 *   - 与同目标的写入用同队列串行（目标路径为锁键），避免"移动覆盖"和"写入"打架。
 * `path` + `to` 的命名也让审批卡能显示源路径（渲染端按 input.path 取目标；`to` 只进入参面板）。
 */
import { dirname, isAbsolute, relative } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { needsApproval, sessionKey, statOrNull, toolTarget, type ToolContext } from './guard'

export const moveInputSchema = z.object({
  path: z.string().min(1).describe('要移动 / 重命名的源路径（工作区内）'),
  to: z.string().min(1).describe('目标路径（工作区内；相对路径以工作区为基准）'),
  overwrite: z
    .boolean()
    .optional()
    .describe('目标已存在时是否覆盖（缺省 false；目标为目录时一律拒绝）')
})

export type MoveInput = z.infer<typeof moveInputSchema>

export async function createMoveTool(ctx: ToolContext): Promise<Tool<MoveInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'move',
    description:
      '在工作区内移动或重命名文件 / 目录；目标父目录会自动创建。默认不覆盖已存在的目标' +
      '（要覆盖传 overwrite: true；目标为目录时一律拒绝）。这是危险操作：每次都会请求用户批准。',
    inputSchema: moveInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) => needsApproval(ctx, 'move', input),
    execute: async (input, context) => {
      const session = sessionKey(context)
      const source = toolTarget(ctx, input.path, session)
      const destination = toolTarget(ctx, input.to, session)

      if (relative(source.abs, destination.abs) === '') {
        throw new Error(`move 失败：源与目标是同一个路径（${input.path}）`)
      }
      if (relative(source.workspace.path, source.abs) === '') {
        throw new Error('move 失败：不能移动工作区根目录本身；如确需改根路径，请用 bash 工具')
      }
      if (inside(source.abs, destination.abs)) {
        throw new Error(`move 失败：不能把目录移动到它自己内部（${input.to}）`)
      }

      return await ctx.state.runExclusive(destination.abs, async () => {
        const sourceStat = await statOrNull(ctx, source.abs)
        if (sourceStat === null) throw new Error(`move 失败：源路径不存在（${input.path}）`)

        const existing = await statOrNull(ctx, destination.abs)
        let replaced = false
        if (existing !== null) {
          if (input.overwrite !== true) {
            throw new Error(`move 失败：目标已存在（${input.to}）；要覆盖请传 overwrite: true`)
          }
          if (existing.isDirectory()) {
            throw new Error(`move 失败：目标已存在且是目录，不覆盖目录（${input.to}）`)
          }
          await ctx.fs.remove(destination.abs, { recursive: false })
          replaced = true
        }

        await ctx.fs.mkdir(dirname(destination.abs))
        try {
          await ctx.fs.rename(source.abs, destination.abs)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`move 失败：${input.path} → ${input.to}（${message}）`)
        }

        return `已移动 ${source.abs} → ${destination.abs}${replaced ? '（覆盖了原文件）' : ''}`
      })
    }
  })
}

/** candidate 是否落在 parent 目录内部（词法判定；两侧都来自引擎，已是归一后的真实路径） */
function inside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate)
  return (
    rel !== '' &&
    !isAbsolute(rel) &&
    rel !== '..' &&
    !rel.startsWith('..\\') &&
    !rel.startsWith('../')
  )
}
