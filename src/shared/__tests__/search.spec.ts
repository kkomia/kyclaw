import { describe, expect, it } from 'vitest'
import { appSettingsPatchSchema, appSettingsSchema, DEFAULT_SETTINGS } from '../settings'
import {
  DEFAULT_WEB_SEARCH,
  effectiveWebSearch,
  exaEndpointWithKey,
  readerTargetUrl,
  SEARCH_KEY_SECRET_ID,
  WEB_SEARCH_PRESET,
  webSearchSettingsSchema
} from '../search'

/**
 * 联网搜索的契约（shared/search.ts）：预置兜底、Key 拼进端点、阅读地址拼接、schema 往返与收紧。
 * 生效口径只写一次（表单与主进程共用 effectiveWebSearch），这里把它的边界钉住。
 */
describe('effectiveWebSearch：读盘为空按预置填，不静默改写落盘', () => {
  it('缺省（免费档）：两个地址就是预置', () => {
    expect(effectiveWebSearch(DEFAULT_WEB_SEARCH)).toEqual({
      mode: 'free',
      provider: 'exa',
      exaEndpoint: WEB_SEARCH_PRESET.exaEndpoint,
      readerEndpoint: WEB_SEARCH_PRESET.readerEndpoint
    })
  })

  it('落盘为空串（用户清空过）：生效值按预置兜底；落盘对象本身不动', () => {
    const cleared = { ...DEFAULT_WEB_SEARCH, exaEndpoint: '', readerEndpoint: '   ' }
    expect(effectiveWebSearch(cleared)).toEqual({
      mode: 'free',
      provider: 'exa',
      exaEndpoint: WEB_SEARCH_PRESET.exaEndpoint,
      readerEndpoint: WEB_SEARCH_PRESET.readerEndpoint
    })
    // 不静默改写：传进去的对象一字未动
    expect(cleared.exaEndpoint).toBe('')
    expect(cleared.readerEndpoint).toBe('   ')
  })

  it('填了值就用填的值（trim 之后），模式与服务商原样透传', () => {
    expect(
      effectiveWebSearch({
        mode: 'custom',
        provider: 'tavily',
        exaEndpoint: '  https://mcp.example.com/mcp  ',
        readerEndpoint: 'http://127.0.0.1:9'
      })
    ).toEqual({
      mode: 'custom',
      provider: 'tavily',
      exaEndpoint: 'https://mcp.example.com/mcp',
      readerEndpoint: 'http://127.0.0.1:9'
    })
  })
})

describe('exaEndpointWithKey：自定义 Key 拼查询参数（Exa 官方口径）', () => {
  it('没 Key（免费档）原样返回，尾斜杠归一', () => {
    expect(exaEndpointWithKey('https://mcp.exa.ai/mcp/', null)).toBe('https://mcp.exa.ai/mcp')
    expect(exaEndpointWithKey('https://mcp.exa.ai/mcp', '')).toBe('https://mcp.exa.ai/mcp')
  })

  it('有 Key：拼成 ?exaApiKey=...（已有查询参数也不覆盖）', () => {
    const url = new URL(exaEndpointWithKey('https://mcp.exa.ai/mcp', 'exa-key-1'))
    expect(url.origin + url.pathname).toBe('https://mcp.exa.ai/mcp')
    expect(url.searchParams.get('exaApiKey')).toBe('exa-key-1')
  })
})

describe('readerTargetUrl：阅读模式的目标地址', () => {
  it('预置端点 + 原文 url：直接拼（尾斜杠归一，避免 //https）', () => {
    expect(readerTargetUrl('https://r.jina.ai/', 'https://example.com/a/b?x=1')).toBe(
      'https://r.jina.ai/https://example.com/a/b?x=1'
    )
  })
})

describe('webSearch 设置：schema 往返与收紧', () => {
  it('缺省值合法且能被 appSettingsSchema 收下；不可省（strict：少了它整份设置是不合法的）', () => {
    expect(appSettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true)
    const without = { ...DEFAULT_SETTINGS } as Record<string, unknown>
    delete without.webSearch
    expect(appSettingsSchema.safeParse(without).success).toBe(false)
  })

  it('模式与服务商只认枚举里的取值', () => {
    for (const mode of ['free', 'custom']) {
      expect(webSearchSettingsSchema.safeParse({ ...DEFAULT_WEB_SEARCH, mode }).success).toBe(true)
    }
    for (const provider of ['exa', 'tavily']) {
      expect(webSearchSettingsSchema.safeParse({ ...DEFAULT_WEB_SEARCH, provider }).success).toBe(
        true
      )
    }
    expect(webSearchSettingsSchema.safeParse({ ...DEFAULT_WEB_SEARCH, mode: 'auto' }).success).toBe(
      false
    )
    expect(
      webSearchSettingsSchema.safeParse({ ...DEFAULT_WEB_SEARCH, provider: 'serpapi' }).success
    ).toBe(false)
    expect(webSearchSettingsSchema.safeParse({ ...DEFAULT_WEB_SEARCH, extra: 1 }).success).toBe(
      false
    )
  })

  it('settings:update 的补丁收 webSearch（渲染端设置页走那条路）', () => {
    const patch = { webSearch: { ...DEFAULT_WEB_SEARCH, mode: 'custom' as const } }
    expect(appSettingsPatchSchema.safeParse(patch).success).toBe(true)
    expect(
      appSettingsPatchSchema.safeParse({ webSearch: { ...DEFAULT_WEB_SEARCH, mode: 'auto' } })
        .success
    ).toBe(false)
  })

  it('三个 Key 的槽位 id 互不相同（换服务商不串味）', () => {
    const ids = [SEARCH_KEY_SECRET_ID.exa, SEARCH_KEY_SECRET_ID.tavily, SEARCH_KEY_SECRET_ID.jina]
    expect(new Set(ids).size).toBe(3)
  })
})
