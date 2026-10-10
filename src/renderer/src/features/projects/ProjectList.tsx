import { useState } from 'react'
import { Ellipsis, Folder, Plus } from 'lucide-react'
import type { Project } from '@shared/projects'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { IconButton } from '../../components/ui/icon-button'
import { Menu } from '../../components/ui/menu'
import { Tooltip } from '../../components/ui/tooltip'
import { navItemClass } from '../../components/shell/nav-item'
import { SessionList, type SessionListEntry } from '../sessions/SessionList'

/**
 * 侧栏「项目」区（T18；形态参考 Kimi 的 项目 ∨ + 悬浮 ＋）：
 *   标题行（`项目` + 悬浮/聚焦出现的 ＋ 菜单：新建空白项目 / 使用现有文件夹）
 *   → 项目行（文件夹图标 + 名称，选中态 Fills-F2；行尾"更多"菜单里是删除）
 *   → 项目名下的会话（缩进一层，复用 SessionList：选中/完成点/重命名/删除都与平铺区一致）。
 *
 * 纯展示：数据与动作都由 ProjectsSection 给（不直接碰 store / 网络），方便单测。
 * 点项目行 = 在这个项目里开一个新会话（调用方的语义，见 ProjectsSection.createSessionIn）。
 */
export interface ProjectListProps {
  projects: Project[]
  /** 每个项目名下的会话（含草稿） */
  sessionsOf: (projectId: string) => SessionListEntry[]
  activeProjectId: string | null
  activeSessionId: string | null
  notices?: Record<string, true>
  onSelectProject: (projectId: string) => void
  onSelectSession: (threadId: string) => void
  onRenameSession: (threadId: string, title: string) => void
  onDeleteSession: (threadId: string) => void
  onDeleteProject: (project: Project) => void
  onCreateBlank: () => void
  onCreateFolder: () => void
}

export function ProjectList({
  projects,
  sessionsOf,
  activeProjectId,
  activeSessionId,
  notices = {},
  onSelectProject,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onDeleteProject,
  onCreateBlank,
  onCreateFolder
}: ProjectListProps): React.JSX.Element {
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)

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
        const selected = project.id === activeProjectId
        const sessions = sessionsOf(project.id)

        return (
          <div
            key={project.id}
            data-testid={`project-group-${project.id}`}
            className="group/project flex flex-col gap-0.5"
          >
            <div className="relative flex items-center">
              <button
                type="button"
                data-testid={`project-item-${project.id}`}
                aria-current={selected ? 'true' : undefined}
                className={navItemClass({ selected })}
                onClick={() => onSelectProject(project.id)}
              >
                <Folder
                  aria-hidden="true"
                  className="size-(--icon-size-sm) shrink-0 text-ink-tertiary"
                />
                <Tooltip label={project.path} side="bottom" align="start">
                  <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                </Tooltip>
              </button>
              <div className="absolute right-1 opacity-0 transition-opacity duration-(--motion-fast) group-hover/project:opacity-100 focus-within:opacity-100">
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
                />
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
