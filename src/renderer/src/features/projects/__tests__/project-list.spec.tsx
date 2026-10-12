import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/projects'
import { ProjectList, type ProjectListProps } from '../ProjectList'

/**
 * 侧栏「项目」区（纯展示，T18；round 16 补折叠与悬停隔离/截断）：
 * 标题 + 悬浮 ＋ 的两路菜单、项目行与它名下的会话、点项目行展开/折叠（localStorage 记忆）、
 * 悬停类只挂行自身、⋯ 用固定宽度占位（长标题截断不重叠）、删除确认框。
 * 数据/动作都是给的 props，直接断言回调。
 */
const projects: Project[] = [
  { id: 'p1', name: '插件', path: 'D:\\ws\\插件', createdAt: '2026-10-11T00:00:00.000Z' },
  { id: 'p2', name: '资料', path: 'D:\\ws\\资料', createdAt: '2026-10-11T00:00:00.000Z' }
]

beforeEach(() => {
  // 折叠状态记在 localStorage：每个用例从"全展开"开始
  window.localStorage.clear()
})

function renderList(overrides: Partial<ProjectListProps> = {}): {
  props: ProjectListProps
  unmount: () => void
} {
  const props: ProjectListProps = {
    projects,
    sessionsOf: (projectId) =>
      projectId === 'p1'
        ? [
            {
              id: 't-a',
              title: '插件里的会话',
              updatedAt: '2026-10-11T09:00:00.000Z'
            }
          ]
        : [],
    activeSessionId: null,
    onSelectSession: vi.fn(),
    onDeleteProject: vi.fn(),
    onCreateBlank: vi.fn(),
    onCreateFolder: vi.fn(),
    ...overrides
  }
  const view = render(
    <MemoryRouter>
      <ProjectList {...props} />
    </MemoryRouter>
  )
  return { props, unmount: view.unmount }
}

/** Radix 菜单：键盘打开（ArrowDown）后在条目上回车选中 */
function pick(triggerTestId: string, itemTestId: string): void {
  fireEvent.keyDown(screen.getByTestId(triggerTestId), { key: 'ArrowDown' })
  fireEvent.keyDown(screen.getByTestId(itemTestId), { key: 'Enter' })
}

describe('ProjectList', () => {
  it('列出项目与它名下的会话；没有会话的项目不显示空列表', () => {
    renderList()

    expect(screen.getByTestId('project-section-title')).toHaveTextContent('项目')
    expect(screen.getByTestId('project-item-p1')).toHaveTextContent('插件')
    expect(screen.getByTestId('project-item-p2')).toHaveTextContent('资料')
    // 会话由 SessionList 渲染（同一套行）挂在项目下；p2 名下没有会话 → 没有空态行
    expect(screen.getByTestId('project-group-p1')).toContainElement(
      screen.getByTestId('session-item-t-a')
    )
    expect(screen.queryByTestId('session-list-empty')).not.toBeInTheDocument()
  })

  it('整行 hover 底（round 27）：行容器穿 navItem 外观（盖住行尾 ⋯/⊕），与子列表仍隔离', () => {
    renderList()

    const row = screen.getByTestId('project-row-p1')
    const projectRow = screen.getByTestId('project-item-p1')
    const sessionRow = screen.getByTestId('session-row-t-a')
    // 整行一个 hover 底：⋯ 与 ⊕ 都在行容器里（用户口径：底要盖住两个按钮）
    expect(row).toHaveClass('hover:bg-hover', 'h-(--nav-item-height)', 'rounded-control')
    expect(row).toContainElement(screen.getByTestId('project-more-p1'))
    expect(row).toContainElement(screen.getByTestId('project-new-session-p1'))
    // 折叠按钮退成纯布局：不自己铺底（避免两截底色）
    expect(projectRow).not.toHaveClass('hover:bg-hover')
    // 项目行没有持久填充：Fills-F2（选中）与 Fills-F1（hover）肉眼无差，
    // "选中的项目 + 悬停的会话"同时灰着正是用户实拍的"同时 hover 阴影"
    expect(row).not.toHaveClass('bg-selected')
    // 与子列表的隔离仍在：会话行不在项目行容器里（各自 hover，互不点亮）
    expect(row).not.toContainElement(sessionRow)
    expect(sessionRow).toHaveClass('hover:bg-hover')
  })

  it('点项目行 = 展开/折叠名下会话（aria-expanded + chevron 旋转，收起不卸载）；再点展开', () => {
    renderList()

    const projectRow = screen.getByTestId('project-item-p1')
    const fold = screen.getByTestId('project-sessions-p1')
    expect(projectRow).toHaveAttribute('aria-expanded', 'true')
    expect(fold).toHaveAttribute('data-open', 'true')
    // 展开时 chevron 转 90°（旋转过渡，reduced-motion 由 CSS 域兜底）
    expect(projectRow.querySelector('svg')?.getAttribute('class') ?? '').toContain('rotate-90')

    fireEvent.click(projectRow)
    expect(projectRow).toHaveAttribute('aria-expanded', 'false')
    expect(fold).toHaveAttribute('data-open', 'false')
    // 收起 ≠ 卸载：内容留在 DOM 里走 .trace-fold 的过渡
    expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()

    fireEvent.click(projectRow)
    expect(fold).toHaveAttribute('data-open', 'true')
  })

  it('折叠状态按项目 id 记忆（localStorage 持久）：重挂载后仍收起，别的项目不受影响', () => {
    const first = renderList()
    fireEvent.click(screen.getByTestId('project-item-p1'))
    expect(window.localStorage.getItem('kyclaw.projects.collapsed')).toContain('"p1"')

    first.unmount()
    renderList()
    expect(screen.getByTestId('project-sessions-p1')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('project-item-p2')).toHaveAttribute('aria-expanded', 'true')
  })

  it('round 61：与「任务」组共用一份折叠存储——收起项目不冲掉任务组的收起项（先读后写）', () => {
    window.localStorage.setItem('kyclaw.projects.collapsed', JSON.stringify(['__tasks__']))
    renderList()

    fireEvent.click(screen.getByTestId('project-item-p1'))

    expect(JSON.parse(window.localStorage.getItem('kyclaw.projects.collapsed') ?? '[]')).toEqual(
      expect.arrayContaining(['__tasks__', 'p1'])
    )
  })

  it('长标题截断不压到 ⋯（round 16）：文本 truncate + ⋯ 固定宽度占位（不绝对定位）', () => {
    renderList()

    const title = screen.getByTestId('session-item-t-a').querySelector('[class*="truncate"]')
    expect(title).not.toBeNull()
    const more = screen.getByTestId('session-more-t-a').parentElement
    expect(more?.className ?? '').toContain('w-7')
    expect(more?.className ?? '').toContain('shrink-0')
    expect(more?.className ?? '').not.toContain('absolute')

    // 项目行的 ⋯ 同样让位
    const projectMore = screen.getByTestId('project-more-p1').parentElement
    expect(projectMore?.className ?? '').toContain('shrink-0')
    expect(projectMore?.className ?? '').not.toContain('absolute')
    expect(
      screen.getByTestId('project-item-p1').querySelector('[class*="truncate"]')
    ).not.toBeNull()
  })

  it('点项目名下的会话：回调带着会话 id', () => {
    const { props } = renderList()
    fireEvent.click(screen.getByTestId('session-item-t-a'))
    expect(props.onSelectSession).toHaveBeenCalledWith('t-a')
  })

  it('＋ 菜单两条路：新建空白项目 / 使用现有文件夹各自回调', () => {
    const { props } = renderList()

    pick('project-add', 'project-create-blank')
    expect(props.onCreateBlank).toHaveBeenCalledTimes(1)

    pick('project-add', 'project-create-folder')
    expect(props.onCreateFolder).toHaveBeenCalledTimes(1)
  })

  it('项目行"更多" → 删除 → 二次确认后才回调（取消则不动）', () => {
    const { props } = renderList()

    pick('project-more-p2', 'project-delete-p2')
    expect(screen.getByText('删除项目？')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('project-delete-cancel'))
    expect(props.onDeleteProject).not.toHaveBeenCalled()

    pick('project-more-p2', 'project-delete-p2')
    fireEvent.click(screen.getByTestId('project-delete-confirm'))
    expect(props.onDeleteProject).toHaveBeenCalledWith(projects[1])
  })
})

/** round 25：项目行 ⋯ 菜单（图2）+ ⊕ 新建会话 */
describe('ProjectList（round 25：项目行菜单与 ⊕）', () => {
  const round25Props = (): Partial<ProjectListProps> => ({
    onTogglePinProject: vi.fn(),
    onOpenProjectInExplorer: vi.fn(),
    onRenameProject: vi.fn(),
    onArchiveProject: vi.fn(),
    onCreateSession: vi.fn()
  })

  it('⋯ 菜单条目与顺序：置顶/打开/重命名 ‖ 归档 ‖ 删除（红字收尾）', () => {
    renderList(round25Props())

    fireEvent.keyDown(screen.getByTestId('project-more-p1'), { key: 'ArrowDown' })
    const items = screen.getAllByRole('menuitem')
    expect(items.map((el) => el.textContent)).toEqual([
      '置顶项目',
      '在文件资源管理器中打开',
      '重命名项目',
      '归档',
      '删除'
    ])
    expect(items[4].className).toContain('text-danger')
  })

  it('置顶项目：行内图钉标识 + 菜单文案随状态；toggle 回调带新状态（true=置顶）', () => {
    const props = round25Props()
    renderList({ ...props, pinnedProjectIds: new Set(['p1']) })

    expect(screen.getByTestId('project-pin-mark-p1')).toBeInTheDocument()
    expect(screen.queryByTestId('project-pin-mark-p2')).not.toBeInTheDocument()

    // 已置顶 → 菜单是「取消置顶项目」，回调 false
    fireEvent.keyDown(screen.getByTestId('project-more-p1'), { key: 'ArrowDown' })
    expect(screen.getByTestId('project-pin-p1')).toHaveTextContent('取消置顶项目')
    fireEvent.keyDown(screen.getByTestId('project-pin-p1'), { key: 'Enter' })
    expect(props.onTogglePinProject).toHaveBeenCalledWith('p1', false)

    // 未置顶 → 「置顶项目」，回调 true
    pick('project-more-p2', 'project-pin-p2')
    expect(props.onTogglePinProject).toHaveBeenCalledWith('p2', true)
  })

  it('未接回调时对应菜单项禁用、⊕ 禁用（纯展示防线）', () => {
    renderList()

    fireEvent.keyDown(screen.getByTestId('project-more-p1'), { key: 'ArrowDown' })
    expect(screen.getByTestId('project-pin-p1')).toHaveAttribute('data-disabled')
    expect(screen.getByTestId('project-rename-p1')).toHaveAttribute('data-disabled')
    expect(screen.getByTestId('project-archive-p1')).toHaveAttribute('data-disabled')
    expect(screen.getByTestId('project-new-session-p1')).toBeDisabled()
  })

  it('⊕ = 在该项目下新建会话（回调带项目 id；不在行按钮内，悬停隔离保持）', () => {
    const props = round25Props()
    renderList(props)

    const plus = screen.getByTestId('project-new-session-p2')
    expect(plus).toHaveAccessibleName('在「资料」里新建会话')
    fireEvent.click(plus)
    expect(props.onCreateSession).toHaveBeenCalledWith('p2')

    expect(screen.getByTestId('project-item-p2')).not.toContainElement(plus)
    expect(screen.getByTestId('project-more-p2')).not.toContainElement(plus)
  })

  it('在文件资源管理器中打开 / 归档：各自回调带项目 id', () => {
    const props = round25Props()
    renderList(props)

    pick('project-more-p1', 'project-open-p1')
    expect(props.onOpenProjectInExplorer).toHaveBeenCalledWith('p1')

    pick('project-more-p2', 'project-archive-p2')
    expect(props.onArchiveProject).toHaveBeenCalledWith('p2')
  })

  it('重命名项目：对话框初始值为当前名称；保存回调、空名禁用保存、取消不回调', () => {
    const props = round25Props()
    renderList(props)

    pick('project-more-p1', 'project-rename-p1')
    const input = screen.getByTestId('project-rename-input')
    expect(input).toHaveValue('插件')

    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByTestId('project-rename-save')).toBeDisabled()

    fireEvent.change(input, { target: { value: '新名字' } })
    fireEvent.click(screen.getByTestId('project-rename-save'))
    expect(props.onRenameProject).toHaveBeenCalledWith('p1', '新名字')

    // 取消：编辑后取消不触发回调
    pick('project-more-p1', 'project-rename-p1')
    fireEvent.change(screen.getByTestId('project-rename-input'), { target: { value: '别的' } })
    fireEvent.click(screen.getByTestId('project-rename-cancel'))
    expect(props.onRenameProject).toHaveBeenCalledTimes(1)
  })
})
