import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'
import { SessionList } from '../SessionList'

/**
 * 会话列表（本任务为 mock 数据；T9 换真实数据与会话控制）。
 * 外观口径同导航项：高 36、选中 Fills-F2、hover Fills-F1（spec §6.2 / 附录 A）。
 */
function LocationProbe(): React.JSX.Element {
  return <div data-testid="location">{useLocation().pathname}</div>
}

function renderList(path = '/chat'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionList />
      <LocationProbe />
    </MemoryRouter>
  )
}

describe('会话列表（mock）', () => {
  it('渲染 mock 会话，第一项默认选中（Fills-F2 + aria-current）', () => {
    renderList()

    const items = screen.getAllByTestId(/^session-item-/)
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('电源管理方案调研')
    expect(items[0]).toHaveClass('bg-selected', 'h-(--nav-item-height)')
    expect(items[0]).toHaveAttribute('aria-current', 'true')

    expect(items[1]).not.toHaveClass('bg-selected')
    expect(items[1]).not.toHaveAttribute('aria-current')
    expect(items[1]).toHaveClass('hover:bg-hover')
  })

  it('点会话：选中跟着走，并切回对话页', () => {
    renderList('/settings')

    const second = screen.getAllByTestId(/^session-item-/)[1]
    fireEvent.click(second)

    expect(second).toHaveClass('bg-selected')
    expect(second).toHaveAttribute('aria-current', 'true')
    expect(screen.getAllByTestId(/^session-item-/)[0]).not.toHaveClass('bg-selected')
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })

  it('会话标题过长不撑破侧栏（文字层截断）', () => {
    renderList()

    expect(screen.getAllByTestId(/^session-item-/)[0].querySelector('span')).toHaveClass(
      'truncate',
      'min-w-0'
    )
  })
})
