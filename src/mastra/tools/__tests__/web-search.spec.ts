// @vitest-environment node
/**
 * web_search 工具（round 45）：薄壳的三件事 —— 条数 clamp、输出排版、审批档（与 fetch 同档）。
 * 链路本身（客户端 + 后端链）在 search/__tests__ 里钉；这里注入假客户端，不真连网。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_WEB_SEARCH_RUNTIME } from '../../../shared/search'
import type { McpClient, McpToolRequest } from '../../search/mcp-client'
import { clampNumResults, createWebSearchTool } from '../web-search'
import { callTool, createBed, type TestBed } from './helpers'

const EXA_TEXT = `Title: 北京-天气预报
URL: https://www.nmc.cn/publish/forecast/ABJ/beijing.html
Published: N/A
Highlights:
晴 26℃

---

Title: 第二篇
URL: https://second.test/x
Published: 2026-10-11
Highlights:
内容二`

/** 假客户端：回一份 Exa 文本块结果，并把每次调用记下来 */
function fakeClient(
  responder: (request: McpToolRequest) => unknown = () => ({
    content: [{ type: 'text', text: EXA_TEXT }]
  })
): { client: McpClient; seen: McpToolRequest[] } {
  const seen: McpToolRequest[] = []
  return {
    seen,
    client: {
      sessionCount: () => 0,
      async callTool(request: McpToolRequest): Promise<unknown> {
        seen.push(request)
        return responder(request)
      }
    }
  }
}

let bed: TestBed

beforeEach(() => {
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
})

describe('clampNumResults：缺省 5，clamp ≤ 10', () => {
  it('缺省 / 小数 / 越界都收进 [1, 10]', () => {
    expect(clampNumResults(undefined)).toBe(5)
    expect(clampNumResults(3)).toBe(3)
    expect(clampNumResults(3.9)).toBe(3)
    expect(clampNumResults(25)).toBe(10)
    expect(clampNumResults(0)).toBe(1)
    expect(clampNumResults(-4)).toBe(1)
  })
})

describe('web_search：输出与条数', () => {
  it('结构化输出：标题 / URL / 摘要 / 发布时间（N/A 不显示）+ 后端名', async () => {
    const { client } = fakeClient()
    const tool = await createWebSearchTool(bed.ctx, { deps: { client } })

    const out = String(await callTool(tool, { query: '北京天气' }))

    expect(out).toContain('联网搜索「北京天气」（后端：免费档）')
    expect(out).toContain('1. 北京-天气预报')
    expect(out).toContain('   URL: https://www.nmc.cn/publish/forecast/ABJ/beijing.html')
    expect(out).toContain('   摘要: 晴 26℃')
    expect(out).toContain('2. 第二篇')
    expect(out).toContain('   发布: 2026-10-11')
  })

  it('numResults 透传并 clamp：给 25 只取 10，不给就是 5', async () => {
    const first = fakeClient()
    const tool = await createWebSearchTool(bed.ctx, { deps: { client: first.client } })
    await callTool(tool, { query: 'a', numResults: 25 })
    expect(first.seen[0].args).toMatchObject({ numResults: 10 })

    const second = fakeClient()
    const tool2 = await createWebSearchTool(bed.ctx, { deps: { client: second.client } })
    await callTool(tool2, { query: 'b' })
    expect(second.seen[0].args).toMatchObject({ numResults: 5 })
  })

  it('解析不出结构化结果：回后端原文（模型自己读）', async () => {
    const { client } = fakeClient(() => ({
      content: [{ type: 'text', text: '一段没有字段的自由文本' }]
    }))
    const tool = await createWebSearchTool(bed.ctx, { deps: { client } })

    const out = String(await callTool(tool, { query: 'q' }))
    expect(out).toContain('一段没有字段的自由文本')
  })

  it('运行时的自定义配置被用上（Key 拼进端点）', async () => {
    const { client, seen } = fakeClient()
    const tool = await createWebSearchTool(bed.ctx, {
      runtime: () => ({
        settings: { ...DEFAULT_WEB_SEARCH_RUNTIME.settings, mode: 'custom' },
        searchKey: 'exa-key',
        readerKey: null
      }),
      deps: { client }
    })

    const out = String(await callTool(tool, { query: 'q' }))
    expect(new URL(seen[0].endpoint).searchParams.get('exaApiKey')).toBe('exa-key')
    expect(out).toContain('后端：自定义 Exa')
  })

  it('全部后端失败：工具抛人话（含"设置里填 Key"的指引）', async () => {
    const { client } = fakeClient(() => {
      throw new Error('连不上搜索服务（检查网络或代理）')
    })
    const tool = await createWebSearchTool(bed.ctx, { deps: { client } })

    await expect(callTool(tool, { query: 'q' })).rejects.toThrow(
      /联网搜索失败：连不上搜索服务（检查网络或代理）。可以在「设置 → 模型 → 联网搜索」里填自己的 Key 增强稳定性/
    )
  })
})

describe('web_search：审批档（与 fetch 同档）', () => {
  it('默认问；full 工作区免审；落了 (工具×工作区) 规则也免审', async () => {
    const tool = await createWebSearchTool(bed.ctx, { deps: { client: fakeClient().client } })
    const gate = tool.requireApproval as unknown as (input: { query: string }) => boolean

    expect(gate({ query: 'x' })).toBe(true)
    bed.roots[0].mode = 'full'
    expect(gate({ query: 'x' })).toBe(false)
    bed.roots[0].mode = 'ask'

    bed.rules.push({ tool: 'web_search', workspace: bed.root, mode: 'allow' })
    expect(gate({ query: 'x' })).toBe(false)
  })

  it('描述里说清"什么时候用"与"不走这里"（单页正文用 fetch 阅读模式）', async () => {
    const tool = await createWebSearchTool(bed.ctx, { deps: { client: fakeClient().client } })
    expect(tool.id).toBe('web_search')
    expect(typeof tool.requireApproval).toBe('function')
    expect(tool.description).toContain('mode: "reader"')
    expect(tool.description).toContain('not this tool')
  })
})
