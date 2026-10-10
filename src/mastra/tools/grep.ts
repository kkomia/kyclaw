/**
 * grep 工具：在工作区内按正则搜文本（JavaScript 正则；不依赖外部 ripgrep，无 shell）。
 *
 * 契约与取舍（每一条都有用例）：
 *   - 行输出 `绝对路径:行号: 行内容`；行内容截到 400 字符（防超长行把结果撑爆）；
 *   - 二进制跳过：文件内容带 NUL 的直接跳过（readFile 最多读 1MB，大文件不进内存）；
 *   - .git 目录跳过（VCS 内部，永远不是搜索目标）；符号链接/ junction 一律不跟（防链接逃逸）；
 *   - 截断契约：命中 ≤100 条；目录扫描 ≤2000 个文件，超了附提示说明可能不完整；
 *   - glob 过滤：不带斜杠的模式按文件名匹配任意深度（与 ripgrep -g 同口径）。
 */
import { basename, join, matchesGlob, relative, sep } from 'node:path'
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import { needsApproval, scanRoot, sessionKey, statOrNull, type ToolContext } from './guard'

/** 命中上限（spec §5.1 输出截断限额） */
export const GREP_MAX_HITS = 100
/** 目录扫描上限：防一个大工作区把工具卡死（超了给提示，结果可能不完整） */
export const GREP_MAX_SCAN_FILES = 2000
/** 单个文件最多读这么多（超出部分不搜；文本文件远超 1MB 的很少） */
export const GREP_MAX_FILE_BYTES = 1024 * 1024
/** 单行展示上限 */
export const GREP_MAX_LINE_CHARS = 400
/** 跳过的目录（VCS 内部） */
const SKIPPED_DIRS = new Set(['.git'])

export const grepInputSchema = z.object({
  pattern: z.string().min(1).describe('正则表达式（JavaScript 语法）'),
  path: z
    .string()
    .min(1)
    .optional()
    .describe('起始目录（工作区内）；缺省 = 工作区根（有多个工作区时必须给）'),
  glob: z.string().min(1).optional().describe('只搜匹配该 glob 的文件，例如 *.ts、src/**/*.ts'),
  ignoreCase: z.boolean().optional().describe('true = 忽略大小写（缺省区分）')
})

export type GrepInput = z.infer<typeof grepInputSchema>

export async function createGrepTool(ctx: ToolContext): Promise<Tool<GrepInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'grep',
    description:
      '在工作区内用正则搜索文本，返回 `路径:行号: 行内容`，最多 100 条命中。二进制文件与 .git 自动跳过。',
    inputSchema: grepInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) => needsApproval(ctx, 'grep', input),
    execute: async (input, context) => {
      const base = scanRoot(ctx, input.path, sessionKey(context))
      const baseStat = await statOrNull(ctx, base.abs)
      if (baseStat === null || !baseStat.isDirectory()) {
        throw new Error(`grep 失败：${input.path ?? base.abs} 不是目录`)
      }

      let pattern: RegExp
      try {
        pattern = new RegExp(input.pattern, input.ignoreCase === true ? 'i' : '')
      } catch {
        throw new Error(`正则表达式不合法：${input.pattern}`)
      }

      const hits: string[] = []
      let scanned = 0
      let capped = false

      const visit = async (dir: string): Promise<void> => {
        const entries = [...(await ctx.fs.readdir(dir))].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        )
        for (const entry of entries) {
          if (hits.length >= GREP_MAX_HITS || capped) return
          const child = join(dir, entry.name)

          if (entry.isSymbolicLink()) continue
          if (entry.isDirectory()) {
            if (SKIPPED_DIRS.has(entry.name)) continue
            await visit(child)
            continue
          }
          if (!entry.isFile()) continue

          if (scanned >= GREP_MAX_SCAN_FILES) {
            capped = true
            return
          }
          scanned++

          if (input.glob !== undefined && !matchesFilter(relative(base.abs, child), input.glob)) {
            continue
          }
          const buffer = await ctx.fs.readFile(child, GREP_MAX_FILE_BYTES)
          if (buffer.includes(0)) continue

          const lines = buffer.toString('utf8').split('\n')
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index].replace(/\r$/, '')
            if (!pattern.test(line)) continue
            hits.push(`${child}:${index + 1}: ${truncate(line)}`)
            if (hits.length >= GREP_MAX_HITS) return
          }
        }
      }

      await visit(base.abs)

      if (hits.length === 0) {
        const scanNote = capped ? `（目录扫描到 ${GREP_MAX_SCAN_FILES} 个文件就停了）` : ''
        return `没有匹配「${input.pattern}」的内容${scanNote}`
      }

      const notes: string[] = []
      if (hits.length >= GREP_MAX_HITS) {
        notes.push(`[命中达到 ${GREP_MAX_HITS} 条上限，可能还有更多]`)
      }
      if (capped) {
        notes.push(`[目录扫描到 ${GREP_MAX_SCAN_FILES} 个文件就停了，结果可能不完整]`)
      }
      return hits.join('\n') + (notes.length === 0 ? '' : `\n\n${notes.join('\n')}`)
    }
  })
}

/** 不带斜杠的模式按文件名匹配任意深度（ripgrep -g 的口径）；带斜杠的按相对路径匹配 */
function matchesFilter(relativePath: string, filter: string): boolean {
  const normalizedPath = relativePath.split(sep).join('/')
  const normalizedFilter = filter.split('\\').join('/')
  if (normalizedFilter.includes('/')) return matchesGlob(normalizedPath, normalizedFilter)
  return matchesGlob(basename(normalizedPath), normalizedFilter)
}

function truncate(line: string): string {
  return line.length > GREP_MAX_LINE_CHARS ? `${line.slice(0, GREP_MAX_LINE_CHARS)}…` : line
}
