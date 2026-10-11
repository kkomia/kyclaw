import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { SessionList, type SessionListEntry } from '../SessionList'

/**
 * 会话列表（T9 接真实数据后的展示层）：
 * 分组 今天/更早、选中 Fills-F2、hover Fills-F1（spec §6.2 / 附录 A）。
 *
 * round 24：行尾 ⋯ 的菜单、重命名/删除对话框与动作接线都搬进了 **SessionActionsMenu**
 * （对话页顶部栏共用；菜单/对话框/动作的用例见 session-actions-menu.spec）——
 * 本文件只测列表自己的形态：分组、选中、整行 hover、置顶标识/分组、草稿规则、完成点、截断。
 */
const TODAY = new Date().toISOString()
const EARLIER = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()

function entry(id: string, title: string | null, updatedAt = TODAY): SessionListEntry {
  return { id, title, updatedAt }
}

function LocationProbe(): React.JSX.Element {
  return <div data-testid="location">{useLocation().pathname}</div>
}

function renderList(
  sessions: SessionListEntry[],
  options: {
    activeId?: string | null
    notices?: Record<string, true>
    pinnedIds?: ReadonlySet<string>
  } = {},
  path = '/chat'
): { onSelect: ReturnType<typeof vi.fn> } {
  const onSelect = vi.fn()
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionList
        sessions={sessions}
        activeId={options.activeId ?? null}
        notices={options.notices}
        pinnedIds={options.pinnedIds}
        onSelect={onSelect}
      />
      <LocationProbe />
    </MemoryRouter>
  )
  return { onSelect }
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

  it('选中项 Fills-F2 + aria-current；未选中项只有 hover 档（round 20：底挂整行）', () => {
    renderList([entry('t1', '甲'), entry('t2', '乙')], { activeId: 't1' })

    const firstRow = screen.getByTestId('session-row-t1')
    const secondRow = screen.getByTestId('session-row-t2')
    const first = screen.getByTestId('session-item-t1')
    const second = screen.getByTestId('session-item-t2')
    expect(firstRow).toHaveClass('bg-selected', 'h-(--nav-item-height)')
    expect(first).toHaveAttribute('aria-current', 'true')
    expect(secondRow).not.toHaveClass('bg-selected')
    expect(second).not.toHaveAttribute('aria-current')
    expect(secondRow).toHaveClass('hover:bg-hover')
    // round 20（用户实拍"hover 圆角阴影要把三点包括在内"）：⋯ 在**行容器**里——
    // hover 底罩住标题 + ⋯ 同一圆角；标题按钮自己不再画底（避免两截底色）
    expect(firstRow).toContainElement(screen.getByTestId('session-more-t1'))
    expect(first).not.toHaveClass('hover:bg-hover')
  })

  it('点会话：回调带 id，并切回对话页', () => {
    const { onSelect } = renderList(
      [entry('t1', '甲'), entry('t2', '乙')],
      { activeId: 't1' },
      '/settings'
    )

    fireEvent.click(screen.getByTestId('session-item-t2'))

    expect(onSelect).toHaveBeenCalledWith('t2')
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

  it('草稿行也有行尾菜单（round 26：不再"灰着不让用"；置顶/归档/移至项目先物化）', () => {
    renderList([{ id: 'draft-1', title: null, updatedAt: TODAY, draft: true }, entry('t1', '甲')])

    expect(screen.getByTestId('session-more-draft-1')).toBeInTheDocument()
    expect(screen.getByTestId('session-more-t1')).toBeInTheDocument()
  })

  it('草稿行显示传入的本地标题（就地重命名的结果显示）', () => {
    renderList([
      { id: 'draft-1', title: '草稿改过的名', updatedAt: TODAY, draft: true },
      entry('t1', '甲')
    ])

    expect(screen.getByTestId('session-item-draft-1')).toHaveTextContent('草稿改过的名')
  })

  it('后台完成的会话带一个完成点（notices）', () => {
    renderList([entry('t1', '甲'), entry('t2', '乙')], { notices: { t2: true } })

    expect(screen.queryByTestId('session-done-t1')).not.toBeInTheDocument()
    expect(screen.getByTestId('session-done-t2')).toBeInTheDocument()
  })

  it('round 20：置顶的行带图钉标识、单独提到时间分组之上（无分组标题）', () => {
    renderList([entry('t1', '甲'), entry('t2', '乙', EARLIER)], { pinnedIds: new Set(['t2']) })

    expect(screen.getByTestId('session-pin-mark-t2')).toBeInTheDocument()
    const pinnedGroup = screen.getByTestId('session-group-pinned')
    expect(pinnedGroup).toContainElement(screen.getByTestId('session-row-t2'))
    expect(screen.getByTestId('session-group-today')).toContainElement(
      screen.getByTestId('session-row-t1')
    )
  })
})
