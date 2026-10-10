import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/projects'
import { ProjectList, type ProjectListProps } from '../ProjectList'

/**
 * 侧栏「项目」区（纯展示，T18）：标题 + 悬浮 ＋ 的两路菜单、项目行与它名下的会话、
 * 选中态、删除确认框。数据/动作都是给的 props，直接断言回调。
 */
const projects: Project[] = [
  { id: 'p1', name: '插件', path: 'D:\\ws\\插件', createdAt: '2026-10-11T00:00:00.000Z' },
  { id: 'p2', name: '资料', path: 'D:\\ws\\资料', createdAt: '2026-10-11T00:00:00.000Z' }
]

function renderList(overrides: Partial<ProjectListProps> = {}): {
  props: ProjectListProps
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
    activeProjectId: 'p1',
    activeSessionId: null,
    onSelectProject: vi.fn(),
    onSelectSession: vi.fn(),
    onRenameSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onDeleteProject: vi.fn(),
    onCreateBlank: vi.fn(),
    onCreateFolder: vi.fn(),
    ...overrides
  }
  render(
    <MemoryRouter>
      <ProjectList {...props} />
    </MemoryRouter>
  )
  return { props }
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

  it('选中项目带选中态（aria-current + 填充）', () => {
    renderList()
    expect(screen.getByTestId('project-item-p1')).toHaveClass('bg-selected')
    expect(screen.getByTestId('project-item-p2')).not.toHaveClass('bg-selected')
  })

  it('点项目行：回调带着项目 id（由调用方决定"在它里面开一个新会话"）', () => {
    const { props } = renderList()
    fireEvent.click(screen.getByTestId('project-item-p2'))
    expect(props.onSelectProject).toHaveBeenCalledWith('p2')
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
