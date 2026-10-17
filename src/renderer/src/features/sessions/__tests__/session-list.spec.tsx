import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'
import { useSessionsStore } from '../sessions-store'
import { SessionList, type SessionListEntry } from '../SessionList'

/**
 * 会话列表（T9 接真实数据后的展示层）：
 * **平铺**（round 61 去掉"今天 / 更早"与置顶分组——分组头由外层给，见 TasksGroup / ProjectList）、
 * 选中 Fills-F2、hover Fills-F1（spec §6.2 / 附录 A）。
 *
 * round 24：行尾 ⋯ 的菜单、重命名/删除对话框与动作接线都搬进了 **SessionActionsMenu**
 * （对话页顶部栏共用；菜单/对话框/动作的用例见 session-actions-menu.spec）——
 * 本文件只测列表自己的形态：平铺顺序、选中、整行 hover、置顶标识、草稿规则、完成点、截断。
 */
const TODAY = new Date().toISOString()

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
    runningIds?: ReadonlySet<string>
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
        runningIds={options.runningIds}
        onSelect={onSelect}
      />
      <LocationProbe />
    </MemoryRouter>
  )
  return { onSelect }
}

describe('会话列表：平铺与选中', () => {
  it('平铺：一条一行、顺序即传入顺序，缺标题显示"新会话"', () => {
    renderList([entry('t1', '今天的会话'), entry('t2', null)])

    const list = screen.getByTestId('session-list')
    expect(list).toContainElement(screen.getByTestId('session-row-t1'))
    expect(list).toContainElement(screen.getByTestId('session-row-t2'))
    expect(
      screen.getAllByTestId(/^session-row-/).map((row) => row.getAttribute('data-testid'))
    ).toEqual(['session-row-t1', 'session-row-t2'])
    expect(screen.getByTestId('session-item-t1')).toHaveTextContent('今天的会话')
    expect(screen.getByTestId('session-item-t2')).toHaveTextContent('新会话')
  })

  it('round 61：不再自带分组头（今天/更早/置顶分组都不渲染——分组头由外层给）', () => {
    renderList([entry('t1', '甲'), entry('t2', '乙')], { pinnedIds: new Set(['t2']) })

    for (const stale of ['session-group-today', 'session-group-earlier', 'session-group-pinned']) {
      expect(screen.queryByTestId(stale)).not.toBeInTheDocument()
    }
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

    expect(screen.getByTestId('session-title-t1')).toHaveClass('truncate', 'min-w-0')
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

  it('010：在跑的会话在完成槽位画灰色圆环（Spinner），优先于完成点；跑完完成点按未读语义回来', () => {
    const tree = (runningIds: ReadonlySet<string>): React.JSX.Element => (
      <MemoryRouter initialEntries={['/chat']}>
        <SessionList
          sessions={[entry('t1', '甲'), entry('t2', '乙')]}
          activeId={null}
          notices={{ t2: true }}
          runningIds={runningIds}
          onSelect={vi.fn()}
        />
      </MemoryRouter>
    )
    const view = render(tree(new Set(['t2'])))

    const spinner = screen.getByTestId('session-running-t2')
    // 灰色圆环：跟 currentColor（text-ink-tertiary = 三级灰）；reduced-motion 下不转、
    // 读屏仍有一句运行说明（role=status）
    expect(spinner).toHaveClass('animate-spin', 'text-ink-tertiary', 'motion-reduce:animate-none')
    expect(spinner).toHaveAttribute('role', 'status')
    expect(spinner).toHaveAccessibleName('正在生成回复')
    // 运行优先完成点：同一个槽只画一个（灰圈），圆点的数据不被运行态动到
    expect(screen.queryByTestId('session-done-t2')).not.toBeInTheDocument()
    // 没在跑的行没有灰圈
    expect(screen.queryByTestId('session-running-t1')).not.toBeInTheDocument()

    // 跑完（running 撤下）：完成点原样回来（未读语义没被运行态破坏）
    view.rerender(tree(new Set()))
    expect(screen.queryByTestId('session-running-t2')).not.toBeInTheDocument()
    expect(screen.getByTestId('session-done-t2')).toBeInTheDocument()
  })

  it('round 20：置顶的行带图钉标识（"排最前"由 composeSidebarSessions 给，列表不再自己分组）', () => {
    renderList([entry('t1', '甲'), entry('t2', '乙')], { pinnedIds: new Set(['t2']) })

    expect(screen.getByTestId('session-pin-mark-t2')).toBeInTheDocument()
    expect(screen.queryByTestId('session-pin-mark-t1')).not.toBeInTheDocument()
  })
})

/**
 * task-66 · 侧栏历史会话重设计（参考 DSH claude-style）：
 *   行首圆孔（选中实心/未选中空心）、行尾相对时间、hover 三枚动作（⋯ / 归档 / 置顶）、
 *   置顶图钉在时间左侧；运行 > 未读 > 选中/普通 的优先级保持。
 */
describe('task-66 · 行首状态圆孔 / 相对时间 / hover 动作', () => {
  const MINUTES_AGO = new Date(Date.now() - 5 * 60_000).toISOString()

  it('行首圆孔：选中 = 实心（--text-primary）+ 整行 bg-selected；未选中 = 空心环（--text-tertiary）', () => {
    renderList([entry('t1', '甲'), entry('t2', '乙')], { activeId: 't1' })

    const selectedDot = screen.getByTestId('session-dot-t1')
    expect(selectedDot).toHaveAttribute('data-state', 'selected')
    expect(selectedDot).toHaveClass('border-(--text-primary)', 'bg-(--text-primary)')
    expect(selectedDot).toHaveAttribute('aria-hidden', 'true')

    const idleDot = screen.getByTestId('session-dot-t2')
    expect(idleDot).toHaveAttribute('data-state', 'idle')
    expect(idleDot).toHaveClass('border-(--text-tertiary)', 'bg-transparent')
    expect(screen.getByTestId('session-row-t1')).toHaveClass('bg-selected')
    expect(screen.getByTestId('session-row-t2')).not.toHaveClass('bg-selected')
  })

  it('行尾相对时间：c1 三级灰 + tabular-nums；置顶图钉在时间左侧', () => {
    renderList([{ id: 't1', title: '甲', updatedAt: MINUTES_AGO }], {
      pinnedIds: new Set(['t1'])
    })

    const time = screen.getByTestId('session-time-t1')
    expect(time).toHaveTextContent(/分钟$/)
    expect(time).toHaveClass('text-c1', 'text-ink-tertiary', 'tabular-nums')
    // 图钉与时间同处行尾槽，图钉在时间之前（不抢行首的圆孔）
    const pin = screen.getByTestId('session-pin-mark-t1')
    expect(pin.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByTestId('session-item-t1').contains(pin)).toBe(false)
  })

  it('hover 槽：行尾有三枚 24px 动作（⋯ / 归档 / 置顶），默认透明、hover/focus 才可点', () => {
    renderList([entry('t1', '甲')])

    const actions = screen.getByTestId('session-actions-t1')
    expect(actions).toHaveClass('opacity-0', 'pointer-events-none')
    expect(actions.className).toContain('group-hover/row:opacity-100')
    expect(actions.className).toContain('group-focus-within/row:opacity-100')
    for (const testId of ['session-more-t1', 'session-quick-archive-t1', 'session-quick-pin-t1']) {
      const button = screen.getByTestId(testId)
      expect(button).toHaveClass('size-6')
      expect(actions.contains(button)).toBe(true)
    }
    // 置顶态下第三枚是「取消置顶」（语义随状态翻转）
    expect(screen.getByTestId('session-quick-pin-t1')).toHaveAttribute('aria-label', '置顶会话：甲')
  })

  it('置顶态：第三枚动作变成「取消置顶」', () => {
    renderList([entry('t1', '甲')], { pinnedIds: new Set(['t1']) })
    expect(screen.getByTestId('session-quick-pin-t1')).toHaveAttribute('aria-label', '取消置顶：甲')
  })

  it('行尾时间槽固定宽度（min-w-[76px]）：动作出现/消失不挪标题（不抖）', () => {
    renderList([entry('t1', '甲')])
    expect(screen.getByTestId('session-tail-t1')).toHaveClass('min-w-[76px]')
  })

  it('运行 > 未读 > 选中：在跑画 Spinner，未读画 accent 点，二者都不画普通圆孔', () => {
    renderList([entry('t1', '甲'), entry('t2', '乙'), entry('t3', '丙')], {
      activeId: 't1',
      notices: { t2: true, t3: true },
      runningIds: new Set(['t2'])
    })

    expect(screen.getByTestId('session-running-t2')).toBeInTheDocument()
    expect(screen.queryByTestId('session-done-t2')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-dot-t2')).not.toBeInTheDocument()
    // 未读（t3）用 accent 实心点，且不画空心环
    expect(screen.getByTestId('session-done-t3')).toBeInTheDocument()
    expect(screen.queryByTestId('session-dot-t3')).not.toBeInTheDocument()
    // 选中的空闲行仍是实心圆孔
    expect(screen.getByTestId('session-dot-t1')).toHaveAttribute('data-state', 'selected')
  })
})

/**
 * task-66 · 行尾快捷动作的行为：直接接 useSessionActions（与 ⋯ 菜单同一份实现）。
 * 置顶 → settings.pinnedThreads；归档 → settings.archivedThreads 快照（失败走 onActionError）。
 */
describe('task-66 · 行尾快捷动作（置顶 / 归档）', () => {
  function renderWithBridge(): { update: ReturnType<typeof vi.fn> } {
    const bridge = installKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
    useSessionsStore.setState({
      threads: [{ id: 't1', title: '甲', updatedAt: TODAY }],
      activeId: 't1',
      loaded: true,
      error: null,
      notices: {}
    })
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <SessionList sessions={[entry('t1', '甲')]} activeId="t1" onSelect={vi.fn()} />
      </MemoryRouter>
    )
    return { update: bridge.update as unknown as ReturnType<typeof vi.fn> }
  }

  it('置顶快捷：写 settings.pinnedThreads（整表替换）', async () => {
    const { update } = renderWithBridge()

    fireEvent.click(screen.getByTestId('session-quick-pin-t1'))

    await waitFor(() => expect(update).toHaveBeenCalledWith({ pinnedThreads: ['t1'] }))
  })

  it('归档快捷：写快照（标题/项目/时间）进 archivedThreads，行从侧栏消失', async () => {
    const { update } = renderWithBridge()

    fireEvent.click(screen.getByTestId('session-quick-archive-t1'))

    await waitFor(() => {
      const payload = update.mock.calls
        .map(
          (call) =>
            call[0] as { archivedThreads?: Array<{ threadId: string; title: string | null }> }
        )
        .find((patch) => patch.archivedThreads !== undefined)
      expect(payload?.archivedThreads?.[0]).toMatchObject({ threadId: 't1', title: '甲' })
    })
  })
})
