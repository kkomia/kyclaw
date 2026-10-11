import { useState } from 'react'
import { ChevronRight, Ellipsis, Folder, Plus } from 'lucide-react'
import type { Project } from '@shared/projects'
import { Button } from '../../components/ui/button'
import { cn } from '../../components/ui/cn'
import { Dialog } from '../../components/ui/dialog'
import { IconButton } from '../../components/ui/icon-button'
import { Menu } from '../../components/ui/menu'
import { Tooltip } from '../../components/ui/tooltip'
import { navItemClass } from '../../components/shell/nav-item'
import { SessionList, type SessionListEntry } from '../sessions/SessionList'
import { readCollapsedProjects, writeCollapsedProjects } from './project-fold'

/**
 * 侧栏「项目」区（T18；形态参考 Kimi 的 项目 ∨ + 悬浮 ＋）：
 *   标题行（`项目` + 悬浮/聚焦出现的 ＋ 菜单：新建空白项目 / 使用现有文件夹）
 *   → 项目行（折叠指示 + 文件夹图标 + 名称；行尾"更多"菜单里是删除）
 *   → 项目名下的会话（缩进一层，复用 SessionList：选中/完成点/重命名/删除都与平铺区一致）。
 *
 * round 16（用户实拍）：
 *   - **点项目行 = 展开/折叠**名下会话（`aria-expanded` + 行首 chevron 旋转；开合走 .trace-fold
 *     的 grid-rows 过渡，reduced-motion 由 CSS 域兜底）；折叠状态按项目 id 记 localStorage，默认展开；
 *   - **悬停隔离**：hover 灰底只挂在行按钮自身（行按钮 `flex-1 min-w-0`、⋯ 用 flex 占位 `w-7 shrink-0`），
 *     项目行不再有持久选中填充（Fills-F2 与 hover 的 Fills-F1 肉眼几乎一样，选中项目叠在悬停会话旁
 *     正是用户说的"同时 hover 阴影"）。
 *
 * 纯展示：数据与动作都由 ProjectsSection 给（不直接碰 store / 网络），方便单测。
 */
export interface ProjectListProps {
  projects: Project[]
  /** 每个项目名下的会话（含草稿） */
  sessionsOf: (projectId: string) => SessionListEntry[]
  activeSessionId: string | null
  notices?: Record<string, true>
  onSelectSession: (threadId: string) => void
  onRenameSession: (threadId: string, title: string) => void
  onDeleteSession: (threadId: string) => void
  onDeleteProject: (project: Project) => void
  onCreateBlank: () => void
  onCreateFolder: () => void
  /** round 20：项目名下的会话行同样按新口径给 ⋯ 菜单（透传给 SessionList） */
  pinnedIds?: ReadonlySet<string>
  projectIdOf?: (threadId: string) => string | null
  canOpenExplorerOf?: (threadId: string) => boolean
  onTogglePin?: (threadId: string, pinned: boolean) => void
  onMoveToProject?: (threadId: string, projectId: string | null) => void
  onOpenInExplorer?: (threadId: string) => void
  onArchive?: (threadId: string) => void
}

export function ProjectList({
  projects,
  sessionsOf,
  activeSessionId,
  notices = {},
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onDeleteProject,
  onCreateBlank,
  onCreateFolder,
  pinnedIds,
  projectIdOf,
  canOpenExplorerOf,
  onTogglePin,
  onMoveToProject,
  onOpenInExplorer,
  onArchive
}: ProjectListProps): React.JSX.Element {
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  /** 收起的项目 id（localStorage 轻量持久；默认展开 = 不在集合里） */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => readCollapsedProjects())

  const toggleProject = (projectId: string): void => {
    const next = new Set(collapsed)
    if (next.has(projectId)) next.delete(projectId)
    else next.add(projectId)
    writeCollapsedProjects(next)
    setCollapsed(next)
  }

  return (
    <div data-testid="project-section" className="flex flex-col gap-0.5 px-2 pt-2">
      <div className="group/section relative flex h-(--nav-item-height) items-center px-2">
        <span data-testid="project-section-title" className="text-c2 text-ink-tertiary">
          项目
        </span>
        {/* 悬浮/键盘聚焦才出现的 ＋（参考的形态）；菜单本体走既有 Menu 口径 */}
        <div className="absolute right-0 opacity-0 transition-opacity duration-(--motion-fast) group-hover/section:opacity-100 focus-within:opacity-100">
          <Menu
            align="end"
            trigger={
              <IconButton
                label="新建项目"
                data-testid="project-add"
                icon={<Plus />}
                className="size-7 border-transparent"
              />
            }
            items={[
              {
                id: 'blank',
                label: '新建空白项目',
                icon: <Plus />,
                testId: 'project-create-blank',
                onSelect: onCreateBlank
              },
              {
                id: 'folder',
                label: '使用现有文件夹',
                icon: <Folder />,
                testId: 'project-create-folder',
                onSelect: onCreateFolder
              }
            ]}
          />
        </div>
      </div>

      {projects.map((project) => {
        const isCollapsed = collapsed.has(project.id)
        const sessions = sessionsOf(project.id)

        return (
          <div
            key={project.id}
            data-testid={`project-group-${project.id}`}
            className="group/project flex flex-col gap-0.5"
          >
            {/* 行 = 折叠按钮（flex-1 min-w-0，hover 只在自己身上）+ ⋯ 的固定占位（w-7 shrink-0） */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                data-testid={`project-item-${project.id}`}
                aria-expanded={!isCollapsed}
                className={cn(navItemClass(), 'min-w-0 flex-1')}
                onClick={() => toggleProject(project.id)}
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    'size-3.5 shrink-0 text-ink-tertiary transition-transform duration-(--motion-fast) ease-main motion-reduce:transition-none',
                    !isCollapsed && 'rotate-90'
                  )}
                />
                <Folder
                  aria-hidden="true"
                  className="size-(--icon-size-sm) shrink-0 text-ink-tertiary"
                />
                <Tooltip label={project.path} side="bottom" align="start">
                  <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                </Tooltip>
              </button>
              <div className="w-7 shrink-0 opacity-0 transition-opacity duration-(--motion-fast) group-hover/project:opacity-100 focus-within:opacity-100">
                <Menu
                  align="end"
                  trigger={
                    <IconButton
                      label={`项目操作：${project.name}`}
                      data-testid={`project-more-${project.id}`}
                      icon={<Ellipsis />}
                      className="size-7 border-transparent"
                    />
                  }
                  items={[
                    {
                      id: 'delete',
                      label: '删除',
                      danger: true,
                      testId: `project-delete-${project.id}`,
                      onSelect: () => setDeleteTarget(project)
                    }
                  ]}
                />
              </div>
            </div>

            {sessions.length === 0 ? null : (
              <div
                data-testid={`project-sessions-${project.id}`}
                data-open={isCollapsed ? 'false' : 'true'}
                className="trace-fold"
              >
                <div className="trace-fold-in">
                  <div className="ps-3">
                    <SessionList
                      sessions={sessions}
                      activeId={activeSessionId}
                      notices={notices}
                      showGroups={false}
                      emptyHint={false}
                      listClassName="min-h-0 overflow-visible pt-0"
                      onSelect={onSelectSession}
                      onRename={onRenameSession}
                      onDelete={onDeleteSession}
                      pinnedIds={pinnedIds}
                      projects={projects.map((project) => ({ id: project.id, name: project.name }))}
                      projectIdOf={projectIdOf}
                      canOpenExplorerOf={canOpenExplorerOf}
                      onTogglePin={onTogglePin}
                      onMoveToProject={onMoveToProject}
                      onOpenInExplorer={onOpenInExplorer}
                      onArchive={onArchive}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}

      {/* 删除项目：受控 Dialog，二次确认（R12）。文案只说产品语义：项目与文件夹是两回事 */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title="删除项目？"
        description={
          deleteTarget === null
            ? ''
            : `「${deleteTarget.name}」会从项目列表里去掉，文件夹和里面的文件都不动。`
        }
        footer={
          <>
            <Button
              variant="ghost"
              data-testid="project-delete-cancel"
              onClick={() => setDeleteTarget(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              data-testid="project-delete-confirm"
              onClick={() => {
                const target = deleteTarget
                setDeleteTarget(null)
                if (target !== null) onDeleteProject(target)
              }}
            >
              删除
            </Button>
          </>
        }
      />
    </div>
  )
}
