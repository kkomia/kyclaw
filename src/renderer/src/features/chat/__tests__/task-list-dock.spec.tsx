import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TaskSnapshot } from '@shared/tasks'
import { tick } from '@renderer/components/ui/__tests__/tick'
import {
  createTasksStore,
  EMPTY_TASK_SESSION,
  type TaskSessionState
} from '@renderer/lib/tasks-store'
import { TaskListDock, TaskListPanel, type TaskListPanelProps } from '../TaskListDock'

const time = '2026-10-14T00:00:00.000Z'
const snapshot: TaskSnapshot = {
  revision: 1,
  updatedAt: time,
  items: [
    {
      id: 'a',
      title: '<img src=x onerror=alert(1)>',
      status: 'done',
      createdAt: time,
      updatedAt: time
    },
    {
      id: 'b',
      title: '长任务'.repeat(40),
      status: 'in_progress',
      createdAt: time,
      updatedAt: time
    },
    {
      id: 'c',
      title: '等反馈',
      status: 'blocked',
      note: '等待用户反馈',
      createdAt: time,
      updatedAt: time
    }
  ]
}
function props(state: Partial<TaskSessionState> = {}): TaskListPanelProps {
  return {
    // 详情展开的档（收起那一档见下面专门的两条用例）：断言列表内容时用它
    state: { ...EMPTY_TASK_SESSION, snapshot, collapsed: false, ...state },
    onRefresh: vi.fn(),
    onCollapsedChange: vi.fn(),
    onStatusChange: vi.fn(),
    onClear: vi.fn()
  }
}

describe('任务 Dock', () => {
  it('显示真实完成数、进行中和阻塞，纯文本标题且约束长文滚动', () => {
    const { container } = render(<TaskListPanel {...props()} />)
    expect(screen.getByText('1/3 已完成')).toBeInTheDocument()
    expect(screen.getByText('1 项进行中')).toBeInTheDocument()
    expect(screen.getByText('1 项阻塞')).toBeInTheDocument()
    expect(screen.queryByText('全部完成')).not.toBeInTheDocument()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('list', { name: '任务列表' }).className).toContain('overflow-y-auto')
    expect(screen.getByTestId('task-list-dock').className).toContain('border-surface-border')
    expect(screen.getByText('长任务'.repeat(40)).className).toContain('[overflow-wrap:anywhere]')
  })
  it('默认收起：摘要里给完成数/总数与当前进行项，点摘要展开、再点收起', () => {
    const panel = props({ collapsed: true })
    const { rerender } = render(<TaskListPanel {...panel} />)
    const dock = screen.getByTestId('task-list-dock')
    expect(dock).toHaveAttribute('data-collapsed', 'true')
    expect(dock).toHaveTextContent('1/3 已完成')
    // 当前进行项直接印在摘要上（不用展开就能看出在做哪一件）
    expect(screen.getByTestId('task-dock-toggle')).toHaveTextContent('当前：长任务')
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-dock-toggle'))
    expect(panel.onCollapsedChange).toHaveBeenCalledWith(false)
    rerender(<TaskListPanel {...props()} />)
    expect(screen.getByTestId('task-list-dock')).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByTestId('task-dock-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('list', { name: '任务列表' })).toBeInTheDocument()
  })
  it('收起仍保留摘要和冲突错误，空态不标全部完成', () => {
    const panel = props({ collapsed: true, conflict: '冲突，未保存', error: '加载失败' })
    render(<TaskListPanel {...panel} />)
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.getAllByRole('alert')).toHaveLength(2)
    expect(screen.getByTestId('task-dock-toggle')).toHaveTextContent('1/3 已完成')
  })
  it('空清单展开时说明「暂无任务」，且不标全部完成', () => {
    render(
      <TaskListPanel
        {...props({ snapshot: { revision: 2, items: [], updatedAt: time }, collapsed: false })}
      />
    )
    expect(screen.getByText('暂无任务')).toBeInTheDocument()
    expect(screen.queryByText('全部完成')).not.toBeInTheDocument()
  })
  it('用户修改单项状态：菜单直接改，其它进行中不可选', async () => {
    const panel = props()
    render(<TaskListPanel {...panel} />)
    fireEvent.keyDown(
      screen.getByRole('button', { name: '任务状态：<img src=x onerror=alert(1)>' }),
      { key: 'ArrowDown' }
    )
    expect(screen.getByRole('menuitem', { name: '进行中' })).toHaveAttribute('data-disabled')
    fireEvent.click(screen.getByRole('menuitem', { name: '待办' }))
    await tick()
    expect(panel.onStatusChange).toHaveBeenCalledWith('a', 'pending')
  })
  it('选「已阻塞」弹出原因表单，原因必填', async () => {
    const panel = props()
    render(<TaskListPanel {...panel} />)
    fireEvent.keyDown(
      screen.getByRole('button', { name: '任务状态：<img src=x onerror=alert(1)>' }),
      { key: 'ArrowDown' }
    )
    fireEvent.click(screen.getByRole('menuitem', { name: '已阻塞' }))
    await tick()
    fireEvent.click(screen.getByRole('button', { name: '保存阻塞原因' }))
    expect(screen.getByRole('alert')).toHaveTextContent('请填写阻塞原因')
    expect(panel.onStatusChange).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '等待权限' } })
    fireEvent.click(screen.getByRole('button', { name: '保存阻塞原因' }))
    expect(panel.onStatusChange).toHaveBeenCalledWith('a', 'blocked', '等待权限')
  })
  it('菜单开着时进入 busy：条目禁用、点击不提交', async () => {
    const panel = props()
    const { rerender } = render(<TaskListPanel {...panel} />)
    fireEvent.keyDown(
      screen.getByRole('button', { name: '任务状态：<img src=x onerror=alert(1)>' }),
      { key: 'ArrowDown' }
    )
    expect(screen.getByRole('menuitem', { name: '待办' })).not.toHaveAttribute('data-disabled')

    rerender(<TaskListPanel {...panel} state={{ ...panel.state, saving: true }} />)
    const pending = screen.getByRole('menuitem', { name: '待办' })
    expect(pending).toHaveAttribute('data-disabled')
    fireEvent.click(pending)
    await tick()
    expect(panel.onStatusChange).not.toHaveBeenCalled()
  })
  it('清空要求明确确认，没有全部完成操作', () => {
    const panel = props()
    render(<TaskListPanel {...panel} />)
    fireEvent.click(screen.getByRole('button', { name: '清空任务清单' }))
    expect(panel.onClear).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消清空' }))
    expect(panel.onClear).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '清空任务清单' }))
    fireEvent.click(screen.getByRole('button', { name: '确认清空任务' }))
    expect(panel.onClear).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '全部完成' })).not.toBeInTheDocument()
  })
  it('加载和保存显示状态并禁用写入', () => {
    const { rerender } = render(<TaskListPanel {...props({ loading: true })} />)
    expect(screen.getByRole('status')).toHaveTextContent('正在加载')
    expect(screen.getByRole('button', { name: '清空任务清单' })).toBeDisabled()
    rerender(<TaskListPanel {...props({ saving: true })} />)
    expect(screen.getByRole('status')).toHaveTextContent('正在保存')
    expect(screen.getByRole('button', { name: '刷新任务' })).toBeDisabled()
  })
  it('会话切换显示当前会话，旧请求迟到不能覆盖，草稿和清空确认不串会话', async () => {
    let resolveA!: (value: TaskSnapshot) => void
    const pending = new Promise<TaskSnapshot>((resolve) => {
      resolveA = resolve
    })
    const get = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce({ ...snapshot, items: [{ ...snapshot.items[0], title: '会话 B' }] })
    const store = createTasksStore({ get, put: vi.fn() })
    const { rerender } = render(<TaskListDock threadId="a" store={store} />)
    // 详情默认收起：本用例看的是列表内容，先把 a 的摘要点开
    act(() => store.getState().setCollapsed('a', false))
    rerender(<TaskListDock threadId="b" store={store} />)
    act(() => store.getState().setCollapsed('b', false))
    await waitFor(() => expect(screen.getByText('会话 B')).toBeInTheDocument())
    await act(async () => {
      resolveA(snapshot)
      await pending
    })
    expect(screen.queryByText('等反馈')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清空任务清单' }))
    rerender(<TaskListDock threadId="a" store={store} />)
    expect(screen.queryByRole('button', { name: '确认清空任务' })).not.toBeInTheDocument()
    rerender(<TaskListDock threadId={null} store={store} />)
    expect(screen.queryByTestId('task-list-dock')).not.toBeInTheDocument()
  })
})
