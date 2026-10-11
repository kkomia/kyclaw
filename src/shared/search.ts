/**
 * 联网搜索的契约（round 45）：把"搜索后端怎么选、地址怎么拼、Key 存哪儿"收敛在一处 ——
 * 设置页表单、主进程现读、搜索客户端三方共用同一份口径。
 *
 * 用户口径（2026-10-11）：内置 web_search **默认走免费档**（Exa 的 MCP 端点，不用填 Key）；
 * 想升级配额与稳定性可以填自己的 Key（Exa / Tavily）；正文阅读走 Jina Reader（可填 Jina Key）。
 *
 * 本机实测（2026-10-11，主控）：
 *   - `https://mcp.exa.ai/mcp` 是 streamable HTTP MCP，`initialize` → `notifications/initialized`
 *     → `tools/call`（`web_search_exa`，参数 `{query, numResults}`）返回 SSE；无 Key 可用。
 *   - 免费档有**速率限制**，回包里直接给出口径：建 API Key 后把端点换成
 *     `https://mcp.exa.ai/mcp?exaApiKey=YOUR_EXA_API_KEY`（EXA_API_KEY_PARAM 就是它）。
 *   - `https://r.jina.ai/<url>` 无 Key 可用，返回 Markdown 正文（HTTP 200）。
 *   - `https://s.jina.ai`（Jina 搜索）要 Key —— **不做免费搜索后端**，Jina Key 只管正文阅读。
 *
 * 与 `shared/translate.ts` 同一套纪律：地址/模式是普通设置（落 shared/settings 的 webSearch），
 * Key 走 safeStorage 保留槽位（下面的 SEARCH_KEY_SECRET_ID）；渲染端**永远看不到明文**。
 */
import { z } from './zod'

/** 自定义档可选的服务商（免费档固定是 Exa MCP） */
export const SEARCH_PROVIDERS = ['exa', 'tavily'] as const
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number]

/** 后端模式：`free` = 免费档（Exa MCP，无 Key，默认）；`custom` = 用用户自己的 Key */
export const WEB_SEARCH_MODES = ['free', 'custom'] as const
export type WebSearchMode = (typeof WEB_SEARCH_MODES)[number]

/**
 * 预置端点（读盘为空时表单与主进程都按它兜底 —— 与语义召回/思考翻译的预置口径一致）。
 * `exaEndpoint` 免费档与自定义 Exa 共用（自定义只是多拼一个 `?exaApiKey=`）。
 */
export const WEB_SEARCH_PRESET = {
  exaEndpoint: 'https://mcp.exa.ai/mcp',
  readerEndpoint: 'https://r.jina.ai'
} as const

/** Tavily 的搜索端点（REST；`POST` JSON，Key 走请求体的 `api_key` 字段） */
export const TAVILY_SEARCH_ENDPOINT = 'https://api.tavily.com/search'

/** Exa MCP 里搜索工具的名字（免费档与自定义档共用同一个工具） */
export const EXA_MCP_SEARCH_TOOL = 'web_search_exa'

/** 自定义 Exa Key 的查询参数名（Exa 官方给的口径：`?exaApiKey=...`） */
export const EXA_API_KEY_PARAM = 'exaApiKey'

/** 搜索条数：缺省 5，最多 10（工具层 clamp，见 tools/web-search.ts） */
export const WEB_SEARCH_DEFAULT_RESULTS = 5
export const WEB_SEARCH_MAX_RESULTS = 10

/**
 * Key 在 secrets.json 里的保留槽位（与 provider 密钥 / 嵌入密钥 / 翻译密钥同一套通道）。
 * 分槽存：换服务商时旧 Key 不会串味；Jina 的 Key 与搜索链无关（只管正文阅读）。
 */
export const SEARCH_KEY_SECRET_ID = {
  exa: 'search-exa',
  tavily: 'search-tavily',
  jina: 'reader-jina'
} as const

/** 可写 Key 的三档（IPC 入参与设置页表单共用这个顺序） */
export const SEARCH_KEY_TARGETS = ['exa', 'tavily', 'jina'] as const
export type SearchKeyTarget = (typeof SEARCH_KEY_TARGETS)[number]

/**
 * 「联网搜索」设置。`mode` / `provider` 是显式选择；两个地址是预置项（**读盘为空按预置填、
 * 读盘不静默改写** —— 用户清空保存就是清空，生效值由 effectiveWebSearch 统一兜底）。
 */
export const webSearchSettingsSchema = z.strictObject({
  mode: z.enum(WEB_SEARCH_MODES),
  provider: z.enum(SEARCH_PROVIDERS),
  /** Exa MCP 端点（免费档与自定义 Exa 共用） */
  exaEndpoint: z.string(),
  /** 正文阅读（Jina Reader）端点 */
  readerEndpoint: z.string()
})

export type WebSearchSettings = z.infer<typeof webSearchSettingsSchema>

/** 缺省：免费档 + Exa + 预置端点（开箱即用，不用填任何 Key） */
export const DEFAULT_WEB_SEARCH: WebSearchSettings = {
  mode: 'free',
  provider: 'exa',
  exaEndpoint: WEB_SEARCH_PRESET.exaEndpoint,
  readerEndpoint: WEB_SEARCH_PRESET.readerEndpoint
}

/**
 * 生效的搜索设置：落盘为空串时按预置填 —— **表单与主进程用同一份兜底**，
 * 于是"设置页里看见的那两个地址"就是"搜索时真会用的那两个"。
 */
export function effectiveWebSearch(settings: WebSearchSettings): WebSearchSettings {
  const text = (value: string, fallback: string): string =>
    value.trim() === '' ? fallback : value.trim()
  return {
    mode: settings.mode,
    provider: settings.provider,
    exaEndpoint: text(settings.exaEndpoint, WEB_SEARCH_PRESET.exaEndpoint),
    readerEndpoint: text(settings.readerEndpoint, WEB_SEARCH_PRESET.readerEndpoint)
  }
}

/**
 * 自定义 Exa 的 MCP 端点：把 Key 拼成查询参数（Exa 官方口径）。没 Key 就原样返回
 * （免费档走同一个函数，只是 apiKey 传 null）。
 */
export function exaEndpointWithKey(endpoint: string, apiKey: string | null): string {
  const base = endpoint.trim().replace(/\/+$/, '')
  if (apiKey === null || apiKey === '') return base
  const url = new URL(base)
  url.searchParams.set(EXA_API_KEY_PARAM, apiKey)
  return url.toString()
}

/** Jina Reader 的目标地址：`{endpoint}/{原文 url}`（尾斜杠归一，避免 `//https`） */
export function readerTargetUrl(endpoint: string, target: string): string {
  return `${endpoint.trim().replace(/\/+$/, '')}/${target}`
}

/**
 * 工具运行时现读的一份配置：设置 + 两个可选 Key（从 safeStorage 解出来的明文，
 * 只活在主进程内存里）。缺省值 = 免费档 + 没 Key，所以工具在没接线时也能跑。
 */
export interface WebSearchRuntime {
  settings: WebSearchSettings
  /** 自定义搜索后端的 Key（按设置里的 provider 取；null = 没配，链上就跳过自定义档） */
  searchKey: string | null
  /** 正文阅读的 Jina Key（null = 走无 Key 免费档） */
  readerKey: string | null
}

export const DEFAULT_WEB_SEARCH_RUNTIME: WebSearchRuntime = {
  settings: DEFAULT_WEB_SEARCH,
  searchKey: null,
  readerKey: null
}

/** 一条搜索结果（后端无关的统一形状；工具输出与单测都按它断言） */
export interface SearchHit {
  title: string
  url: string
  /** 摘要 / 高亮片段（可能为空） */
  snippet: string
  /** 发布时间（后端没给就没有） */
  published?: string
}
