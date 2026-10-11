import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type Workspace } from '@shared/settings'
import { ApprovalDock } from '../ApprovalDock'
import type { ApprovalRequest } from '../approval'

/**
 * 审批条（round 29，RTL）：待审批统一停在**输入框上方**的停靠区里 ——
 *   - 容器常驻（`approval-dock`），空的时候 data-open=false（0 高度，不占版面）；
 *   - 同一步多个挂起 → 多条堆叠，逐个决策；
 *   - 决策后条目先留在 DOM 里跑完退场过渡（data-leaving + 收高度/淡出），超时才真移除：
 *     用户口径点名的"处理完消失要有过渡动效、禁止闪现"；
 *   - 决策只从这一条出口发出（onDecide），不自造第二套判定。
 */
const WS: Workspace = { path: 'D:\\项目\\demo', mode: 'ask' }
const EXIT_MS = 300

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: 'run-1::call-1',
    toolCallId: 'call-1',
    toolName: 'write',
    input: { path: 'a.txt', content: '第一行' },
    path: 'a.txt',
    ...overrides
  }
}

beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('审批条 · 停靠契约', () => {
  it('没有待审批：容器在 DOM 里但收着（data-open=false，0 高度不占版面）', () => {
    render(<ApprovalDock requests={[]} workspaces={[WS]} onDecide={vi.fn()} />)

    expect(screen.getByTestId('approval-dock')).toHaveAttribute('data-open', 'false')
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('approval-dock-item')).not.toBeInTheDocument()
  })

  it('有待审批：容器撑开、条目带参数（工具名 / 路径 / diff）与四个决策入口', () => {
    render(<ApprovalDock requests={[request()]} workspaces={[WS]} onDecide={vi.fn()} />)

    expect(screen.getByTestId('approval-dock')).toHaveAttribute('data-open', 'true')
    const card = screen.getByTestId('approval-card')
    expect(card).toHaveAttribute('data-tool', 'write')
    expect(card).toHaveAttribute('data-workspace', WS.path)
    expect(screen.getByTestId('approval-target')).toHaveTextContent('a.txt')
    expect(screen.getAllByTestId('approval-diff-line')).toHaveLength(1)
    expect(screen.getByTestId('approval-allow-once')).toBeInTheDocument()
    expect(screen.getByTestId('approval-allow-session')).toBeInTheDocument()
    expect(screen.getByTestId('approval-allow-forever')).toBeInTheDocument()
    expect(screen.getByTestId('approval-deny')).toBeInTheDocument()
  })

  it('同一步多个挂起：多条堆叠，各自带自己的工具与参数', () => {
    render(
      <ApprovalDock
        requests={[
          request(),
          request({
            approvalId: 'run-1::call-2',
            toolCallId: 'call-2',
            toolName: 'bash',
            input: { command: 'pnpm test', cwd: 'D:\\项目\\demo' },
            path: 'D:\\项目\\demo'
          })
        ]}
        workspaces={[WS]}
        onDecide={vi.fn()}
      />
    )

    expect(screen.getAllByTestId('approval-card')).toHaveLength(2)
    expect(screen.getByTestId('approval-detail')).toHaveTextContent('pnpm test')
  })
})

describe('审批条 · 决策与退场过渡', () => {
  it('决策从 onDecide 出去（带这一条自己的 request）；条目先留住跑动画，超时才移除、容器收回', () => {
    const onDecide = vi.fn()
    const first = request()
    const { rerender } = render(
      <ApprovalDock requests={[first]} workspaces={[WS]} onDecide={onDecide} />
    )

    fireEvent.click(screen.getByTestId('approval-allow-once'))
    expect(onDecide).toHaveBeenCalledWith(first, 'once')

    // 上层（ChatPage 的消息态）此刻已经收回这一条：条目仍在 DOM 里跑退场过渡 —— 不闪现、不硬切
    rerender(<ApprovalDock requests={[]} workspaces={[WS]} onDecide={onDecide} />)
    expect(screen.getByTestId('approval-card')).toBeInTheDocument()
    expect(screen.getByTestId('approval-dock-item')).toHaveAttribute('data-leaving', 'true')
    expect(screen.getByTestId('approval-dock')).toHaveAttribute('data-open', 'true')

    act(() => {
      vi.advanceTimersByTime(EXIT_MS)
    })
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('approval-dock')).toHaveAttribute('data-open', 'false')
  })

  it('拒绝也走同一条路（approved:false 由上层判定，这里只把决策原样发出）', () => {
    const onDecide = vi.fn()
    render(<ApprovalDock requests={[request()]} workspaces={[WS]} onDecide={onDecide} />)

    fireEvent.click(screen.getByTestId('approval-deny'))
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'run-1::call-1' }),
      'deny'
    )
  })

  it('多条堆叠时只退掉被决策的那一条，其余接着等', () => {
    const onDecide = vi.fn()
    const first = request()
    const second = request({
      approvalId: 'run-1::call-2',
      toolCallId: 'call-2',
      toolName: 'bash',
      input: { command: 'ls' },
      path: null
    })
    const { rerender } = render(
      <ApprovalDock requests={[first, second]} workspaces={[WS]} onDecide={onDecide} />
    )

    fireEvent.click(screen.getAllByTestId('approval-deny')[0])
    // 上层收回第一条（模拟 addToolApprovalResponse 把 part 翻成 approval-responded）
    rerender(<ApprovalDock requests={[second]} workspaces={[WS]} onDecide={onDecide} />)

    // 退场中的那条还在（data-leaving），没被决策的那条原样等着
    const items = screen.getAllByTestId('approval-dock-item')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveAttribute('data-leaving', 'true')
    expect(items[1]).not.toHaveAttribute('data-leaving')

    act(() => {
      vi.advanceTimersByTime(EXIT_MS)
    })
    expect(screen.getAllByTestId('approval-card')).toHaveLength(1)
    expect(screen.getByTestId('approval-card')).toHaveAttribute('data-tool', 'bash')
    expect(screen.getByTestId('approval-dock')).toHaveAttribute('data-open', 'true')
  })
})
