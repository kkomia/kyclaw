import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TasksGroup, type TasksGroupProps } from '../TasksGroup'
import type { SessionListEntry } from '../SessionList'

/**
 * 侧栏「任务」组（round 61）：没有项目的会话（含草稿）归到这一个可折叠的分区头下。
 * 纯展示 + 本地折叠状态（localStorage 轻量持久，与项目折叠同一份存储）：数据与选中回调都是 props。
 *
 * 契约（testid）：
 *   - 组根 `session-group-tasks`（空态整组不渲染）；
 *   - 组头 `tasks-item`（`navItemClass` 行 + chevron + aria-expanded，点整行开合，无行尾 ⋯/⊕）；
 *   - 折叠内容 `tasks-sessions`（`.trace-fold` + data-open；里面是 SessionList 平铺）。
 */
const TODAY = new Date().toISOString()

const SESSIONS: SessionListEntry[] = [
  { id: 't-a', title: '甲', updatedAt: TODAY },
  { id: 't-b', title: null, updatedAt: TODAY }
]

function renderGroup(overrides: Partial<TasksGroupProps> = {}): {
  props: TasksGroupProps
  unmount: () => void
} {
  const props: TasksGroupProps = {
    sessions: SESSIONS,
    activeId: null,
    onSelect: vi.fn(),
    ...overrides
  }
  const view = render(
    <MemoryRouter>
      <TasksGroup {...props} />
    </MemoryRouter>
  )
  return { props, unmount: view.unmount }
}

beforeEach(() => {
  // 折叠状态记在 localStorage：每个用例从"全展开"开始
  window.localStorage.clear()
})

describe('TasksGroup', () => {
  it('组头是「任务」+ 行首 chevron，没有行尾 ⋯/⊕；内容 = 会话平铺（顺序即传入顺序）', () => {
    renderGroup()

    const head = screen.getByTestId('tasks-item')
    expect(head).toHaveTextContent('任务')
    expect(head.querySelector('svg')).not.toBeNull()
    expect(head).toHaveClass('h-(--nav-item-height)', 'hover:bg-hover')
    // 组头里只有 chevron + 文字：没有行尾 ⋯ 菜单 / ⊕ 新建会话
    expect(head.querySelectorAll('button, [role="menuitem"]')).toHaveLength(0)
    expect(
      screen.getByTestId('session-list').querySelectorAll('[data-testid^="session-row-"]')
    ).toHaveLength(2)
    expect(
      screen.getAllByTestId(/^session-row-/).map((row) => row.getAttribute('data-testid'))
    ).toEqual(['session-row-t-a', 'session-row-t-b'])
  })

  it('组内平铺：不再有 今天 / 更早 / 置顶 分组头（round 61 去掉）', () => {
    renderGroup({ pinnedIds: new Set(['t-b']) })

    for (const stale of ['session-group-today', 'session-group-earlier', 'session-group-pinned']) {
      expect(screen.queryByTestId(stale)).not.toBeInTheDocument()
    }
    // 图钉标识还在（置顶的"排最前"由 composeSidebarSessions 给，不在列表里）
    expect(screen.getByTestId('session-pin-mark-t-b')).toBeInTheDocument()
  })

  it('默认展开，且展开时 chevron 转 90°', () => {
    renderGroup()

    const head = screen.getByTestId('tasks-item')
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('tasks-sessions')).toHaveAttribute('data-open', 'true')
    expect(head.querySelector('svg')?.getAttribute('class') ?? '').toContain('rotate-90')
  })

  it('点组头（整行）= 折叠/展开：aria-expanded + data-open 切换，收起不卸载', () => {
    renderGroup()

    const head = screen.getByTestId('tasks-item')
    const fold = screen.getByTestId('tasks-sessions')

    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(fold).toHaveAttribute('data-open', 'false')
    expect(head.querySelector('svg')?.getAttribute('class') ?? '').not.toContain('rotate-90')
    // 收起 ≠ 卸载：内容留在 DOM 里走 .trace-fold 的过渡
    expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()

    fireEvent.click(head)
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(fold).toHaveAttribute('data-open', 'true')
  })

  it('折叠状态持久化：重挂载后仍收起；localStorage 里记的是保留 id __tasks__', () => {
    const first = renderGroup()
    fireEvent.click(screen.getByTestId('tasks-item'))
    expect(window.localStorage.getItem('kyclaw.projects.collapsed')).toContain('__tasks__')

    first.unmount()
    renderGroup()
    expect(screen.getByTestId('tasks-sessions')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('tasks-item')).toHaveAttribute('aria-expanded', 'false')
  })

  it('与项目折叠共用一份存储：先读后写，任务组的写入不冲掉项目的收起项（反过来也是）', () => {
    window.localStorage.setItem('kyclaw.projects.collapsed', JSON.stringify(['p1']))
    renderGroup()

    fireEvent.click(screen.getByTestId('tasks-item'))

    expect(JSON.parse(window.localStorage.getItem('kyclaw.projects.collapsed') ?? '[]')).toEqual(
      expect.arrayContaining(['p1', '__tasks__'])
    )
  })

  it('空态：没有无项目会话时整组不渲染（组头也不留）', () => {
    renderGroup({ sessions: [] })

    expect(screen.queryByTestId('session-group-tasks')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tasks-item')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-list')).not.toBeInTheDocument()
  })

  it('点会话：回调带 id（选中/跳转由 SessionList 自己接）', () => {
    const { props } = renderGroup()
    fireEvent.click(screen.getByTestId('session-item-t-a'))
    expect(props.onSelect).toHaveBeenCalledWith('t-a')
  })
})
