/**
 * web_search 工具（round 45）：内置联网搜索 —— 默认走免费档（Exa MCP，无需配置即可用）。
 *
 * 分层：本文件只是**薄壳**（入参 schema、条数 clamp、审批、输出排版），真正的链路在
 * `mastra/search/`（客户端 + 后端链，可单测、不依赖 Mastra）。
 *
 * 契约与取舍：
 *   - 后端链 = 用户配置的自定义后端（若已配）→ 免费 Exa MCP（见 search/backends.ts）；
 *     全失败给人话错误，并指一句"可以在设置里填 Key"（不露内部术语）。
 *   - 条数：缺省 5，**clamp ≤ 10**（模型给了 50 也只取 10 —— 拒绝不如截断好用）。
 *   - 输出是结构化文本（标题 / URL / 摘要 / 发布时间），与既有工具回执风格一致，模型直接可读。
 *   - 审批与 fetch **同档**（写类默认问；full 工作区免审）：网络出站与 fetch 同性质，
 *     口径见 main/permission/classify.ts；不新开特例。
 *   - 描述写清"什么时候用"（查最新信息 / 多源查证）与"不走这里"（已知单页正文用 fetch 阅读模式）。
 */
import type { Tool } from '@mastra/core/tools'
import { z } from '../../shared/zod'
import {
  DEFAULT_WEB_SEARCH_RUNTIME,
  WEB_SEARCH_DEFAULT_RESULTS,
  WEB_SEARCH_MAX_RESULTS,
  type WebSearchRuntime
} from '../../shared/search'
import {
  BACKEND_LABELS,
  runWebSearch,
  type WebSearchDeps,
  type WebSearchOutcome
} from '../search/backends'
import { createMcpClient, type McpClient } from '../search/mcp-client'
import { clipText } from './exec'
import { needsApproval, type ToolContext } from './guard'

/** 后端原文透传的上限（解析不出结构化结果时的兜底） */
export const SEARCH_RAW_LIMIT_BYTES = 32 * 1024

export const webSearchInputSchema = z.object({
  query: z.string().min(1).describe('搜索词：自然语言即可；查最新信息时把时间范围或版本号说清楚'),
  numResults: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(`返回条数（缺省 ${WEB_SEARCH_DEFAULT_RESULTS}，最多 ${WEB_SEARCH_MAX_RESULTS}）`)
})

export type WebSearchInput = z.infer<typeof webSearchInputSchema>

export interface WebSearchToolOptions {
  /** 现读的运行时配置（设置 + 两个可选 Key）；缺省 = 免费档、没 Key */
  runtime?: () => WebSearchRuntime
  /** 搜索依赖（单测注入 fetch / 客户端；生产不传） */
  deps?: WebSearchDeps
}

/** 条数 clamp：缺省 5，[1, 10] 之间（模型给 50 也只取 10） */
export function clampNumResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return WEB_SEARCH_DEFAULT_RESULTS
  const rounded = Math.trunc(value)
  if (rounded < 1) return 1
  return Math.min(rounded, WEB_SEARCH_MAX_RESULTS)
}

/** 结果 → 给模型的文本（结构化；解析不出结构化结果时透传后端原文） */
export function formatSearchOutcome(query: string, outcome: WebSearchOutcome): string {
  const lines = [`联网搜索「${query}」（后端：${BACKEND_LABELS[outcome.backend]}）`]
  if (outcome.fallbackNote !== undefined) lines.push(`[${outcome.fallbackNote}]`)

  if (outcome.hits.length === 0) {
    const raw = (outcome.raw ?? '').trim()
    lines.push('')
    lines.push(
      raw === ''
        ? '（没有搜到结果；可以换个更具体的搜索词再试）'
        : clipText(raw, SEARCH_RAW_LIMIT_BYTES).text
    )
    return lines.join('\n')
  }

  lines.push('')
  outcome.hits.forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.title}`)
    if (hit.url !== '') lines.push(`   URL: ${hit.url}`)
    if (hit.published !== undefined) lines.push(`   发布: ${hit.published}`)
    if (hit.snippet !== '') lines.push(`   摘要: ${hit.snippet}`)
  })
  return lines.join('\n')
}

export async function createWebSearchTool(
  ctx: ToolContext,
  options: WebSearchToolOptions = {}
): Promise<Tool<WebSearchInput, string>> {
  const { createTool } = await import('@mastra/core/tools')
  // 客户端在工具创建时建一份：会话缓存（mcp-session-id）要跨调用存活，不是每次搜索重来
  const client: McpClient = options.deps?.client ?? createMcpClient(options.deps)
  const runtimeOf = options.runtime ?? ((): WebSearchRuntime => DEFAULT_WEB_SEARCH_RUNTIME)

  return createTool({
    id: 'web_search',
    description:
      '联网搜索：查最新的信息、多来源查证一件事（返回标题、链接与摘要）。默认走免费搜索档，无需配置。' +
      '要看某个**已知网页**的正文，用 fetch 的阅读模式（mode: "reader"），不要用本工具。' +
      '执行前会请求用户批准。',
    inputSchema: webSearchInputSchema,
    outputSchema: z.string(),
    requireApproval: (input) => needsApproval(ctx, 'web_search', input),
    execute: async (input) => {
      const outcome = await runWebSearch(
        {
          runtime: runtimeOf(),
          query: input.query,
          numResults: clampNumResults(input.numResults)
        },
        { ...options.deps, client }
      )
      return formatSearchOutcome(input.query, outcome)
    }
  })
}
