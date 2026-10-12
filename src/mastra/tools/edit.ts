/**
 * edit 工具：对工作区内的文本文件做**精确替换**（Review Focus #3）。
 *
 * 精度纪律（每条都有用例）：
 *   - 全程按原始字符串匹配/拼接，**不做任何 NFD/NFC 归一**：文件里是什么就是什么，
 *     归一化会把"看起来一样"的串换掉，也会悄悄改掉替换范围之外的字节；
 *   - 匹配位置必须在**码点边界**上（不把代理对切开）：孤立代理项不算命中；
 *   - oldText 必须唯一命中；0 处/多处都拒绝，文件不动；
 *   - CRLF 兜底：文件是 CRLF 而 oldText 只带 LF 时，换成 CRLF 再精确匹配一次，
 *     替换段也按 CRLF 落地（只影响这一段的行尾，不重写文件其余部分）。
 *
 * 安全与并发：
 *   - 未读先改拒绝：同一会话（agent 线程）里没 read/write 过这个文件就不给改；
 *   - 整段"读 → 改 → 写"在同文件队列里跑（per-file 串行），并发 edit 不丢更新。
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

/** 用了 CRLF 兜底时回执里的说明（测试与模型都看得见） */
export const EDIT_CRLF_NOTE = '按 CRLF 行尾匹配'

export const editInputSchema = z.object({
  path: z.string().min(1).describe('文件路径；相对路径以授权工作区为基准'),
  oldText: z.string().min(1).describe('要被替换的原文片段（从 read 的结果里逐字复制，不带行号）'),
  newText: z.string().describe('替换成的新文本；空串表示删除这段')
})

export type EditInput = z.infer<typeof editInputSchema>

export async function createEditTool(ctx: ToolContext): Promise<Tool<EditInput, string>> {
  const { createTool } = await import('@mastra/core/tools')

  return createTool({
    id: 'edit',
    description:
      '对工作区内的文本文件做精确替换：oldText 必须与文件内容逐字匹配（含空白/换行）且只出现一处。先 read 再改；改整个文件用 write。',
    inputSchema: editInputSchema,
    outputSchema: z.string(),
    requireApproval: (input, approval) =>
      needsApproval(ctx, 'edit', input, approvalSessionOf(approval)),
    execute: async (input, context) => {
      const session = sessionKey(context)
      const { abs } = toolTarget(ctx, input.path, session)

      if (!ctx.state.wasRead(session, abs)) {
        throw new Error(`未读先改：请先用 read 读取 ${abs}，确认原文后再 edit`)
      }

      return await ctx.state.runExclusive(abs, async () => {
        const fileStat = await statOrNull(ctx, abs)
        if (fileStat === null || !fileStat.isFile()) {
          throw new Error(`edit 失败：${input.path} 不存在或不是文件`)
        }
        const bytes = await ctx.fs.readFile(abs)
        const text = new StringDecoder('utf8').write(bytes)
        const replacement = locate(text, input.oldText, input.newText)

        await ctx.fs.writeFile(abs, replacement.next)
        ctx.state.markRead(session, abs)

        const suffix = replacement.crlf ? `（${EDIT_CRLF_NOTE}）` : ''
        return `已替换 1 处 → ${abs}${suffix}`
      })
    }
  })
}

interface Replacement {
  next: string
  crlf: boolean
}

/** 找到唯一命中并替换；找不到/不唯一/不合法都抛（错误里带上怎么改对） */
function locate(text: string, oldText: string, newText: string): Replacement {
  if (oldText === '') throw new Error('oldText 不能为空：空串会匹配到任何位置')

  const hits = validMatches(text, oldText)
  if (hits.length === 1) {
    return { next: splice(text, hits[0], oldText.length, newText), crlf: false }
  }
  if (hits.length > 1) {
    throw new Error(
      `oldText 在文件里出现 ${hits.length} 处；请在 oldText 里多带些上下文，确保只匹配一处`
    )
  }

  // CRLF 兜底：文件是 CRLF、模型按 LF 写的 oldText
  if (oldText.includes('\n') && !oldText.includes('\r')) {
    const crlfOldText = oldText.replace(/\n/g, '\r\n')
    const crlfHits = validMatches(text, crlfOldText)
    if (crlfHits.length === 1) {
      const crlfNewText = newText.replace(/\n/g, '\r\n')
      return { next: splice(text, crlfHits[0], crlfOldText.length, crlfNewText), crlf: true }
    }
    if (crlfHits.length > 1) {
      throw new Error(
        `oldText 在文件里出现 ${crlfHits.length} 处；请在 oldText 里多带些上下文，确保只匹配一处`
      )
    }
  }

  throw new Error(
    '没有找到 oldText 的精确匹配（未做任何修改）。请先 read 看原文，从原文里逐字复制片段再试'
  )
}

/** 所有"落在码点边界上"的命中位置（切开代理对的命中不算——那会毁掉半个 emoji） */
function validMatches(text: string, needle: string): number[] {
  const found: number[] = []
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at < 0) return found
    if (isCodePointBoundary(text, at) && isCodePointBoundary(text, at + needle.length)) {
      found.push(at)
    }
    from = at + 1
  }
}

function isCodePointBoundary(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return true
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return !(isHighSurrogate(before) && isLowSurrogate(after))
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function splice(text: string, at: number, length: number, replacement: string): string {
  return text.slice(0, at) + replacement + text.slice(at + length)
}
