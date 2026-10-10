import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { SessionList, type SessionListEntry } from '../SessionList'

/**
 * 会话列表（T9 接真实数据后的纯展示层）：
 * 分组 今天/更早、选中 Fills-F2、hover Fills-F1（spec §6.2 / 附录 A）；
 * 重命名 / 删除都是受控 Dialog（R12），删除必须二次确认才有回调。
 * 数据与动作全由 props 给，这里不碰 store / 网络。
 */
const TODAY = new Date().toISOString()
const EARLIER = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()

function entry(id: string, title: string | null, updatedAt = TODAY): SessionListEntry {
  return { id, title, updatedAt }
}

function LocationProbe(): React.JSX.Element {
  return <div data-testid="location">{useLocation().pathname}</div>
}

interface Handlers {
  onSelect: ReturnType<typeof vi.fn>
  onRename: ReturnType<typeof vi.fn>
  onDelete: ReturnType<typeof vi.fn>
}

function renderList(
  sessions: SessionListEntry[],
  options: { activeId?: string | null; notices?: Record<string, true> } = {},
  path = '/chat'
): Handlers {
  const onSelect = vi.fn()
  const onRename = vi.fn()
  const onDelete = vi.fn()
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionList
        sessions={sessions}
        activeId={options.activeId ?? null}
        notices={options.notices}
        onSelect={onSelect}
        onRename={onRename}
        onDelete={onDelete}
      />
      <LocationProbe />
    </MemoryRouter>
  )
  return { onSelect, onRename, onDelete }
}

/** Radix 菜单：键盘打开（ArrowDown）后在条目上回车选中 */
function pick(triggerTestId: string, itemTestId: string): void {
  fireEvent.keyDown(screen.getByTestId(triggerTestId), { key: 'ArrowDown' })
  const item = screen.getByTestId(itemTestId)
  fireEvent.keyDown(item, { key: 'Enter' })
}

describe('会话列表：分组与选中', () => {
  it('按更新时间分组（今天/更早），缺标题显示"新会话"', () => {
    renderList([entry('t1', '今天的会话', TODAY), entry('t2', null, EARLIER)])

    expect(screen.getByTestId('session-group-today')).toHaveTextContent('今天')
    expect(screen.getByTestId('session-group-earlier')).toHaveTextContent('更早')
    expect(screen.getByTestId('session-item-t1')).toHaveTextContent('今天的会话')
    expect(screen.getByTestId('session-item-t2')).toHaveTextContent('新会话')
  })

  it('没有"更早"的会话时不渲染那一组', () => {
    renderList([entry('t1', '今天的会话', TODAY)])

    expect(screen.getByTestId('session-group-today')).toBeInTheDocument()
    expect(screen.queryByTestId('session-group-earlier')).not.toBeInTheDocument()
  })

  it('选中项 Fills-F2 + aria-current；未选中项只有 hover 档', () => {
    renderList([entry('t1', '甲'), entry('t2', '乙')], { activeId: 't1' })

    const first = screen.getByTestId('session-item-t1')
    const second = screen.getByTestId('session-item-t2')
    expect(first).toHaveClass('bg-selected', 'h-(--nav-item-height)')
    expect(first).toHaveAttribute('aria-current', 'true')
    expect(second).not.toHaveClass('bg-selected')
    expect(second).not.toHaveAttribute('aria-current')
    expect(second).toHaveClass('hover:bg-hover')
  })

  it('点会话：回调带 id，并切回对话页', () => {
    const handlers = renderList(
      [entry('t1', '甲'), entry('t2', '乙')],
      { activeId: 't1' },
      '/settings'
    )

    fireEvent.click(screen.getByTestId('session-item-t2'))

    expect(handlers.onSelect).toHaveBeenCalledWith('t2')
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })

  it('标题过长不撑破侧栏（文字层截断）', () => {
    renderList([entry('t1', '很长很长很长很长很长很长很长很长很长很长的标题')])

    expect(screen.getByTestId('session-item-t1').querySelector('span')).toHaveClass(
      'truncate',
      'min-w-0'
    )
  })

  it('空列表给一句引导（不空白）', () => {
    renderList([])

    expect(screen.getByTestId('session-list-empty')).toBeInTheDocument()
  })

  it('草稿行不给重命名/删除（服务端还没有它）', () => {
    renderList([{ id: 'draft-1', title: null, updatedAt: TODAY, draft: true }, entry('t1', '甲')])

    expect(screen.queryByTestId('session-more-draft-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('session-more-t1')).toBeInTheDocument()
  })

  it('后台完成的会话带一个完成点（notices）', () => {
    renderList([entry('t1', '甲'), entry('t2', '乙')], { notices: { t2: true } })

    expect(screen.queryByTestId('session-done-t1')).not.toBeInTheDocument()
    expect(screen.getByTestId('session-done-t2')).toBeInTheDocument()
  })
})

describe('重命名（受控 Dialog，R12）', () => {
  it('菜单 → 重命名 → 输入 → 保存：回调带 (id, 新标题)', async () => {
    const handlers = renderList([entry('t1', '旧标题')])

    pick('session-more-t1', 'session-rename-t1')
    await waitFor(() => {
      expect(screen.getByTestId('session-rename-input')).toHaveValue('旧标题')
    })

    fireEvent.change(screen.getByTestId('session-rename-input'), {
      target: { value: '  新标题  ' }
    })
    fireEvent.click(screen.getByTestId('session-rename-save'))

    expect(handlers.onRename).toHaveBeenCalledWith('t1', '新标题')
    await waitFor(() => {
      expect(screen.queryByTestId('session-rename-input')).not.toBeInTheDocument()
    })
  })

  it('取消：不回调、对话框关掉', async () => {
    const handlers = renderList([entry('t1', '旧标题')])

    pick('session-more-t1', 'session-rename-t1')
    await waitFor(() => {
      expect(screen.getByTestId('session-rename-input')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('session-rename-cancel'))

    expect(handlers.onRename).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByTestId('session-rename-input')).not.toBeInTheDocument()
    })
  })

  it('空标题不给保存（按钮禁用）', async () => {
    renderList([entry('t1', '旧标题')])

    pick('session-more-t1', 'session-rename-t1')
    await waitFor(() => {
      expect(screen.getByTestId('session-rename-input')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByTestId('session-rename-input'), { target: { value: '   ' } })

    expect(screen.getByTestId('session-rename-save')).toBeDisabled()
  })
})

describe('删除（受控 Dialog 二次确认，R12）', () => {
  it('菜单 → 删除 → 确认：回调带 id', async () => {
    const handlers = renderList([entry('t1', '甲')])

    pick('session-more-t1', 'session-delete-t1')
    await waitFor(() => {
      expect(screen.getByTestId('session-delete-confirm')).toBeInTheDocument()
    })
    expect(screen.getByRole('dialog')).toHaveTextContent('甲')

    fireEvent.click(screen.getByTestId('session-delete-confirm'))

    expect(handlers.onDelete).toHaveBeenCalledWith('t1')
    await waitFor(() => {
      expect(screen.queryByTestId('session-delete-confirm')).not.toBeInTheDocument()
    })
  })

  it('取消：不删（二次确认的意义所在）', async () => {
    const handlers = renderList([entry('t1', '甲')])

    pick('session-more-t1', 'session-delete-t1')
    await waitFor(() => {
      expect(screen.getByTestId('session-delete-cancel')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('session-delete-cancel'))

    expect(handlers.onDelete).not.toHaveBeenCalled()
  })
})
