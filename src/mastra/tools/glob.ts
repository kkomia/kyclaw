/**
 * glob 工具：按模式列出工作区内的文件（`**` 递归、`*` 不跨目录，node:fs 的 glob 语义）。
 *
 * - 起始目录：path 给了就按它（必须落在工作区内）；没给时恰好一个工作区用根，多个就要求显式指定。
 * - 每个命中都过一遍引擎（resolveInsideWorkspace）：链接指到工作区外的结果会被 realpath 识破并滤掉。
 * - 截断契约：最多 200 条，超出时附提示。
 */
import { isAbsolute, join } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import {
  approvalSessionOf,
  insideWorkspace,
  needsApproval,
  scanRoot,
  sessionKey,
  statOrNull,
  type ToolContext
} from './guard'

/** glob 结果上限（spec §5.1 输出截断限额） */
export const GLOB_MAX_RESULTS = 200

export const globInputSchema = z.object({
  pattern: z.string().min(1).describe('Glob pattern, for example **/*.ts or src/*.md'),
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Directory to search; defaults to the workspace root (required with several workspaces)'
    )
})

export type GlobInput = z.infer<typeof globInputSchema>

export async function createGlobTool(ctx: ToolContext): Promise<Tool<GlobInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'glob',
    description:
      'List workspace file paths matching a glob (** recurses, * stays in one directory); max 200 results, absolute paths, sorted by path name — not by modification time, so never infer which file changed most recently from this order.',
    inputSchema: globInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'glob', input, approvalSessionOf(approval)),
    execute: async (input, context) => {
      const base = scanRoot(ctx, input.path, sessionKey(context))
      const baseStat = await statOrNull(ctx, base.abs)
      if (baseStat === null || !baseStat.isDirectory()) {
        throw new Error(`glob 失败：${input.path ?? base.abs} 不是目录`)
      }

      const entries = await globEntries(ctx, input.pattern, base.abs)
      const files: string[] = []
      for (const entry of entries) {
        if (files.length > GLOB_MAX_RESULTS) break
        const candidate = isAbsolute(entry) ? entry : join(base.abs, entry)
        const absolute = insideWorkspace(base.workspace, candidate)
        if (absolute === null) continue

        const fileStat = await statOrNull(ctx, absolute)
        if (fileStat?.isFile() === true) files.push(absolute)
      }

      const shown = files.slice(0, GLOB_MAX_RESULTS)
      if (shown.length === 0) return `没有匹配 ${input.pattern} 的文件（起始目录：${base.abs}）`

      const more = files.length > GLOB_MAX_RESULTS
      return shown.join('\n') + (more ? `\n\n[匹配太多，只显示前 ${GLOB_MAX_RESULTS} 条]` : '')
    }
  })
}

/** 模式不合法时给模型的是一句人话（node 的原生报错是英文且带栈味） */
async function globEntries(
  ctx: ToolContext,
  pattern: string,
  cwd: string
): Promise<readonly string[]> {
  try {
    return [...(await ctx.fs.glob(pattern, cwd))].sort()
  } catch {
    throw new Error(`glob 模式不合法：${pattern}`)
  }
}
