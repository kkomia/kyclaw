import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { createTasksStore } from '@renderer/lib/tasks-store'
import { TaskDockSlot } from '../TaskDockSlot'
import { TaskSnapshotSummary } from '@renderer/features/trajectory/TaskSnapshotSummary'
import { buildTrajectory } from '@renderer/features/trajectory/model'
import type { StoredMessage } from '@shared/threads'
import type { TaskSnapshot } from '@shared/tasks'

function snapshot(revision = 1, done = false): TaskSnapshot {
  return {
    revision,
    updatedAt: '2026-10-14T00:00:00Z',
    items: [
      {
        id: 'task',
        title: '生成报告',
        status: done ? 'done' : 'pending',
        createdAt: '2026-10-14T00:00:00Z',
        updatedAt: '2026-10-14T00:00:00Z'
      }
    ]
  }
}
describe('Task renderer integration', () => {
  it('未物化草稿不铺常驻件也不请求；从 ＋菜单那条翻开才给一句实话', async () => {
    const get = vi.fn().mockRejectedValue(new Error('404'))
    const store = createTasksStore({ get, put: vi.fn() })
    const { rerender } = render(
      <TaskDockSlot threadId="draft" materialized={false} store={store} />
    )
    // 没有任务且收起（默认）= 整块不渲染：入口在输入卡的 ＋ 菜单里，不在这里铺常驻按钮
    expect(screen.queryByTestId('task-dock-slot')).not.toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
    act(() => store.getState().setCollapsed('draft', false))
    expect(screen.getByTestId('task-dock-slot')).toBeInTheDocument()
    expect(screen.getByText('发送消息或进入规划后可使用会话任务清单')).toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
    rerender(<TaskDockSlot threadId="draft" materialized store={store} />)
    expect(await screen.findByText('任务加载失败，请重试')).toBeInTheDocument()
    get.mockResolvedValue({ revision: 0, updatedAt: null, items: [] })
    fireEvent.click(screen.getByRole('button', { name: '刷新任务' }))
    expect(await screen.findByText('暂无任务')).toBeInTheDocument()
  })

  it('未就绪无入口；空任务默认收起不留常驻件，翻开出现空态、收起又整块消失', async () => {
    const get = vi.fn().mockResolvedValue({ revision: 0, updatedAt: null, items: [] })
    const store = createTasksStore({ get, put: vi.fn() })
    const { rerender } = render(<TaskDockSlot threadId={null} store={store} />)
    expect(screen.queryByTestId('task-dock-slot')).not.toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
    rerender(<TaskDockSlot threadId="real-thread" store={store} />)
    await waitFor(() => expect(get).toHaveBeenCalledWith('real-thread'))
    expect(screen.queryByTestId('task-list-dock')).not.toBeInTheDocument()
    act(() => store.getState().setCollapsed('real-thread', false))
    expect(await screen.findByText('暂无任务')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('task-dock-toggle'))
    expect(screen.queryByTestId('task-list-dock')).not.toBeInTheDocument()
  })
  it('非空任务默认只铺紧凑摘要（完成数/总数与当前进行项），面板自身限高且只加载指定 thread', async () => {
    const get = vi.fn().mockResolvedValue(snapshot())
    const store = createTasksStore({ get, put: vi.fn() })
    render(<TaskDockSlot threadId="thread" store={store} />)
    const card = await screen.findByTestId('task-list-dock')
    expect(card).toHaveAttribute('data-collapsed', 'true')
    expect(card).toHaveTextContent('0/1 已完成')
    expect(screen.queryByRole('list', { name: '任务列表' })).not.toBeInTheDocument()
    expect(card.className).toContain('max-h-[min(32vh,20rem)]')
    expect(get.mock.calls.every(([thread]) => thread === 'thread')).toBe(true)
  })
  it('轨迹当前快照和旧 todo 历史独立，旧进度不被新快照覆盖', async () => {
    const store = createTasksStore({ get: async () => snapshot(2, true), put: vi.fn() })
    await store.getState().load('thread')
    render(<TaskSnapshotSummary threadId="thread" store={store} />)
    expect(screen.getByTestId('trajectory-current-tasks')).toHaveTextContent(
      '当前任务快照 · 版本 2 · 任务 1/1'
    )
    const messages = [
      {
        id: 'old',
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                toolCallId: 'todo-old',
                toolName: 'todo',
                state: 'result',
                args: { action: 'replace' },
                result: { status: 'ok', snapshot: snapshot(1) }
              }
            }
          ]
        }
      }
    ] as StoredMessage[]
    const row = buildTrajectory({ messages }).rows.find((item) => item.toolName === 'todo')!
    expect(row.text).toContain('历史版本 1 · 任务 0/1')
    expect(row.outputRaw).toContain('"revision": 1')
    expect(row.text).not.toContain('任务 1/1')
    expect(row.taskRevision).toBe(1)
    const conflicting = JSON.parse(JSON.stringify(messages)) as StoredMessage[]
    const content = conflicting[0].content as {
      parts: Array<{ toolInvocation: { result: { status: string } } }>
    }
    content.parts[0].toolInvocation.result.status = 'conflict'
    const conflictRow = buildTrajectory({ messages: conflicting }).rows.find(
      (item) => item.toolName === 'todo'
    )!
    expect(conflictRow.taskRevision).toBeUndefined()
  })
})
