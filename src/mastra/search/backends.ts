/**
 * 搜索后端链（round 45）：**用户配置的自定义后端（若已配）→ 免费 Exa MCP**。
 *
 * 为什么是这条顺序：免费档开箱即用但有速率限制；用户填了 Key 说明他更在意配额与稳定性，
 * 所以自定义档优先，但它失败时**必须**自动回退免费档（"只做加法"：配了 Key 反而更差说不通）。
 * 两者都失败才报错，且错误里带上"去设置里填 Key"的指引。
 *
 * 三档后端的"原料"：
 *   - `exa-mcp-free`：`https://mcp.exa.ai/mcp`，无 Key（实测 2026-10-11 可用，有速率限制）；
 *   - `exa-mcp-key`：同一个端点 + `?exaApiKey=`（Exa 在限流回包里给的口径）；
 *   - `tavily-key`：`POST https://api.tavily.com/search`（REST，Key 进请求体与 Authorization 头）。
 *
 * 输出统一成 `SearchHit[]`：Exa 的回包是"给模型看的 Markdown 文本块"（`Title/URL/Published/
 * Highlights`，块间用 `---` 分隔），这里按它解析；解析不出来时把原文放在 `raw` 里交给工具原样透传。
 */
import {
  EXA_MCP_SEARCH_TOOL,
  TAVILY_SEARCH_ENDPOINT,
  effectiveWebSearch,
  exaEndpointWithKey,
  type SearchHit,
  type WebSearchRuntime
} from '../../shared/search'
import {
  SEARCH_TOTAL_TIMEOUT_MS,
  SearchTransportError,
  createMcpClient,
  mcpResultIsError,
  mcpResultText,
  searchHttpFailure,
  searchTransportFailure,
  type McpClient,
  type SearchDeps
} from './mcp-client'

/** 实际用上的后端（输出里给用户看的一档） */
export type SearchBackend = 'exa-mcp-free' | 'exa-mcp-key' | 'tavily-key'

/** 后端在人话里的名字（工具输出用） */
export const BACKEND_LABELS: Record<SearchBackend, string> = {
  'exa-mcp-free': '免费档',
  'exa-mcp-key': '自定义 Exa',
  'tavily-key': '自定义 Tavily'
}

/** 全部后端都失败时的"下一步"指引（不露内部术语） */
export const SEARCH_KEY_HINT = '可以在「设置 → 模型 → 联网搜索」里填自己的 Key 增强稳定性'

export interface WebSearchOutcome {
  backend: SearchBackend
  hits: SearchHit[]
  /** 后端原文（解析不出结构化结果时工具原样交给模型） */
  raw?: string
  /** 自定义档失败回退免费档时的说明（工具输出里带一行） */
  fallbackNote?: string
}

export interface WebSearchDeps extends SearchDeps {
  /** 复用一份客户端（会话缓存跨调用存活）；缺省按 deps 现建一个 */
  client?: McpClient
}

interface RawOutcome {
  hits: SearchHit[]
  raw: string
}

/** 把任意错误翻成一句人话（SearchTransportError 的 message 本身已是人话） */
export function humanSearchMessage(error: unknown): string {
  if (error instanceof SearchTransportError) return error.message
  if (error instanceof Error && error.message !== '') return error.message
  return '搜索服务出错'
}

/** 后端回的错误文本 → 中性人话（限流是免费档最常见的一种，单列出来给"填 Key"的指引） */
function errorTextFailure(text: string): SearchTransportError {
  if (/rate ?limit|too many requests|限流/i.test(text)) {
    return new SearchTransportError('搜索服务限流了（免费档有速率限制）', {
      kind: 'http',
      status: 429,
      retryable: false
    })
  }
  return new SearchTransportError('搜索服务返回了错误', { kind: 'protocol', retryable: false })
}

/** 摘要压成一行（折叠空白 + 截断）：进工具输出前先收拾干净 */
function tidySnippet(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 800)
}

/** Exa MCP 的文本块 → 结构化结果（块间 `---` 分隔，字段名固定） */
export function parseExaResults(text: string): SearchHit[] {
  const hits: SearchHit[] = []
  for (const block of text.split(/\r?\n-{3,}\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const fieldOf = (name: string): string => {
      const prefix = `${name}:`
      const line = lines.find((candidate) => candidate.startsWith(prefix))
      return line === undefined ? '' : line.slice(prefix.length).trim()
    }

    const title = fieldOf('Title')
    const url = fieldOf('URL')
    if (title === '' && url === '') continue

    const highlightAt = lines.findIndex((line) => line.trim() === 'Highlights:')
    const snippet = highlightAt < 0 ? '' : lines.slice(highlightAt + 1).join('\n')
    const published = fieldOf('Published')

    hits.push({
      title: title === '' ? url : title,
      url,
      snippet: tidySnippet(snippet),
      ...(published === '' || published.toUpperCase() === 'N/A' ? {} : { published })
    })
  }
  return hits
}

/** Tavily 的 JSON 回包 → 结构化结果（宽容解析：只认有 title/url 的条目） */
export function parseTavilyResults(payload: unknown): SearchHit[] {
  if (typeof payload !== 'object' || payload === null) return []
  const results = (payload as { results?: unknown }).results
  if (!Array.isArray(results)) return []

  const hits: SearchHit[] = []
  for (const entry of results) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const url = typeof record.url === 'string' ? record.url : ''
    const title = typeof record.title === 'string' ? record.title : ''
    if (url === '' && title === '') continue
    const content = typeof record.content === 'string' ? record.content : ''
    const published = typeof record.published_date === 'string' ? record.published_date : ''
    hits.push({
      title: title === '' ? url : title,
      url,
      snippet: tidySnippet(content),
      ...(published === '' ? {} : { published })
    })
  }
  return hits
}

/** 调一次 Exa MCP（免费档 Key 传 null） */
async function exaSearch(
  client: McpClient,
  endpoint: string,
  apiKey: string | null,
  query: string,
  numResults: number
): Promise<RawOutcome> {
  const url = exaEndpointWithKey(endpoint, apiKey)
  const result = await client.callTool({
    endpoint: url,
    tool: EXA_MCP_SEARCH_TOOL,
    args: { query, numResults },
    // 分桶键 = 实际端点（含 Key），免费档与自定义档互不串味
    sessionKey: url
  })
  const text = mcpResultText(result)
  if (mcpResultIsError(result)) throw errorTextFailure(text)
  return { hits: parseExaResults(text), raw: text }
}

/** 调一次 Tavily（REST）：Key 同时进请求体 `api_key` 与 Authorization 头（两种口径都兼容） */
async function tavilySearch(
  fetchImpl: typeof fetch,
  apiKey: string,
  query: string,
  numResults: number,
  timeoutMs: number
): Promise<RawOutcome> {
  let response: Response
  try {
    response = await fetchImpl(TAVILY_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: numResults,
        search_depth: 'basic'
      }),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs))
    })
  } catch (error) {
    throw searchTransportFailure(error, timeoutMs)
  }
  if (!response.ok) throw searchHttpFailure(response.status)

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new SearchTransportError('搜索服务返回了看不懂的响应', {
      kind: 'protocol',
      retryable: false
    })
  }
  return { hits: parseTavilyResults(payload), raw: JSON.stringify(payload) }
}

/** 自定义档（没配就回 null —— 那不是"失败"，是"没这一路"） */
function customBackendOf(
  runtime: WebSearchRuntime,
  deps: { client: McpClient; fetchImpl: typeof fetch; totalMs: number },
  query: string,
  numResults: number
): { backend: SearchBackend; run: () => Promise<RawOutcome> } | null {
  const settings = effectiveWebSearch(runtime.settings)
  if (settings.mode !== 'custom') return null
  const key = runtime.searchKey?.trim() ?? ''
  if (key === '') return null

  if (settings.provider === 'tavily') {
    return {
      backend: 'tavily-key',
      run: () => tavilySearch(deps.fetchImpl, key, query, numResults, deps.totalMs)
    }
  }
  return {
    backend: 'exa-mcp-key',
    run: () => exaSearch(deps.client, settings.exaEndpoint, key, query, numResults)
  }
}

/**
 * 跑一次搜索：自定义档（若已配）→ 免费档；全失败抛人话错误（带"填 Key"的指引）。
 */
export async function runWebSearch(
  input: { runtime: WebSearchRuntime; query: string; numResults: number },
  deps: WebSearchDeps = {}
): Promise<WebSearchOutcome> {
  const settings = effectiveWebSearch(input.runtime.settings)
  const client = deps.client ?? createMcpClient(deps)
  const fetchImpl = deps.fetchImpl ?? fetch
  const totalMs = deps.totalTimeoutMs ?? SEARCH_TOTAL_TIMEOUT_MS

  const free = (): Promise<RawOutcome> =>
    exaSearch(client, settings.exaEndpoint, null, input.query, input.numResults)

  const custom = customBackendOf(
    input.runtime,
    { client, fetchImpl, totalMs },
    input.query,
    input.numResults
  )

  if (custom !== null) {
    try {
      const outcome = await custom.run()
      return { backend: custom.backend, ...outcome }
    } catch (error) {
      const reason = humanSearchMessage(error)
      try {
        const outcome = await free()
        return {
          backend: 'exa-mcp-free',
          ...outcome,
          fallbackNote: `自定义后端没成功（${reason}），已改用免费档`
        }
      } catch (fallbackError) {
        throw new Error(
          `联网搜索失败：${reason}；免费档也没成功（${humanSearchMessage(fallbackError)}）。${SEARCH_KEY_HINT}`
        )
      }
    }
  }

  try {
    const outcome = await free()
    return { backend: 'exa-mcp-free', ...outcome }
  } catch (error) {
    throw new Error(`联网搜索失败：${humanSearchMessage(error)}。${SEARCH_KEY_HINT}`)
  }
}
