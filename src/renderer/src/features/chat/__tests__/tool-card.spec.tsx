import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { Message } from '@renderer/features/chat/Message'
import { ToolCard } from '@renderer/features/chat/parts/ToolCard'
import { RESULT_PREVIEW_CHARS } from '@renderer/features/chat/parts/tool-part'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { formatToolName } from '@shared/mcp'
import { defaultSettings, type McpServerConfig } from '@shared/settings'

/**
 * 工具行（round 6 起是"行 + 折叠体"形态，对照《对话UI-工具链与显示口径 v0.1》§1.4-§1.6）：
 * 状态取自 AI SDK 的 tool part 状态机（spec §7.1）；行默认折着（单步没有自动展开档），
 * 展开体 = 入参 + 结果（结果恒 600 字截断）；收起是 grid-rows 折叠、不是条件渲染。
 * round 14：MCP 工具显示「服务名 · 工具名」（formatToolName，数据取 settings.mcpServers）。
 */
function mcpServer(): McpServerConfig {
  return {
    id: 'mcp-1',
    name: '知识库',
    transport: 'http',
    url: 'http://127.0.0.1:8765/mcp',
    enabled: true,
    readOnlyTools: []
  }
}
describe('ToolCard 行与折叠体', () => {
  it('input-streaming：参数还在流进来（没有可展开的东西，行不是按钮）', () => {
    render(<ToolCard part={{ toolName: 'read', state: 'input-streaming' }} running />)

    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-state', 'input-streaming')
    expect(screen.getByTestId('tool-card')).toHaveTextContent('read')
    expect(screen.getByTestId('tool-state')).toHaveTextContent('准备参数')
    expect(screen.queryByTestId('tool-row')).not.toBeInTheDocument()
  })

  it('input-available：流式中显示"调用中"（流光），轮次结束后显示"已调用"（没回执不装进行中）', () => {
    const { unmount } = render(
      <ToolCard part={{ toolName: 'write', state: 'input-available' }} running />
    )
    expect(screen.getByTestId('tool-state')).toHaveTextContent('调用中')
    expect(screen.getByTestId('tool-state').className).toContain('trace-live')
    unmount()

    render(<ToolCard part={{ toolName: 'write', state: 'input-available' }} />)
    expect(screen.getByTestId('tool-state')).toHaveTextContent('已调用')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'pending')
  })

  it('审批两档：等待审批 / 审批已回应（等待语义，语气签是"警告"）', () => {
    const { unmount } = render(
      <ToolCard part={{ toolName: 'write', state: 'approval-requested' }} />
    )
    expect(screen.getByTestId('tool-state')).toHaveTextContent('等待审批')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'waiting')
    unmount()

    render(<ToolCard part={{ toolName: 'write', state: 'approval-responded' }} />)
    expect(screen.getByTestId('tool-state')).toHaveTextContent('审批已回应')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'waiting')
  })

  it('output-available：默认折着；展开看到入参/行详情与结果；再收起内容仍在 DOM（grid-rows 折叠）', () => {
    render(
      <ToolCard
        part={{
          toolName: 'read',
          state: 'output-available',
          input: { path: 'a.txt' },
          output: '文件内容'
        }}
      />
    )

    expect(screen.getByTestId('tool-state')).toHaveTextContent('已完成')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'pending')
    // 行详情（入参里的 path）直接印在行上
    expect(screen.getByTestId('tool-detail')).toHaveTextContent('a.txt')
    // 单步默认折着：没开过就不上 DOM
    expect(screen.queryByTestId('tool-input')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tool-output')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('tool-row'))
    expect(screen.getByTestId('tool-row')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('tool-input')).toHaveTextContent('a.txt')
    expect(screen.getByTestId('tool-output')).toHaveTextContent('文件内容')

    // 收起：走容器级折叠（0fr），内容留在 DOM（不做条件渲染硬切）
    fireEvent.click(screen.getByTestId('tool-row'))
    expect(screen.getByTestId('tool-row')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('tool-output')).toBeInTheDocument()
    expect(screen.getByTestId('trace-fold')).toHaveAttribute('data-open', 'false')
  })

  it('output-error：展开后展示错误文本（危险语气）', () => {
    render(
      <ToolCard
        part={{ toolName: 'write', state: 'output-error', errorText: '工作区外路径被拒绝' }}
      />
    )

    expect(screen.getByTestId('tool-state')).toHaveTextContent('出错')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'error')
    fireEvent.click(screen.getByTestId('tool-row'))
    expect(screen.getByTestId('tool-output')).toHaveTextContent('工作区外路径被拒绝')
  })

  it('output-denied：用户拒绝后这一档（危险语气，不显示输出）', () => {
    render(
      <ToolCard part={{ toolName: 'write', state: 'output-denied', input: { path: 'b.txt' } }} />
    )

    expect(screen.getByTestId('tool-state')).toHaveTextContent('已拒绝')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'error')
    expect(screen.queryByTestId('tool-output')).not.toBeInTheDocument()
  })

  it('结果恒切 600 字：没有「加载全部」按钮、不提示截断（文档 §1.6）', () => {
    const long = 'x'.repeat(1200)
    render(<ToolCard part={{ toolName: 'read', state: 'output-available', output: long }} />)
    fireEvent.click(screen.getByTestId('tool-row'))

    expect(screen.getByTestId('tool-output').textContent).toHaveLength(RESULT_PREVIEW_CHARS)
    // 卡里没有第二个按钮（没有「加载全部」那种出口），也没有任何"加载"字样
    expect(screen.getByTestId('tool-card').querySelectorAll('button')).toHaveLength(1)
    expect(within(screen.getByTestId('tool-card')).queryByText(/加载/)).not.toBeInTheDocument()
  })

  it('第 600 位正好是代理对（星平面字符）也只切在整字符上，不吐半个', () => {
    const long = 'x'.repeat(RESULT_PREVIEW_CHARS - 1) + '😀'.repeat(40)
    render(<ToolCard part={{ toolName: 'read', state: 'output-available', output: long }} />)
    fireEvent.click(screen.getByTestId('tool-row'))

    const shown = screen.getByTestId('tool-output').textContent ?? ''
    expect(Array.from(shown)).toHaveLength(RESULT_PREVIEW_CHARS)
    expect(shown.endsWith('😀')).toBe(true)
    // 结尾不能是孤立的高代理（UTF-16 码元切片就会这样）
    expect(/[\uD800-\uDBFF]$/.test(shown)).toBe(false)
  })

  it('未知状态原样显示、按中性语气渲染（不猜）', () => {
    render(<ToolCard part={{ toolName: 'mcp__x__y', state: 'some-future-state' }} />)

    expect(screen.getByTestId('tool-state')).toHaveTextContent('some-future-state')
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-tone', 'pending')
  })

  it('审批类状态只做静态呈现：没有入参就没有可交互的行（交互在 ApprovalCard）', () => {
    render(<ToolCard part={{ toolName: 'write', state: 'approval-requested' }} />)

    expect(screen.getByTestId('tool-state')).toHaveTextContent('等待审批')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('助手消息里的工具 part（过程块包装）', () => {
  it('tool-* part 渲染成工具行；这一轮不是流式 → 过程块默认收起，点开后才可见', () => {
    const message = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'text', text: '先读文件：' },
        {
          type: 'tool-read',
          toolCallId: 'c1',
          state: 'output-available',
          input: { path: 'a.txt' },
          output: '内容'
        }
      ]
    } as unknown as UIMessage

    render(<Message message={message} />)

    expect(screen.getByTestId('message-text')).toHaveTextContent('先读文件：')
    expect(screen.getByTestId('trace-toggle')).toHaveTextContent('使用 1 个工具')
    // 跑完自动收起：行还没上 DOM
    expect(screen.queryByTestId('tool-card')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('trace-toggle'))
    const card = screen.getByTestId('tool-card')
    expect(card).toHaveAttribute('data-tool', 'read')
    expect(card).toHaveTextContent('已完成')
  })

  it('approval-requested 的 part（round 29）：只读工具行 —— 默认展开、没有审批按钮（决策在输入框上方的审批条）', () => {
    const message = {
      id: 'a2',
      role: 'assistant',
      parts: [
        {
          type: 'tool-write',
          toolCallId: 'c2',
          state: 'approval-requested',
          input: { path: 'a.txt', content: '内容' },
          approval: { id: 'run-1::c2' }
        }
      ]
    } as unknown as UIMessage

    render(<Message message={message} />)

    // 有待审批步骤：默认展开（不用先点块头），箭头照画、可收（round 29 不再锁死折叠）
    const block = screen.getByTestId('trace-block')
    expect(block).toHaveAttribute('data-open', 'true')
    expect(block).toHaveAttribute('data-pending', 'true')
    expect(screen.getByTestId('trace-toggle').querySelector('svg')).not.toBeNull()

    // 消息流里没有审批入口：只剩状态行（自己点开还能看入参）
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-state', 'approval-requested')
    expect(screen.getByTestId('tool-state')).toHaveTextContent('等待审批')
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-allow-once')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-deny')).not.toBeInTheDocument()
  })

  it('已回应的审批（approval-responded）：只是普通工具行，静态收束', () => {
    const message = {
      id: 'a3',
      role: 'assistant',
      parts: [
        {
          type: 'tool-write',
          toolCallId: 'c3',
          state: 'approval-responded',
          input: { path: 'a.txt', content: '内容' },
          approval: { id: 'run-1::c3', approved: true }
        }
      ]
    } as unknown as UIMessage

    render(<Message message={message} />)

    fireEvent.click(screen.getByTestId('trace-toggle'))
    expect(screen.getByTestId('tool-state')).toHaveTextContent('审批已回应')
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument()
  })
})

describe('MCP 工具显示名（round 14）：用户注册的名字', () => {
  it('formatToolName：已知 server → 「服务名 · 工具名」；未知 / 非 MCP 名原样', () => {
    const servers = [{ id: 'mcp-1', name: '知识库' }]
    expect(formatToolName('mcp__mcp-1__search', servers)).toBe('知识库 · search')
    expect(formatToolName('mcp__gone__search', servers)).toBe('mcp__gone__search')
    expect(formatToolName('read', servers)).toBe('read')
  })

  it('ToolCard 行显示「服务名 · 工具名」（不再是 mcp__mcp-1__search）', () => {
    useSettingsStore.setState({
      settings: { ...defaultSettings(), mcpServers: [mcpServer()] },
      loaded: true
    })
    try {
      render(
        <ToolCard
          part={{ toolName: 'mcp__mcp-1__search', state: 'output-available', output: 'ok' }}
        />
      )

      expect(screen.getByTestId('tool-card')).toHaveTextContent('知识库 · search')
      expect(screen.getByTestId('tool-card')).not.toHaveTextContent('mcp__mcp-1__search')
    } finally {
      useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
    }
  })
})

/**
 * round 85 · 行详情里的路径（用户实报 013：编辑工作区内文件时那一行铺出整条绝对路径，太长）。
 *
 * 口径：会话根内 → **工作区相对路径**（与文件树 / @ 引用 / 附件同口径）；根外、判不出根 → 原样。
 * 只改**这一行的显示**：展开的入参面板仍是模型看到的原样（`tool-input`），不改任何回执。
 */
describe('round 85 · 工具行的路径显示（根内相对、根外原样）', () => {
  const ROOT = 'D:\\ws'

  function withRoot(): void {
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        workspaces: [{ path: ROOT, mode: 'ask' }],
        defaultWorkspace: ROOT
      },
      loaded: true
    })
    // 没有会话（activeId null）时真根就是默认工作区本身 —— 这里量的是展示转换，会话目录那层见
    // session-workspace.spec
    useSessionsStore.setState({ activeId: null })
  }

  function restore(): void {
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
    useSessionsStore.setState({ activeId: null })
  }

  it('编辑根内文件：行详情是工作区相对路径；入参面板仍是原样绝对路径（模型看到的没变）', () => {
    withRoot()
    try {
      render(
        <ToolCard
          part={{
            toolName: 'edit',
            state: 'output-available',
            input: {
              path: 'D:\\ws\\src\\features\\chat\\Composer.tsx',
              oldText: 'a',
              newText: 'b'
            },
            output: '已更新'
          }}
        />
      )

      expect(screen.getByTestId('tool-detail')).toHaveTextContent('src/features/chat/Composer.tsx')
      fireEvent.click(screen.getByTestId('tool-row'))
      expect(screen.getByTestId('tool-input')).toHaveTextContent(
        'D:\\\\ws\\\\src\\\\features\\\\chat\\\\Composer.tsx'
      )
    } finally {
      restore()
    }
  })

  it('根外文件（下载目录一类）保持绝对路径：不改写、不假装它在工作区里', () => {
    withRoot()
    try {
      render(
        <ToolCard
          part={{
            toolName: 'read',
            state: 'output-available',
            input: { path: 'C:\\Users\\me\\Downloads\\report.pdf' },
            output: '内容'
          }}
        />
      )

      expect(screen.getByTestId('tool-detail')).toHaveTextContent(
        'C:\\Users\\me\\Downloads\\report.pdf'
      )
    } finally {
      restore()
    }
  })

  it('判不出根（没有工作区）：交出来的绝对路径照原样显示，不硬凑相对路径', () => {
    useSessionsStore.setState({ activeId: null })
    render(
      <ToolCard
        part={{
          toolName: 'read',
          state: 'output-available',
          input: { path: 'D:\\ws\\docs\\a.md' },
          output: '内容'
        }}
      />
    )

    expect(screen.getByTestId('tool-detail')).toHaveTextContent('D:\\ws\\docs\\a.md')
  })

  it('glob 的 pattern 命中根内也照样收（同一套转换，不挑工具名）', () => {
    withRoot()
    try {
      render(
        <ToolCard
          part={{
            toolName: 'glob',
            state: 'output-available',
            input: { pattern: 'D:\\ws\\src\\**\\*.ts' },
            output: 'src/a.ts'
          }}
        />
      )

      expect(screen.getByTestId('tool-detail')).toHaveTextContent('src/**/*.ts')
    } finally {
      restore()
    }
  })
})
