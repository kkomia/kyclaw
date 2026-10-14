import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskHistory } from '../TaskHistory'
const fetchHistory = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/tasks-api', () => ({ fetchTaskHistory: fetchHistory }))
describe('Real task version history', () => {
  it('压缩后 API 历史显示，已存在 tool 行版本不重复计数', async () => {
    const snapshot = { revision: 1, updatedAt: null, items: [] }
    fetchHistory.mockResolvedValue({
      revisions: [
        { revision: 1, origin: 'tool', snapshot, createdAt: '2026-10-14T00:00:00Z' },
        {
          revision: 2,
          origin: 'user',
          snapshot: { ...snapshot, revision: 2 },
          createdAt: '2026-10-14T00:01:00Z'
        }
      ]
    })
    render(
      <TaskHistory threadId="thread" active revision="a" representedRevisions={new Set([2])} />
    )
    expect(await screen.findByText('任务历史（1 个未在工具行展示的版本）')).toBeInTheDocument()
    expect(screen.getByText(/历史版本 1/)).toBeInTheDocument()
    expect(screen.queryByText(/历史版本 2/)).not.toBeInTheDocument()
  })
  it('切换 thread 后相同 revision 不沿用旧去重集合或旧历史', async () => {
    const snapshot = { revision: 1, updatedAt: null, items: [] }
    fetchHistory.mockResolvedValue({
      revisions: [{ revision: 1, origin: 'user', snapshot, createdAt: '2026-10-14T00:00:00Z' }]
    })
    const { rerender } = render(
      <TaskHistory threadId="first" active revision="a" representedRevisions={new Set([1])} />
    )
    await vi.waitFor(() => expect(fetchHistory).toHaveBeenCalledWith('first'))
    rerender(<TaskHistory threadId="second" active revision="a" representedRevisions={new Set()} />)
    expect(await screen.findByText(/历史版本 1/)).toBeInTheDocument()
    expect(fetchHistory).toHaveBeenCalledWith('second')
  })
  it('失败可见可重试，不造历史', async () => {
    fetchHistory.mockRejectedValueOnce(new Error('失败')).mockResolvedValue({ revisions: [] })
    render(<TaskHistory threadId="thread" active revision="a" representedRevisions={new Set()} />)
    const retry = await screen.findByRole('button', { name: '重试任务历史' })
    expect(screen.queryByText(/历史版本/)).not.toBeInTheDocument()
    fireEvent.click(retry)
    await vi.waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})
