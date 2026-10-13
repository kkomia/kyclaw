import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type McpServerConfig } from '@shared/settings'
import { ToolCard } from './ToolCard'
import { toToolCardPart } from './tool-part'

/**
 * round 75「渐进披露」的解包：MCP 工具不再逐件注入，每个 server 只剩一个元工具
 * `mcp__<serverId>__meta`（`{action:'list'}` 看清单 / `{action:'call', tool, args}` 真调用）。
 * 服务端闸门一直按**真名**工作，渲染端这几处（工具卡 / 审批卡 / 轨迹行）必须把壳剥掉，
 * 否则用户看到的是元工具名 + `{action,tool,args}` 这层内部结构。
 *
 * 认不出就不猜：非元工具（内置工具、逐件注入的小 server 工具）**一个字段都不动**。
 */
function mcpServer(): McpServerConfig {
  return {
    id: 'mcp-1',
    name: 'kybase',
    transport: 'http',
    url: 'http://127.0.0.1:8765/mcp',
    enabled: true,
    readOnlyTools: []
  }
}

/** 元工具真调用（服务端 wire 上的形状） */
function metaCall(tool: string, args: unknown): Record<string, unknown> {
  return { action: 'call', tool, args }
}

/**
 * 造一个工具 part：toToolCardPart 只读它认识的那几个字段，wire 上多带的（toolCallId / text …）
 * 照原样留着 —— 这里把字面量标成"宽对象"，免得 TS 的过量属性检查跟真实 part 的形状打架。
 */
function partOf(fields: Record<string, unknown>): Parameters<typeof toToolCardPart>[0] {
  return fields
}

describe('toToolCardPart：元工具解包成真名与真入参', () => {
  it('dynamic-tool 形态的 call：toolName 换成 mcp__<server>__<tool>，input 换成真入参', () => {
    const part = toToolCardPart(
      partOf({
        type: 'dynamic-tool',
        toolName: 'mcp__mcp-1__meta',
        toolCallId: 'c1',
        state: 'output-available',
        input: metaCall('search', { query: 'kyclaw', path: 'docs/a.md' }),
        output: '结果'
      })
    )

    expect(part).not.toBeNull()
    expect(part?.toolName).toBe('mcp__mcp-1__search')
    // 入参是**真入参**，不是元工具那层 {action,tool,args}
    expect(part?.input).toEqual({ query: 'kyclaw', path: 'docs/a.md' })
    expect(part?.state).toBe('output-available')
    expect(part?.output).toBe('结果')
  })

  it('静态 tool- 形态（`tool-mcp__mcp-1__meta`）同样解包', () => {
    const part = toToolCardPart(
      partOf({
        type: 'tool-mcp__mcp-1__meta',
        toolCallId: 'c2',
        state: 'output-available',
        input: metaCall('echo', { msg: 'hi' })
      })
    )

    expect(part?.toolName).toBe('mcp__mcp-1__echo')
    expect(part?.input).toEqual({ msg: 'hi' })
  })

  it('list 档不解包（清单就是元工具自己在回答，没有真名可换）；形状不对也不猜', () => {
    const list = { action: 'list' }
    expect(
      toToolCardPart({
        type: 'dynamic-tool',
        toolName: 'mcp__mcp-1__meta',
        state: 'input-available',
        input: list
      })
    ).toEqual({
      toolName: 'mcp__mcp-1__meta',
      state: 'input-available',
      input: list,
      output: undefined,
      errorText: undefined
    })

    for (const input of [
      { action: 'call' },
      { action: 'call', tool: '' },
      { action: 'call', tool: 7 },
      { tool: 'search', args: {} },
      null,
      'x'
    ]) {
      expect(
        toToolCardPart({
          type: 'dynamic-tool',
          toolName: 'mcp__mcp-1__meta',
          state: 'input-available',
          input
        })?.toolName,
        JSON.stringify(input)
      ).toBe('mcp__mcp-1__meta')
    }
  })

  it('非元工具一个字段都不动（内置工具 / 逐件注入的 MCP 工具）', () => {
    // 内置工具：与解包前逐字段相等
    expect(
      toToolCardPart(
        partOf({
          type: 'tool-read',
          state: 'output-available',
          input: { path: 'a.txt' },
          output: '内容'
        })
      )
    ).toEqual({
      toolName: 'read',
      state: 'output-available',
      input: { path: 'a.txt' },
      output: '内容',
      errorText: undefined
    })

    // 逐件注入的小 server：名字是 `mcp__<server>__<tool>`，本身**不是**元工具 → 原样
    const input = { action: 'call', tool: 'search', args: { q: 'x' } }
    const injected = toToolCardPart({
      type: 'dynamic-tool',
      toolName: 'mcp__mcp-2__echo',
      state: 'output-available',
      input
    })
    expect(injected?.toolName).toBe('mcp__mcp-2__echo')
    expect(injected?.input).toBe(input)

    expect(toToolCardPart(partOf({ type: 'text', text: 'x' }))).toBeNull()
  })
})

describe('工具卡：显示真名与真入参（round 75）', () => {
  it('元工具调用渲染成「kybase · search」+ 真入参，不再露 mcp__mcp-1__meta 与 action/tool/args', () => {
    useSettingsStore.setState({
      settings: { ...defaultSettings(), mcpServers: [mcpServer()] },
      loaded: true
    })
    try {
      const part = toToolCardPart(
        partOf({
          type: 'dynamic-tool',
          toolName: 'mcp__mcp-1__meta',
          toolCallId: 'c1',
          state: 'output-available',
          input: metaCall('search', { path: 'docs/a.md', query: 'kyclaw' }),
          output: '找到 3 条'
        })
      )
      expect(part).not.toBeNull()

      render(<ToolCard part={part!} />)

      const card = screen.getByTestId('tool-card')
      expect(card).toHaveAttribute('data-tool', 'mcp__mcp-1__search')
      expect(card).toHaveTextContent('kybase · search')
      expect(card).not.toHaveTextContent('mcp__mcp-1__meta')
      // 行详情取的是真入参里的 path（元工具那层没有 path）
      expect(screen.getByTestId('tool-detail')).toHaveTextContent('docs/a.md')

      fireEvent.click(screen.getByTestId('tool-row'))
      const shown = screen.getByTestId('tool-input')
      expect(shown).toHaveTextContent('docs/a.md')
      expect(shown).toHaveTextContent('kyclaw')
      expect(shown).not.toHaveTextContent('"action"')
      expect(shown).not.toHaveTextContent('"args"')
    } finally {
      useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
    }
  })

  it('逐件注入的 MCP 工具照旧（`mcp__mcp-1__echo` 就显示 echo 自己）', () => {
    useSettingsStore.setState({
      settings: { ...defaultSettings(), mcpServers: [mcpServer()] },
      loaded: true
    })
    try {
      const part = toToolCardPart({
        type: 'dynamic-tool',
        toolName: 'mcp__mcp-1__echo',
        state: 'output-available',
        input: { msg: 'hi' },
        output: 'hi'
      })
      render(<ToolCard part={part!} />)

      expect(screen.getByTestId('tool-card')).toHaveTextContent('kybase · echo')
    } finally {
      useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
    }
  })
})
