/**
 * 极小 streamable-HTTP MCP 客户端（round 45）：够跑通 `initialize` → `notifications/initialized`
 * → `tools/call` 三步就停，不引 SDK（仓库里没有 `@modelcontextprotocol/*`，也不为这一次调用新增依赖）。
 *
 * 协议形状是本机实测（2026-10-11，`https://mcp.exa.ai/mcp`）：
 *   POST initialize（`Accept: application/json, text/event-stream`）→ 响应头给 `mcp-session-id`；
 *   POST notifications/initialized（通知，无 id）；POST tools/call → `text/event-stream` 里回
 *   `event: message\ndata: {jsonrpc,id,result}`。**纯 JSON 响应同样容忍**（自建 MCP server 常见）。
 *
 * 纪律：
 *   - **两档超时**：连接（initialize）8s，整体（tools/call）20s；都用 `AbortSignal.timeout`，
 *     不给调用方留一个永远挂着的 Promise。
 *   - **失败重试一次（短退避）**：网络层错误 / 超时 / 5xx / 会话失效都算可重试；4xx（含 429、401、
 *     403）与协议错不重试 —— 重试不会让坏 Key 变好，只会多打一次对方。
 *   - **会话缓存**：按 `sessionKey`（端点 + 认证指纹）缓存 `mcp-session-id`；重试时先丢缓存再重建，
 *     对应"会话失效自动重建一次"。
 *   - 错误一律 `SearchTransportError`（中性人话 + `retryable`），工具层再拼成给用户看的整句。
 */
export interface SearchDeps {
  /** 注入的 fetch（单测给假实现，不碰真网络；缺省 = 全局 fetch） */
  fetchImpl?: typeof fetch
  /** 连接（initialize）超时，毫秒 */
  connectTimeoutMs?: number
  /** 整体（tools/call）超时，毫秒 */
  totalTimeoutMs?: number
  /** 重试前的退避，毫秒（0 = 不等，测试用） */
  retryDelayMs?: number
}

export const SEARCH_CONNECT_TIMEOUT_MS = 8_000
export const SEARCH_TOTAL_TIMEOUT_MS = 20_000
export const SEARCH_RETRY_DELAY_MS = 400

/** MCP 协议版本：Exa 端点认这个（实测回包里也是它） */
const MCP_PROTOCOL_VERSION = '2024-11-05'

export type SearchFailureKind = 'network' | 'timeout' | 'http' | 'protocol' | 'session'

/** 搜索链上的传输错误：`retryable` 决定要不要再打一次 */
export class SearchTransportError extends Error {
  readonly kind: SearchFailureKind
  readonly retryable: boolean
  readonly status: number | undefined

  constructor(
    message: string,
    options: { kind: SearchFailureKind; retryable: boolean; status?: number }
  ) {
    super(message)
    this.name = 'SearchTransportError'
    this.kind = options.kind
    this.retryable = options.retryable
    this.status = options.status
  }
}

export interface McpToolRequest {
  /** MCP 端点（streamable HTTP） */
  endpoint: string
  /** 工具名（Exa 免费档是 `web_search_exa`） */
  tool: string
  args: Record<string, unknown>
  /** 额外请求头（如认证；不参与会话分桶，分桶见 sessionKey） */
  headers?: Record<string, string>
  /** 会话缓存分桶键（缺省 = endpoint）；带 Key 的端点用不同桶，免得串味 */
  sessionKey?: string
}

export interface McpClient {
  /** 调一个工具；返回 JSON-RPC 的 `result` 原文（`{content:[…]}` 或 `{isError:true,…}`） */
  callTool(request: McpToolRequest): Promise<unknown>
  /** 当前缓存的会话数（单测用） */
  sessionCount(): number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 网络层/超时 → 中性人话（含"是不是网络问题"这层信息，不含端点原文） */
export function searchTransportFailure(error: unknown, ms: number): SearchTransportError {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new SearchTransportError(`搜索服务响应超时（${Math.round(ms / 1000)} 秒）`, {
      kind: 'timeout',
      retryable: true
    })
  }
  return new SearchTransportError('连不上搜索服务（检查网络或代理）', {
    kind: 'network',
    retryable: true
  })
}

/** HTTP 状态 → 中性人话 + 可否重试 */
export function searchHttpFailure(status: number): SearchTransportError {
  if (status === 429) {
    return new SearchTransportError('搜索服务限流了（免费档有速率限制）', {
      kind: 'http',
      retryable: false,
      status
    })
  }
  if (status === 401 || status === 403) {
    return new SearchTransportError('搜索服务拒绝了这把 Key（可能无效或没有权限）', {
      kind: 'http',
      retryable: false,
      status
    })
  }
  if (status === 404) {
    return new SearchTransportError('搜索会话已失效', { kind: 'session', retryable: true, status })
  }
  if (status >= 500) {
    return new SearchTransportError(`搜索服务暂时不可用（HTTP ${status}）`, {
      kind: 'http',
      retryable: true,
      status
    })
  }
  return new SearchTransportError(`搜索服务返回 HTTP ${status}`, {
    kind: 'http',
    retryable: false,
    status
  })
}

/**
 * 读一段 MCP 响应：SSE（`data:` 行）与纯 JSON 都容忍。
 * 多事件时取最后一条带 `result` / `error` 的（进度通知可能在前）；都没有就回最后一条或空对象。
 */
export async function readJsonRpcMessage(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  const messages: Record<string, unknown>[] = []
  const looksLikeSse =
    (response.headers.get('content-type') ?? '').includes('text/event-stream') ||
    text.startsWith('event:') ||
    text.includes('\ndata:')

  if (looksLikeSse) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '') continue
      try {
        const parsed: unknown = JSON.parse(payload)
        if (isRecord(parsed)) messages.push(parsed)
      } catch {
        // 坏块跳过：SSE 里可能有 keep-alive / 注释行
      }
    }
  }
  if (messages.length === 0 && text.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed)) messages.push(parsed)
    } catch {
      // 非 JSON：交给下面的"空消息"分支报协议错
    }
  }

  const withBody = messages.filter((message) => 'result' in message || 'error' in message)
  const pool = withBody.length > 0 ? withBody : messages
  return pool.length === 0 ? {} : pool[pool.length - 1]
}

function rpcErrorMessage(error: unknown): { message: string; retryable: boolean } {
  const message =
    isRecord(error) && typeof error.message === 'string' ? error.message : '搜索服务返回了错误'
  // "会话不存在 / 已过期"这类错误：重建会话能救，按可重试处理（不把内部术语带给用户）
  const sessionish = /session|会话/i.test(message)
  return {
    message: sessionish ? '搜索会话已失效' : '搜索服务返回了错误',
    retryable: sessionish
  }
}

export function createMcpClient(deps: SearchDeps = {}): McpClient {
  const fetchImpl = deps.fetchImpl ?? fetch
  const connectMs = deps.connectTimeoutMs ?? SEARCH_CONNECT_TIMEOUT_MS
  const totalMs = deps.totalTimeoutMs ?? SEARCH_TOTAL_TIMEOUT_MS
  const retryDelay = deps.retryDelayMs ?? SEARCH_RETRY_DELAY_MS

  /** 会话缓存：分桶键（端点 + 认证指纹）→ mcp-session-id（null = 端点没给，照跑） */
  const sessions = new Map<string, string | null>()
  let nextId = 1

  async function post(
    request: McpToolRequest,
    body: Record<string, unknown>,
    session: string | null,
    timeoutMs: number
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...request.headers
    }
    if (session !== null && session !== '') headers['mcp-session-id'] = session

    try {
      return await fetchImpl(request.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(1, timeoutMs))
      })
    } catch (error) {
      throw searchTransportFailure(error, timeoutMs)
    }
  }

  /** initialize → notifications/initialized；返回 `mcp-session-id`（端点没给就回 null） */
  async function openSession(request: McpToolRequest): Promise<string | null> {
    const response = await post(
      request,
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'kyclaw', version: '1.0.0' }
        }
      },
      null,
      connectMs
    )
    if (!response.ok) throw searchHttpFailure(response.status)
    await readJsonRpcMessage(response)
    const session = response.headers.get('mcp-session-id')

    // 通知没有回包可言：202/空体都正常，这里**故意不看状态码**（自建 server 的宽容度差很多），
    // 真正失败会在接下来的 tools/call 上暴露出来
    await post(request, { jsonrpc: '2.0', method: 'notifications/initialized' }, session, connectMs)
    return session
  }

  async function invoke(request: McpToolRequest, session: string | null): Promise<unknown> {
    const response = await post(
      request,
      {
        jsonrpc: '2.0',
        id: nextId++,
        method: 'tools/call',
        params: { name: request.tool, arguments: request.args }
      },
      session,
      totalMs
    )
    if (!response.ok) throw searchHttpFailure(response.status)

    const message = await readJsonRpcMessage(response)
    if ('error' in message) {
      const { message: text, retryable } = rpcErrorMessage(message.error)
      throw new SearchTransportError(text, { kind: 'protocol', retryable })
    }
    if (!('result' in message)) {
      throw new SearchTransportError('搜索服务返回了看不懂的响应', {
        kind: 'protocol',
        retryable: false
      })
    }
    return message.result
  }

  return {
    sessionCount: () => sessions.size,
    async callTool(request) {
      const key = request.sessionKey ?? request.endpoint
      let lastError: SearchTransportError | null = null

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const hasCached = sessions.has(key)
          const session = hasCached ? (sessions.get(key) ?? null) : await openSession(request)
          if (!hasCached) sessions.set(key, session)
          const result = await invoke(request, session)
          return result
        } catch (error) {
          const failure =
            error instanceof SearchTransportError
              ? error
              : new SearchTransportError('搜索失败（未知错误）', {
                  kind: 'network',
                  retryable: false
                })
          lastError = failure
          if (!failure.retryable || attempt === 2) throw failure
          // 会话可能是失效的那一个：丢掉缓存，退避后重建一次
          sessions.delete(key)
          if (retryDelay > 0) await delay(retryDelay)
        }
      }
      throw (
        lastError ??
        new SearchTransportError('搜索失败（未知错误）', {
          kind: 'network',
          retryable: false
        })
      )
    }
  }
}

/** MCP 工具结果里的文本（`content[].text` 拼起来；没有就回空串） */
export function mcpResultText(result: unknown): string {
  if (!isRecord(result)) return ''
  const content = result.content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : ''
    )
    .filter((text) => text !== '')
    .join('\n')
    .trim()
}

/** MCP 工具结果是不是错误（`result.isError === true`；错误文本在 `mcpResultText` 里） */
export function mcpResultIsError(result: unknown): boolean {
  return isRecord(result) && result.isError === true
}
