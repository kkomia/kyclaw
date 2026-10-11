import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type McpServerConfig, type Workspace } from '@shared/settings'
import { ApprovalCard, type ApprovalDecision } from '../ApprovalCard'
import type { ApprovalRequest } from '../approval'

/**
 * 审批卡（T13，RTL）：四个决策按钮各自 dispatch 正确的决策；diff 预览按行标注增删；
 * "永久允许"只在判得出工作区时出现。
 * round 14：MCP 工具的标题显示「服务名 · 工具名」（与 ToolCard 同一口径）。
 */
const WS: Workspace = { path: 'D:\\项目\\demo', mode: 'ask' }

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

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: 'run-1::call-1',
    toolCallId: 'call-1',
    toolName: 'write',
    input: { path: 'a.txt', content: '第一行\n第二行' },
    path: 'a.txt',
    ...overrides
  }
}

function decideWith(
  overrides: Partial<ApprovalRequest> = {},
  workspaces: Workspace[] = [WS]
): { onDecide: ReturnType<typeof vi.fn<(decision: ApprovalDecision) => void>> } {
  const onDecide = vi.fn<(decision: ApprovalDecision) => void>()
  render(<ApprovalCard request={request(overrides)} workspaces={workspaces} onDecide={onDecide} />)
  return { onDecide }
}

describe('ApprovalCard · 内容', () => {
  it('工具名、目标路径、等待审批签都在（与工具卡同一族形状）', () => {
    decideWith()

    const card = screen.getByTestId('approval-card')
    expect(card).toHaveAttribute('data-tool', 'write')
    expect(card).toHaveAttribute('data-workspace', WS.path)
    expect(card).toHaveTextContent('写入文件')
    expect(card).toHaveTextContent('等待审批')
    expect(screen.getByTestId('approval-target')).toHaveTextContent('a.txt')
  })

  it('write：内容按新增行预览（+ 行、DiffAdd 取色）', () => {
    decideWith()

    const lines = screen.getAllByTestId('approval-diff-line')
    expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual(['add', 'add'])
    expect(lines[0]).toHaveTextContent('+')
    expect(lines[0]).toHaveTextContent('第一行')
    expect(lines[0].className).toContain('text-diff-add')
  })

  it('edit：行级 diff 标出删除与新增两色', () => {
    decideWith({
      toolName: 'edit',
      input: { path: 'a.txt', oldText: '旧的一行', newText: '新的一行' }
    })

    const lines = screen.getAllByTestId('approval-diff-line')
    expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual(['remove', 'add'])
    expect(lines[0].className).toContain('text-diff-delete')
    expect(lines[1].className).toContain('text-diff-add')
  })

  it('认不出的工具：没有 diff 区，只给可见信息（不猜）', () => {
    decideWith({ toolName: 'mcp__x__do', input: { anything: 1 }, path: null })

    expect(screen.getByTestId('approval-card')).toHaveTextContent('mcp__x__do')
    expect(screen.queryByTestId('approval-diff')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-target')).not.toBeInTheDocument()
  })
})

describe('ApprovalCard · 四决策', () => {
  it('允许一次 / 本会话允许 / 永久允许 / 拒绝各自 dispatch 对应决策', () => {
    const { onDecide } = decideWith()

    fireEvent.click(screen.getByTestId('approval-allow-once'))
    expect(onDecide).toHaveBeenLastCalledWith('once')

    fireEvent.click(screen.getByTestId('approval-allow-session'))
    expect(onDecide).toHaveBeenLastCalledWith('session')

    fireEvent.click(screen.getByTestId('approval-allow-forever'))
    expect(onDecide).toHaveBeenLastCalledWith('forever')

    fireEvent.click(screen.getByTestId('approval-deny'))
    expect(onDecide).toHaveBeenLastCalledWith('deny')

    expect(onDecide).toHaveBeenCalledTimes(4)
  })

  it('判不出工作区（没有 path 的写类工具）：只给允许一次与拒绝，不给记忆入口', () => {
    decideWith({ toolName: 'mcp__x__do', input: { anything: 1 }, path: null })

    expect(screen.getByTestId('approval-allow-once')).toBeInTheDocument()
    expect(screen.getByTestId('approval-deny')).toBeInTheDocument()
    expect(screen.queryByTestId('approval-allow-session')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-allow-forever')).not.toBeInTheDocument()
  })

  it('路径判不出工作区（不在授权列表里）：同样不给记忆入口', () => {
    decideWith({
      input: { path: 'C:\\Windows\\evil.txt', content: 'x' },
      path: 'C:\\Windows\\evil.txt'
    })

    expect(screen.getByTestId('approval-card')).toHaveAttribute('data-workspace', '')
    expect(screen.queryByTestId('approval-allow-forever')).not.toBeInTheDocument()
  })

  it('MCP 工具：标题显示「服务名 · 工具名」（round 14，与 ToolCard 同一口径）', () => {
    useSettingsStore.setState({
      settings: { ...defaultSettings(), mcpServers: [mcpServer()] },
      loaded: true
    })
    try {
      render(
        <ApprovalCard
          request={request({ toolName: 'mcp__mcp-1__search', input: { query: 'x' } })}
          workspaces={[WS]}
          onDecide={vi.fn()}
        />
      )

      const card = screen.getByTestId('approval-card')
      expect(card).toHaveTextContent('知识库 · search')
      expect(card).not.toHaveTextContent('mcp__mcp-1__search')
      // 内部名仍留在 data 属性里（身份不丢，只是换个显示）
      expect(card).toHaveAttribute('data-tool', 'mcp__mcp-1__search')
    } finally {
      useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
    }
  })
})
