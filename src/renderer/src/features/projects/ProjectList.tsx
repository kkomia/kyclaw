import { useState } from 'react'
import {
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  FolderPlus,
  MessageSquarePlus,
  Pin,
  Plus
} from 'lucide-react'
import type { Project } from '@shared/projects'
import { Button } from '../../components/ui/button'
import { cn } from '../../components/ui/cn'
import { Dialog } from '../../components/ui/dialog'
import { IconButton } from '../../components/ui/icon-button'
import { Input } from '../../components/ui/input'
import { Menu, type MenuEntry } from '../../components/ui/menu'
import { Tooltip } from '../../components/ui/tooltip'
import { navItemClass } from '../../components/shell/nav-item'
import { SessionList, type SessionListEntry } from '../sessions/SessionList'
import { readCollapsedProjects, PROJECTS_FOLD_ID, toggleCollapsed } from './project-fold'

/**
 * 侧栏「项目」区（T18；形态参考 Kimi 的 项目 ∨ + 悬浮 ＋）：
 *   组头（chevron + `项目` + 行尾「项目管理」图标菜单：新建空白项目 / 使用现有文件夹 /
 *   管理工作区）→ 项目行（折叠指示 + 文件夹图标 + 名称；**行尾 = ⋯ 菜单 + ⊕ 新建会话**，
 *   都悬浮出现）→ 项目名下的会话（缩进一层，复用 SessionList）。
 *
 * round 64（用户口径："项目也要由项目菜单管理，跟任务标签一个道理"）：
 *   - **组头与「任务」组同构**：整行点开合（aria-expanded + 行首 chevron 旋转；开合走 .trace-fold
 *     的 grid-rows 过渡，reduced-motion 由 CSS 域兜底），收起状态记 localStorage 的保留 id
 *     `PROJECTS_FOLD_ID`（与项目行、「任务」组共用一份存储，先读后写所以互不冲掉）；
 *   - 行尾是**图标按钮**（不是文字按钮）的管理入口菜单，比原来那个光秃秃的标题多两件事：
 *     去设置页管理工作区（onManageWorkspaces，可不接 = 该条禁用）与既有的两条创建路径；
 *   - 空列表有可点的空态（"使用现有文件夹"，同一条创建路径），不留一行光秃秃的标题 ——
 *     没有项目时管理入口常显（不再等 hover），否则第一次建项目没有落脚点。
 *
 * round 16（用户实拍）：
 *   - **点项目行 = 展开/折叠**名下会话（`aria-expanded` + 行首 chevron 旋转；开合走 .trace-fold
 *     的 grid-rows 过渡，reduced-motion 由 CSS 域兜底）；折叠状态按项目 id 记 localStorage，默认展开；
 *
 * round 27（用户口径，round 16 的"悬停隔离"作废）：**整行一个 hover 底**——含行尾 ⋯ 与 ⊕
 *   （对齐 SessionList 的行容器口径：外观穿在行容器 `project-row-*` 上，内部按钮不铺底）；
 *   与子列表的隔离仍在：会话行不在项目行容器里，hover 互不点亮。
 *
 * round 25（图2）：行尾两个按钮（hover/聚焦出现，与既有行操作同一观感）：
 *   - **⋯ 菜单**：置顶项目（toggle）/ 在文件资源管理器中打开 / 重命名项目 / 归档 / 删除（danger 最后）；
 *   - **⊕**：直接在该项目下新建会话（round 16 拿掉的那条路，做成显式按钮）。
 *
 * 纯展示：数据与动作都由 ProjectsSection 给（不直接碰 store / 网络），方便单测。
 */
export interface ProjectListProps {
  projects: Project[]
  /** 每个项目名下的会话（含草稿） */
  sessionsOf: (projectId: string) => SessionListEntry[]
  activeSessionId: string | null
  notices?: Record<string, true>
  /** round 25：置顶项目 id（行内图钉标识） */
  pinnedProjectIds?: ReadonlySet<string>
  onSelectSession: (threadId: string) => void
  onDeleteProject: (project: Project) => void
  onTogglePinProject?: (projectId: string, pinned: boolean) => void
  onOpenProjectInExplorer?: (projectId: string) => void
  onRenameProject?: (projectId: string, name: string) => void
  onArchiveProject?: (projectId: string) => void
  /** round 25：⊕ = 在这个项目下开一个新会话 */
  onCreateSession?: (projectId: string) => void
  onCreateBlank: () => void
  onCreateFolder: () => void
  /** round 64：组头管理菜单里的「管理工作区」= 去设置页的工作区栏（不接 = 该条禁用） */
  onManageWorkspaces?: () => void
  /** round 20：置顶会话的行内图钉标识（透传给 SessionList） */
  pinnedIds?: ReadonlySet<string>
  /** 010：在跑的会话 id（透传给 SessionList → 项目分组里的行尾灰圈） */
  runningIds?: ReadonlySet<string>
  /** round 24：会话行动作失败的一句话（会话动作已抽到 SessionActionsMenu，见 SessionList） */
  onActionError?: (message: string) => void
}

export function ProjectList({
  projects,
  sessionsOf,
  activeSessionId,
  notices = {},
  pinnedProjectIds,
  onSelectSession,
  onDeleteProject,
  onTogglePinProject,
  onOpenProjectInExplorer,
  onRenameProject,
  onArchiveProject,
  onCreateSession,
  onCreateBlank,
  onCreateFolder,
  onManageWorkspaces,
  pinnedIds,
  runningIds,
  onActionError
}: ProjectListProps): React.JSX.Element {
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [renameTarget, setRenameTarget] = useState<Project | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  /** 收起的项目 id（localStorage 轻量持久；默认展开 = 不在集合里） */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => readCollapsedProjects())
  const pinnedProjects = pinnedProjectIds ?? new Set<string>()
  /** round 64：整个「项目」组的收起状态（保留 id，与项目行的收起项共用一个集合） */
  const sectionCollapsed = collapsed.has(PROJECTS_FOLD_ID)

  // round 61：「任务」组与项目行共用同一份折叠存储——toggleCollapsed 先读后写，
  // 两边的收起项不会互相抹掉（各自的旧快照不能当底）。round 64 的「项目」组头走同一条路。
  const toggleProject = (projectId: string): void => {
    setCollapsed(toggleCollapsed(projectId))
  }

  const submitRename = (): void => {
    if (renameTarget === null) return
    const name = renameDraft.trim()
    if (name === '') return
    onRenameProject?.(renameTarget.id, name)
    setRenameTarget(null)
  }

  return (
    <div data-testid="project-section" className="flex flex-col gap-0.5 px-2 pt-2">
      {/* 组头（round 64）：与「任务」组同构——整行点开合 + 行首 chevron + aria-expanded；
          外观穿在行容器上（对齐项目行的口径：hover 底要盖住行尾那个图标按钮）。 */}
      <div
        data-testid="project-section-head"
        className={cn(
          navItemClass(),
          'group/section pe-1 text-[11px] font-medium text-ink-tertiary hover:text-ink-secondary'
        )}
      >
        <button
          type="button"
          data-testid="project-section-toggle"
          aria-expanded={!sectionCollapsed}
          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setCollapsed(toggleCollapsed(PROJECTS_FOLD_ID))}
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 text-ink-tertiary transition-transform duration-(--motion-fast) ease-main motion-reduce:transition-none',
              !sectionCollapsed && 'rotate-90'
            )}
          />
          <span data-testid="project-section-title" className="min-w-0 flex-1 truncate">
            项目
          </span>
        </button>
        {/* 行尾管理入口 = **图标按钮**（不是文字按钮）：hover/键盘聚焦出现；没有项目时常显
            （空态那行只是"使用现有文件夹"一条路，两条路都在这个菜单里） */}
        <div
          data-testid="project-section-manage"
          className={cn(
            'shrink-0 opacity-0 transition-opacity duration-(--motion-fast) group-hover/section:opacity-100 focus-within:opacity-100',
            projects.length === 0 && 'opacity-100'
          )}
        >
          <Menu
            align="end"
            tooltip="项目管理"
            trigger={
              <IconButton
                label="项目管理"
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
              },
              { id: 'sep-manage', type: 'separator' },
              {
                id: 'manage',
                label: '管理工作区',
                icon: <FolderOpen />,
                testId: 'project-manage-workspaces',
                disabled: onManageWorkspaces === undefined,
                onSelect: () => onManageWorkspaces?.()
              }
            ]}
          />
        </div>
      </div>

      {/* 组内容：与「任务」组同一套开合（.trace-fold 双向过渡，收起不卸载） */}
      <div
        data-testid="project-section-list"
        data-open={sectionCollapsed ? 'false' : 'true'}
        className="trace-fold"
      >
        <div className="trace-fold-in">
          <div className="flex flex-col gap-0.5">
            {/* 空态：没有项目时给一条**可点**的路（不是一行光秃秃的标题），创建两条路在组头菜单里 */}
            {projects.length === 0 ? (
              <button
                type="button"
                data-testid="project-empty"
                className={navItemClass()}
                onClick={onCreateFolder}
              >
                <span
                  aria-hidden="true"
                  className="size-(--icon-size-md) shrink-0 [&>svg]:size-full"
                >
                  <FolderPlus />
                </span>
                <span className="min-w-0 flex-1 truncate text-left">使用现有文件夹</span>
              </button>
            ) : null}

            {projects.map((project) => {
              const isCollapsed = collapsed.has(project.id)
              const sessions = sessionsOf(project.id)
              const isPinned = pinnedProjects.has(project.id)

              const menuItems: MenuEntry[] = [
                {
                  id: 'pin',
                  label: isPinned ? '取消置顶项目' : '置顶项目',
                  testId: `project-pin-${project.id}`,
                  disabled: onTogglePinProject === undefined,
                  onSelect: () => onTogglePinProject?.(project.id, !isPinned)
                },
                {
                  id: 'open-explorer',
                  label: '在文件资源管理器中打开',
                  testId: `project-open-${project.id}`,
                  disabled: onOpenProjectInExplorer === undefined,
                  onSelect: () => onOpenProjectInExplorer?.(project.id)
                },
                {
                  id: 'rename',
                  label: '重命名项目',
                  testId: `project-rename-${project.id}`,
                  disabled: onRenameProject === undefined,
                  onSelect: () => {
                    setRenameDraft(project.name)
                    setRenameTarget(project)
                  }
                },
                { id: 'sep-actions', type: 'separator' },
                {
                  id: 'archive',
                  label: '归档',
                  testId: `project-archive-${project.id}`,
                  disabled: onArchiveProject === undefined,
                  onSelect: () => onArchiveProject?.(project.id)
                },
                { id: 'sep-danger', type: 'separator' },
                {
                  id: 'delete',
                  label: '删除',
                  danger: true,
                  testId: `project-delete-${project.id}`,
                  onSelect: () => setDeleteTarget(project)
                }
              ]

              return (
                <div
                  key={project.id}
                  data-testid={`project-group-${project.id}`}
                  className="group/project flex flex-col gap-0.5"
                >
                  {/* 行 = **整行一个 hover 底**（round 27 用户口径：浅灰底要盖住行尾 ⋯ 与 ⊕；对齐
                SessionList 的行容器口径）——外观（高 36 / 圆角 / hover 底）穿在行容器上；
                折叠按钮退成纯布局按钮（flex-1 min-w-0；折叠行为、图标、testid 全不变）。 */}
                  <div
                    data-testid={`project-row-${project.id}`}
                    className={cn(navItemClass(), 'gap-1 pe-1')}
                  >
                    <button
                      type="button"
                      data-testid={`project-item-${project.id}`}
                      aria-expanded={!isCollapsed}
                      className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
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
                      {isPinned ? (
                        <Pin
                          aria-hidden="true"
                          data-testid={`project-pin-mark-${project.id}`}
                          className="size-3 shrink-0 text-ink-tertiary"
                        />
                      ) : null}
                      <Tooltip label={project.path} side="bottom" align="start">
                        <span className="min-w-0 flex-1 truncate text-left text-[11px] font-medium text-ink-tertiary">
                          {project.name}
                        </span>
                      </Tooltip>
                    </button>
                    {/* 行尾操作（hover/聚焦出现；round 27 起整行底已盖住这一块——按钮自身不铺底，
                  只做透明度变化，不会叠出第二层观感）：⋯ 菜单 + ⊕ 新建会话（round 25 图2） */}
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-(--motion-fast) group-hover/project:opacity-100 focus-within:opacity-100">
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
                        items={menuItems}
                      />
                      <IconButton
                        label={`在「${project.name}」里新建会话`}
                        data-testid={`project-new-session-${project.id}`}
                        icon={<MessageSquarePlus />}
                        className="size-7 border-transparent"
                        disabled={onCreateSession === undefined}
                        onClick={() => onCreateSession?.(project.id)}
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
                            emptyHint={false}
                            listClassName="min-h-0 overflow-visible pt-0"
                            onSelect={onSelectSession}
                            pinnedIds={pinnedIds}
                            runningIds={runningIds}
                            onActionError={onActionError}
                          />
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* 重命名项目：受控 Dialog（R12），输入框初始值为当前名称 */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
        title="重命名项目"
        footer={
          <>
            <Button
              variant="ghost"
              data-testid="project-rename-cancel"
              onClick={() => setRenameTarget(null)}
            >
              取消
            </Button>
            <Button
              data-testid="project-rename-save"
              disabled={renameDraft.trim() === ''}
              onClick={submitRename}
            >
              保存
            </Button>
          </>
        }
      >
        <Input
          data-testid="project-rename-input"
          aria-label="项目名称"
          value={renameDraft}
          autoFocus
          onChange={(event) => setRenameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            submitRename()
          }}
        />
      </Dialog>

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
