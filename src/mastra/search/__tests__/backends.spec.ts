// @vitest-environment node
/**
 * 后端链（round 45）：**用户配置的自定义后端（若已配）→ 免费 Exa MCP**，前者失败自动回退后者；
 * 全部失败给人话 + "去设置里填 Key"的指引。解析部分用主控实测到的 Exa 文本块形状钉住。
 * 不真连网：客户端与 Tavily 的 fetch 都是注入的假件。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WEB_SEARCH_RUNTIME,
  TAVILY_SEARCH_ENDPOINT,
  WEB_SEARCH_PRESET,
  type WebSearchRuntime
} from '../../../shared/search'
import { humanSearchMessage, parseExaResults, parseTavilyResults, runWebSearch } from '../backends'
import {
  createMcpClient,
  SearchTransportError,
  type McpClient,
  type McpToolRequest
} from '../mcp-client'

/** 主控实测（2026-10-11 mcp.exa.ai）的文本块形状：`Title/URL/Published/Author/Highlights` + `---` */
const EXA_TEXT = `Title: 北京-天气预报
URL: https://www.nmc.cn/publish/forecast/ABJ/beijing.html
Published: N/A
Author: N/A
Highlights:
北京-天气预报

 雷达图

---

Title: 第二篇
URL: https://second.test/x
Published: 2026-10-11
Author: A
Highlights:
内容二 的 正文`

function fakeClient(responder: (request: McpToolRequest) => unknown): {
  client: McpClient
  seen: McpToolRequest[]
} {
  const seen: McpToolRequest[] = []
  return {
    seen,
    client: {
      sessionCount: () => 0,
      async callTool(request) {
        seen.push(request)
        return responder(request)
      }
    }
  }
}

function exaTextResult(text: string): unknown {
  return { content: [{ type: 'text', text }] }
}

const freeRuntime: WebSearchRuntime = DEFAULT_WEB_SEARCH_RUNTIME

function runtimeOf(patch: Partial<WebSearchRuntime>): WebSearchRuntime {
  return { ...DEFAULT_WEB_SEARCH_RUNTIME, ...patch }
}

/** 假 fetch（Tavily 用）：记下请求，回一份 Tavily 形状的 JSON */
function stubFetch(responder: (init: RequestInit | undefined) => Response | Promise<Response>): {
  fetchImpl: typeof fetch
  calls: Array<{ url: string; init: RequestInit | undefined }>
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return await responder(init)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('parseExaResults：Exa 文本块 → 结构化', () => {
  it('两条结果都解析出来；Published 是 N/A 就不带这个字段', () => {
    const hits = parseExaResults(EXA_TEXT)
    expect(hits).toHaveLength(2)
    expect(hits[0]).toEqual({
      title: '北京-天气预报',
      url: 'https://www.nmc.cn/publish/forecast/ABJ/beijing.html',
      snippet: '北京-天气预报 雷达图'
    })
    expect(hits[1].published).toBe('2026-10-11')
    expect(hits[1].snippet).toBe('内容二 的 正文')
  })

  it('空文本 → 空数组（不是一条空结果）', () => {
    expect(parseExaResults('')).toEqual([])
    expect(parseExaResults('随便一段没有字段的文字')).toEqual([])
  })
})

describe('parseTavilyResults：Tavily JSON → 结构化', () => {
  it('认 results[].title/url/content/published_date；缺字段的条目跳过', () => {
    const hits = parseTavilyResults({
      results: [
        { title: 'T', url: 'https://t.test', content: '正文', published_date: '2026-01-02' },
        { url: 'https://only-url.test' },
        { title: 'no url' },
        null,
        42
      ]
    })
    expect(hits).toEqual([
      { title: 'T', url: 'https://t.test', snippet: '正文', published: '2026-01-02' },
      { title: 'https://only-url.test', url: 'https://only-url.test', snippet: '' },
      { title: 'no url', url: '', snippet: '' }
    ])
    expect(parseTavilyResults({})).toEqual([])
    expect(parseTavilyResults(null)).toEqual([])
  })
})

describe('runWebSearch：后端链', () => {
  it('免费档：打 Exa MCP 端点（不带 Key），回结构化结果', async () => {
    const { client, seen } = fakeClient(() => exaTextResult(EXA_TEXT))
    const outcome = await runWebSearch(
      { runtime: freeRuntime, query: '北京天气', numResults: 3 },
      { client }
    )

    expect(outcome.backend).toBe('exa-mcp-free')
    expect(outcome.hits).toHaveLength(2)
    expect(outcome.fallbackNote).toBeUndefined()
    expect(seen[0].endpoint).toBe(WEB_SEARCH_PRESET.exaEndpoint)
    expect(seen[0].tool).toBe('web_search_exa')
    expect(seen[0].args).toEqual({ query: '北京天气', numResults: 3 })
  })

  it('自定义 Exa：Key 拼进端点（?exaApiKey=），元数据里带上它', async () => {
    const { client, seen } = fakeClient(() => exaTextResult(EXA_TEXT))
    const outcome = await runWebSearch(
      {
        runtime: runtimeOf({
          settings: { ...freeRuntime.settings, mode: 'custom', provider: 'exa' },
          searchKey: 'exa-secret'
        }),
        query: 'q',
        numResults: 5
      },
      { client }
    )

    expect(outcome.backend).toBe('exa-mcp-key')
    expect(new URL(seen[0].endpoint).searchParams.get('exaApiKey')).toBe('exa-secret')
  })

  it('自定义失败 → 自动回退免费档（带一行说明），免费档结果照回', async () => {
    const { client, seen } = fakeClient((request) => {
      if (request.endpoint.includes('exaApiKey')) {
        throw new SearchTransportError('搜索服务拒绝了这把 Key（可能无效或没有权限）', {
          kind: 'http',
          retryable: false,
          status: 401
        })
      }
      return exaTextResult(EXA_TEXT)
    })
    const outcome = await runWebSearch(
      {
        runtime: runtimeOf({
          settings: { ...freeRuntime.settings, mode: 'custom' },
          searchKey: 'bad-key'
        }),
        query: 'q',
        numResults: 5
      },
      { client }
    )

    expect(outcome.backend).toBe('exa-mcp-free')
    expect(outcome.hits).toHaveLength(2)
    expect(outcome.fallbackNote).toContain('已改用免费档')
    expect(seen).toHaveLength(2)
    expect(seen[1].endpoint).toBe(WEB_SEARCH_PRESET.exaEndpoint)
  })

  it('两级都失败 → 抛人话，含"填 Key"的指引，不含内部术语', async () => {
    const { client } = fakeClient(() => {
      throw new SearchTransportError('连不上搜索服务（检查网络或代理）', {
        kind: 'network',
        retryable: true
      })
    })

    const error = await runWebSearch(
      {
        runtime: runtimeOf({
          settings: { ...freeRuntime.settings, mode: 'custom' },
          searchKey: 'k'
        }),
        query: 'q',
        numResults: 5
      },
      { client }
    ).catch((caught: unknown) => caught)

    const message = (error as Error).message
    expect(message).toContain('联网搜索失败')
    expect(message).toContain('设置 → 模型 → 联网搜索')
    expect(message).not.toContain('MCP')
    expect(message).not.toContain('exaApiKey')
  })

  it('免费档被限流（Exa 回包里 isError）→ 人话错误 + 指引', async () => {
    const { client } = fakeClient(() => ({
      isError: true,
      content: [
        {
          type: 'text',
          text: "You've hit Exa's free MCP rate limit. Create API key at https://dashboard.exa.ai"
        }
      ]
    }))

    await expect(
      runWebSearch({ runtime: freeRuntime, query: 'q', numResults: 5 }, { client })
    ).rejects.toThrow(/限流/)
  })

  it('自定义 Tavily：POST 到 Tavily 端点（Key 进 body 与 Bearer 头），解析它的 JSON', async () => {
    const { fetchImpl, calls } = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            results: [{ title: 'T', url: 'https://t.test', content: '正文' }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    const outcome = await runWebSearch(
      {
        runtime: runtimeOf({
          settings: { ...freeRuntime.settings, mode: 'custom', provider: 'tavily' },
          searchKey: 'tvly-1'
        }),
        query: 'q',
        numResults: 2
      },
      { fetchImpl }
    )

    expect(outcome.backend).toBe('tavily-key')
    expect(outcome.hits).toEqual([{ title: 'T', url: 'https://t.test', snippet: '正文' }])
    expect(calls[0].url).toBe(TAVILY_SEARCH_ENDPOINT)
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer tvly-1')
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      api_key: 'tvly-1',
      query: 'q',
      max_results: 2
    })
  })

  it('自定义 Tavily 失败 → 回退免费档', async () => {
    const { client } = fakeClient(() => exaTextResult(EXA_TEXT))
    const { fetchImpl } = stubFetch(() => new Response('no', { status: 500 }))
    const outcome = await runWebSearch(
      {
        runtime: runtimeOf({
          settings: { ...freeRuntime.settings, mode: 'custom', provider: 'tavily' },
          searchKey: 'tvly-1'
        }),
        query: 'q',
        numResults: 2
      },
      { client, fetchImpl }
    )
    expect(outcome.backend).toBe('exa-mcp-free')
    expect(outcome.fallbackNote).toContain('免费档')
  })

  it('选了自定义但没填 Key：当"没这一路"，直接走免费档（不算失败）', async () => {
    const { client, seen } = fakeClient(() => exaTextResult(EXA_TEXT))
    const outcome = await runWebSearch(
      {
        runtime: runtimeOf({
          settings: { ...freeRuntime.settings, mode: 'custom' },
          searchKey: null
        }),
        query: 'q',
        numResults: 2
      },
      { client }
    )
    expect(outcome.backend).toBe('exa-mcp-free')
    expect(outcome.fallbackNote).toBeUndefined()
    expect(seen).toHaveLength(1)
  })

  it('解析不出结构化结果：原样把后端文本放 raw（工具透传）', async () => {
    const { client } = fakeClient(() => exaTextResult('这里是一段没有字段的自由文本'))
    const outcome = await runWebSearch(
      { runtime: freeRuntime, query: 'q', numResults: 2 },
      { client }
    )
    expect(outcome.hits).toEqual([])
    expect(outcome.raw).toContain('自由文本')
  })
})

describe('humanSearchMessage / 缺省客户端', () => {
  it('SearchTransportError 的 message 直接放行；其它错误回兜底人话', () => {
    expect(
      humanSearchMessage(new SearchTransportError('限流了', { kind: 'http', retryable: false }))
    ).toBe('限流了')
    expect(humanSearchMessage('字符串错误')).toBe('搜索服务出错')
    expect(humanSearchMessage(new Error(''))).toBe('搜索服务出错')
  })

  it('不传 client 时自己建一份（等价于 createMcpClient，注入 fetch 就能跑）', async () => {
    const client = createMcpClient({
      fetchImpl: async () => new Response('', { status: 429 })
    })
    expect(client.sessionCount()).toBe(0)
  })
})
