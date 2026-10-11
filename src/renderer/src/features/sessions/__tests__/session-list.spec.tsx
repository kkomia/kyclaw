import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { tick } from '@renderer/components/ui/__tests__/tick'
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

describe('round 20 · ⋯ 菜单扩展（照图2 裁剪）', () => {
  interface RowHandlers {
    onTogglePin: ReturnType<typeof vi.fn>
    onMoveToProject: ReturnType<typeof vi.fn>
    onOpenInExplorer: ReturnType<typeof vi.fn>
    onArchive: ReturnType<typeof vi.fn>
    onRename: ReturnType<typeof vi.fn>
  }

  /** 两张会话：t1 属于项目 p1、有工作区；t2 无项目、无工作区（打开资源管理器应禁用） */
  function renderRow(props: Partial<Parameters<typeof SessionList>[0]> = {}): RowHandlers {
    const onTogglePin = vi.fn()
    const onMoveToProject = vi.fn()
    const onOpenInExplorer = vi.fn()
    const onArchive = vi.fn()
    const onRename = vi.fn()
    render(
      <MemoryRouter>
        <SessionList
          sessions={[entry('t1', '甲'), entry('t2', '乙', EARLIER)]}
          activeId={null}
          onSelect={vi.fn()}
          onRename={onRename}
          onDelete={vi.fn()}
          projects={[{ id: 'p1', name: '项目一' }]}
          projectIdOf={(threadId) => (threadId === 't1' ? 'p1' : null)}
          canOpenExplorerOf={(threadId) => threadId === 't1'}
          onTogglePin={onTogglePin}
          onMoveToProject={onMoveToProject}
          onOpenInExplorer={onOpenInExplorer}
          onArchive={onArchive}
          {...props}
        />
      </MemoryRouter>
    )
    return { onTogglePin, onMoveToProject, onOpenInExplorer, onArchive, onRename }
  }

  /** 打开 ⋯ 菜单（Radix 键盘口），再把某个子菜单展开 */
  async function openSubmenu(testId: string): Promise<void> {
    fireEvent.keyDown(screen.getByTestId('session-more-t1'), { key: 'ArrowDown' })
    const trigger = screen.getByTestId(testId)
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    await tick()
  }

  it('菜单顺序照图2：置顶 / 移至项目 ▸ / 在文件资源管理器中打开 / 重命名 / 归档 / 删除（danger 最后）', () => {
    renderRow()
    fireEvent.keyDown(screen.getByTestId('session-more-t1'), { key: 'ArrowDown' })

    for (const id of [
      'session-pin-t1',
      'session-move-t1',
      'session-open-t1',
      'session-rename-t1',
      'session-archive-t1',
      'session-delete-t1'
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    // 重命名/归档保序，删除是最后的红字危险项
    const texts = screen
      .getAllByRole('menuitem')
      .map((item) => item.textContent?.replace('▸', '').trim())
    expect(texts.slice(-3)).toEqual(['重命名', '归档', '删除'])
    expect(screen.getByTestId('session-delete-t1')).toHaveClass('text-danger')
  })

  it('置顶（toggle）：未置顶显示「置顶」，点它回调 (id, true)', () => {
    const { onTogglePin } = renderRow()
    pick('session-more-t1', 'session-pin-t1')
    expect(onTogglePin).toHaveBeenCalledWith('t1', true)
  })

  it('已置顶：行里有图钉标识、菜单变「取消置顶」、点它回调 (id, false)；置顶的提到时间分组之上', () => {
    const { onTogglePin } = renderRow({ pinnedIds: new Set(['t2']) })

    // 标识是图标（不是小字）；平铺区里单独一组在最上面
    expect(screen.getByTestId('session-pin-mark-t2')).toBeInTheDocument()
    const pinnedGroup = screen.getByTestId('session-group-pinned')
    expect(pinnedGroup).toContainElement(screen.getByTestId('session-row-t2'))
    expect(screen.getByTestId('session-group-today')).toContainElement(
      screen.getByTestId('session-row-t1')
    )

    fireEvent.keyDown(screen.getByTestId('session-more-t2'), { key: 'ArrowDown' })
    pick('session-more-t2', 'session-pin-t2')
    expect(onTogglePin).toHaveBeenCalledWith('t2', false)
  })

  it('移至项目 ▸：列出现有项目 +「无项目」，当前项目勾选；选中回调 (id, projectId)', async () => {
    const { onMoveToProject } = renderRow()
    await openSubmenu('session-move-t1')

    expect(screen.getByTestId('session-move-t1-p1')).toHaveTextContent('项目一')
    expect(screen.getByTestId('session-move-t1-p1')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('session-move-none-t1')).toHaveTextContent('无项目')

    fireEvent.click(screen.getByTestId('session-move-t1-p1'))
    expect(onMoveToProject).toHaveBeenCalledWith('t1', 'p1')
  })

  it('移至项目 ▸：「无项目」把会话移出项目（回调 projectId = null）', async () => {
    const { onMoveToProject } = renderRow()
    fireEvent.keyDown(screen.getByTestId('session-more-t2'), { key: 'ArrowDown' })
    const trigger = screen.getByTestId('session-move-t2')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    await tick()

    expect(screen.getByTestId('session-move-none-t2')).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByTestId('session-move-none-t2'))
    expect(onMoveToProject).toHaveBeenCalledWith('t2', null)
  })

  it('在文件资源管理器中打开：判得出工作区的可点（回调 id）；判不出的禁用', () => {
    const { onOpenInExplorer } = renderRow()
    fireEvent.keyDown(screen.getByTestId('session-more-t1'), { key: 'ArrowDown' })
    expect(screen.getByTestId('session-open-t1')).not.toBeDisabled()
    pick('session-more-t1', 'session-open-t1')
    expect(onOpenInExplorer).toHaveBeenCalledWith('t1')

    // t2 没有工作区：可见但禁用（Radix 的条目是 div[data-disabled]，不是 button）
    fireEvent.keyDown(screen.getByTestId('session-more-t2'), { key: 'ArrowDown' })
    expect(screen.getByTestId('session-open-t2')).toHaveAttribute('data-disabled')
  })

  it('归档：回调 id（删数据不在这里发生；快照由上层写）', () => {
    const { onArchive } = renderRow()
    pick('session-more-t1', 'session-archive-t1')
    expect(onArchive).toHaveBeenCalledWith('t1')
  })

  it('没有项目清单时：移至项目 ▸ 只有「无项目」一项（不假装有项目可选）', async () => {
    renderRow({ projects: [], projectIdOf: undefined })
    await openSubmenu('session-move-t1')

    expect(screen.getByTestId('session-move-none-t1')).toBeInTheDocument()
    expect(screen.queryByTestId('session-move-t1-p1')).not.toBeInTheDocument()
  })
})
