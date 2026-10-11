import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Ellipsis, Pin } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { cn } from '../../components/ui/cn'
import { Dialog } from '../../components/ui/dialog'
import { IconButton } from '../../components/ui/icon-button'
import { Input } from '../../components/ui/input'
import {
  Menu,
  type MenuActionItem,
  type MenuEntry,
  type MenuSeparatorItem
} from '../../components/ui/menu'
import { navItemClass } from '../../components/shell/nav-item'

/**
 * 会话列表（T9 接真实数据）：分组"今天 / 更早"、选中 Fills-F2、hover Fills-F1（§6.2 / 附录 A）。
 * 纯展示组件：数据与动作都由 SessionsController 给（不直接碰 store / 网络），方便单测。
 *
 * 交互：
 *   - 点会话 = 选中 + 切回对话页（当前页不在会话上时，点击要能回到对话）；
 *   - **整行一个 hover 底（round 20 用户实拍："hover 圆角阴影要把三点包括在内"）**：
 *     hover/选中的填充挂在行容器上（标题 + ⋯ 在同一圆角内），行内按钮自己不再画底；
 *     ⋯ 仍是固定宽度占位（w-7 shrink-0，round 16 口径）——出现/消失不挪动文本，行间悬停互不影响；
 *   - 行尾"更多"菜单（hover/聚焦出现，round 20 起按图2 扩充）：置顶 / 移至项目 ▸ /
 *     在文件资源管理器中打开 / 重命名 / 归档 / 删除（danger 最后）。「在新窗口打开」没做
 *     （单窗口架构，见 round 20 报告）；
 *   - 置顶的会话行带一个**图钉小标识**（不是文字），平铺区里单独提到时间分组之上（无分组标题）；
 *   - 重命名、删除各是一个**受控 Dialog**（R12）：删除必须二次确认；归档不删数据、不确认；
 *   - `notices[id]` = 该会话在后台完成了回复（人不在它上面）：行内一个小圆点。
 */
export interface SessionListEntry {
  id: string
  title: string | null
  /** ISO 时间串（分组用） */
  updatedAt: string
  /**
   * 草稿（新建了还没发过消息的本地会话 id）：服务端还没有它，
   * 重命名/删除都没有意义（删草稿 = 换一个会话），所以草稿行不给动作（含置顶/归档）。
   */
  draft?: boolean
}

export interface SessionListProps {
  sessions: SessionListEntry[]
  activeId: string | null
  notices?: Record<string, true>
  /**
   * 分组标题（今天/更早）：平铺区开着；项目名下的会话列表关掉（项目标题已经是分组，
   * 再来一层"今天"只会让缩进更深）。
   */
  showGroups?: boolean
  /** 空态那行"还没有会话"：项目名下不显示（项目标题下空着就是空着） */
  emptyHint?: boolean
  /** 列表容器的追加类（默认自带滚动；嵌进外层滚动容器时用 overflow-visible 覆写） */
  listClassName?: string
  onSelect: (threadId: string) => void
  onRename: (threadId: string, title: string) => void
  onDelete: (threadId: string) => void
  /** round 20：置顶的会话 id（行内图钉标识 + 平铺区提到时间分组之上） */
  pinnedIds?: ReadonlySet<string>
  /** round 20：「移至项目 ▸」的子菜单数据（id + 显示名） */
  projects?: ReadonlyArray<{ id: string; name: string }>
  /** round 20：会话当前的项目 id（子菜单勾选；没有 = null） */
  projectIdOf?: (threadId: string) => string | null
  /** round 20：这个会话能不能在文件资源管理器里打开（判不出唯一工作区 = false → 菜单项禁用） */
  canOpenExplorerOf?: (threadId: string) => boolean
  /** round 20：置顶/取消置顶（缺省 = 菜单项禁用） */
  onTogglePin?: (threadId: string, pinned: boolean) => void
  /** round 20：移至项目（projectId 为 null = 移出项目；缺省 = 子菜单禁用） */
  onMoveToProject?: (threadId: string, projectId: string | null) => void
  /** round 20：在文件资源管理器中打开会话工作区（缺省 = 菜单项禁用） */
  onOpenInExplorer?: (threadId: string) => void
  /** round 20：归档（从侧栏移除 + 快照；缺省 = 菜单项禁用） */
  onArchive?: (threadId: string) => void
}

/** 未命名会话在列表里的占位标题（服务端标题还没生成时） */
const UNTITLED = '新会话'

function isToday(iso: string, now = new Date()): boolean {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return false
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  )
}

interface SessionGroup {
  key: 'pinned' | 'today' | 'earlier'
  label: string
  sessions: SessionListEntry[]
}

/**
 * 平铺区的分组：置顶的单独一组在最上面（**无分组标题**，行内图钉就是标识），
 * 其余按今天/更早。置顶组里的相对顺序 = 传入顺序（composeSidebarSessions 已把置顶排前）。
 */
function groupSessions(
  sessions: SessionListEntry[],
  pinnedIds: ReadonlySet<string>
): SessionGroup[] {
  const pinned: SessionListEntry[] = []
  const today: SessionListEntry[] = []
  const earlier: SessionListEntry[] = []
  for (const session of sessions) {
    if (pinnedIds.has(session.id)) pinned.push(session)
    else (isToday(session.updatedAt) ? today : earlier).push(session)
  }
  return [
    { key: 'pinned', label: '', sessions: pinned },
    { key: 'today', label: '今天', sessions: today },
    { key: 'earlier', label: '更早', sessions: earlier }
  ].filter((group) => group.sessions.length > 0) as SessionGroup[]
}

const GROUP_TESTID: Record<SessionGroup['key'], string> = {
  pinned: 'session-group-pinned',
  today: 'session-group-today',
  earlier: 'session-group-earlier'
}

export function SessionList({
  sessions,
  activeId,
  notices = {},
  showGroups = true,
  emptyHint = true,
  listClassName,
  onSelect,
  onRename,
  onDelete,
  pinnedIds,
  projects = [],
  projectIdOf,
  canOpenExplorerOf,
  onTogglePin,
  onMoveToProject,
  onOpenInExplorer,
  onArchive
}: SessionListProps): React.JSX.Element {
  const navigate = useNavigate()
  const [renameTarget, setRenameTarget] = useState<SessionListEntry | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SessionListEntry | null>(null)

  const openRename = (session: SessionListEntry): void => {
    setRenameDraft(session.title ?? '')
    setRenameTarget(session)
  }

  const submitRename = (): void => {
    if (!renameTarget) return
    const title = renameDraft.trim()
    if (title === '') return
    onRename(renameTarget.id, title)
    setRenameTarget(null)
  }

  const pinned = pinnedIds ?? new Set<string>()
  const groups = showGroups
    ? groupSessions(sessions, pinned)
    : [{ key: 'earlier' as const, label: '', sessions }]

  /** 行尾 ⋯ 的条目（round 20，照图2 裁剪）：危险项最后、红色；嵌套只有「移至项目」一层 */
  const menuItemsFor = (session: SessionListEntry): MenuEntry[] => {
    const isPinned = pinned.has(session.id)
    const currentProject = projectIdOf?.(session.id) ?? null
    const canOpen = canOpenExplorerOf?.(session.id) ?? true
    const moveItems: Array<MenuActionItem | MenuSeparatorItem> = [
      ...projects.map((project) => ({
        id: `project:${project.id}`,
        label: project.name,
        testId: `session-move-${session.id}-${project.id}`,
        selected: currentProject === project.id,
        onSelect: () => onMoveToProject?.(session.id, project.id)
      })),
      ...(projects.length > 0 ? [{ id: 'sep', type: 'separator' as const }] : []),
      {
        id: 'none',
        label: '无项目',
        testId: `session-move-none-${session.id}`,
        selected: currentProject === null,
        onSelect: () => onMoveToProject?.(session.id, null)
      }
    ]
    return [
      {
        id: 'pin',
        label: isPinned ? '取消置顶' : '置顶',
        testId: `session-pin-${session.id}`,
        disabled: onTogglePin === undefined,
        onSelect: () => onTogglePin?.(session.id, !isPinned)
      },
      {
        id: 'move',
        type: 'submenu',
        label: '移至项目',
        testId: `session-move-${session.id}`,
        disabled: onMoveToProject === undefined,
        items: moveItems
      },
      {
        id: 'open-explorer',
        label: '在文件资源管理器中打开',
        testId: `session-open-${session.id}`,
        disabled: !canOpen || onOpenInExplorer === undefined,
        onSelect: () => onOpenInExplorer?.(session.id)
      },
      { id: 'sep-actions', type: 'separator' },
      {
        id: 'rename',
        label: '重命名',
        testId: `session-rename-${session.id}`,
        onSelect: () => openRename(session)
      },
      {
        id: 'archive',
        label: '归档',
        testId: `session-archive-${session.id}`,
        disabled: onArchive === undefined,
        onSelect: () => onArchive?.(session.id)
      },
      { id: 'sep-danger', type: 'separator' },
      {
        id: 'delete',
        label: '删除',
        danger: true,
        testId: `session-delete-${session.id}`,
        onSelect: () => setDeleteTarget(session)
      }
    ]
  }

  return (
    <>
      <ul
        data-testid="session-list"
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2',
          listClassName
        )}
      >
        {emptyHint && sessions.length === 0 ? (
          <li data-testid="session-list-empty" className="px-2 py-1 text-c1 text-ink-tertiary">
            还没有会话
          </li>
        ) : null}
        {groups.map((group) => (
          <li key={group.key} data-testid={showGroups ? GROUP_TESTID[group.key] : undefined}>
            {group.label === '' ? null : (
              <p className="px-2 pt-2 pb-1 text-c2 text-ink-tertiary">{group.label}</p>
            )}
            <ul className="flex flex-col gap-0.5">
              {group.sessions.map((session) => {
                const selected = session.id === activeId
                const title = session.title ?? UNTITLED
                const isPinned = pinned.has(session.id)

                return (
                  // round 20：hover/选中底挂在**整行**（标题 + ⋯ 同一圆角内；round 16 的
                  // 行间悬停隔离不变——底只在该行自己的容器上）。右内边距收紧到 pr-1，
                  // 让 ⋯ 贴边但不出圆角；hover 灰底由 navItemClass 给。
                  <li
                    key={session.id}
                    data-testid={`session-row-${session.id}`}
                    className={cn(navItemClass({ selected }), 'group/row gap-0.5 pe-1 ps-0')}
                  >
                    <button
                      type="button"
                      data-testid={`session-item-${session.id}`}
                      aria-current={selected ? 'true' : undefined}
                      className="flex h-full min-w-0 flex-1 items-center gap-2 ps-2 text-left"
                      onClick={() => {
                        onSelect(session.id)
                        navigate('/chat')
                      }}
                    >
                      {isPinned ? (
                        <Pin
                          aria-hidden="true"
                          data-testid={`session-pin-mark-${session.id}`}
                          className="size-3 shrink-0 text-ink-tertiary"
                        />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-left">{title}</span>
                      {notices[session.id] ? (
                        <span
                          data-testid={`session-done-${session.id}`}
                          title="新回复已完成"
                          aria-label="新回复已完成"
                          className="size-1.5 shrink-0 rounded-full bg-(--accent-text)"
                        />
                      ) : null}
                    </button>
                    {/* hover / 键盘聚焦时出现的行尾操作（菜单无遮罩，样式见 Menu）；草稿没有。
                        round 16：⋯ 用固定宽度占位（w-7 shrink-0）——出现/消失不挪动文本。 */}
                    {session.draft === true ? null : (
                      <div className="w-7 shrink-0 opacity-0 transition-opacity duration-(--motion-fast) group-hover/row:opacity-100 focus-within:opacity-100">
                        <Menu
                          align="end"
                          trigger={
                            <IconButton
                              label={`会话操作：${title}`}
                              data-testid={`session-more-${session.id}`}
                              icon={<Ellipsis />}
                              className="size-7 border-transparent"
                            />
                          }
                          items={menuItemsFor(session)}
                        />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </li>
        ))}
      </ul>

      {/* 重命名：受控 Dialog（R12），输入框初始值为当前标题 */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null)
        }}
        title="重命名会话"
        footer={
          <>
            <Button
              variant="ghost"
              data-testid="session-rename-cancel"
              onClick={() => setRenameTarget(null)}
            >
              取消
            </Button>
            <Button
              data-testid="session-rename-save"
              disabled={renameDraft.trim() === ''}
              onClick={submitRename}
            >
              保存
            </Button>
          </>
        }
      >
        <Input
          data-testid="session-rename-input"
          aria-label="会话标题"
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

      {/* 删除：受控 Dialog，二次确认（R12） */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title="删除会话？"
        description={
          deleteTarget
            ? `「${deleteTarget.title ?? UNTITLED}」及其全部消息会被删除，无法撤销。`
            : ''
        }
        footer={
          <>
            <Button
              variant="ghost"
              data-testid="session-delete-cancel"
              onClick={() => setDeleteTarget(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              data-testid="session-delete-confirm"
              onClick={() => {
                if (deleteTarget) onDelete(deleteTarget.id)
                setDeleteTarget(null)
              }}
            >
              删除
            </Button>
          </>
        }
      />
    </>
  )
}
