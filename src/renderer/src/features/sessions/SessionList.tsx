import { useNavigate } from 'react-router'
import { Ellipsis, Pin } from 'lucide-react'
import { IconButton } from '../../components/ui/icon-button'
import { cn } from '../../components/ui/cn'
import { navItemClass } from '../../components/shell/nav-item'
import { SessionActionsMenu } from './SessionActionsMenu'

/**
 * 会话列表（T9 接真实数据）：分组"今天 / 更早"、选中 Fills-F2、hover Fills-F1（§6.2 / 附录 A）。
 *
 * round 24：行尾 ⋯ 的菜单与重命名/删除对话框抽到 **SessionActionsMenu**（与对话页顶部栏共用
 * 同一份实现，动作走 useSessionActions → store）——本组件不再自带菜单/对话框逻辑，
 * 也不再收 onRename/onDelete/onTogglePin/… 一串回调（只把失败的一句 onActionError 传下去）。
 *
 * 交互：
 *   - 点会话 = 选中 + 切回对话页（当前页不在会话上时，点击要能回到对话）；
 *   - **整行一个 hover 底（round 20）**：hover/选中的填充挂在行容器上（标题 + ⋯ 同一圆角内）；
 *     ⋯ 仍是固定宽度占位（w-7 shrink-0，round 16 口径）——出现/消失不挪动文本；
 *   - 置顶的会话行带一个**图钉小标识**（不是文字），平铺区里单独提到时间分组之上（无分组标题）；
 *   - 草稿行（还没落成线程）**也给行尾 ⋯**（round 26：置顶/归档/移至项目先物化，重命名/删除
 *     就地做——不再"灰着不让用"）。
 */
export interface SessionListEntry {
  id: string
  title: string | null
  /** ISO 时间串（分组用） */
  updatedAt: string
  /** 草稿（新建了还没发过消息的本地会话 id）：同样有行尾菜单（round 26 起） */
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
  /** round 20：置顶的会话 id（行内图钉标识 + 平铺区提到时间分组之上） */
  pinnedIds?: ReadonlySet<string>
  /** 行内动作失败的一句话（重命名/归档/置顶…；露在侧栏的就地错误行） */
  onActionError?: (message: string) => void
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
  pinnedIds,
  onActionError
}: SessionListProps): React.JSX.Element {
  const navigate = useNavigate()
  const pinned = pinnedIds ?? new Set<string>()
  const groups = showGroups
    ? groupSessions(sessions, pinned)
    : [{ key: 'earlier' as const, label: '', sessions }]

  return (
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
                // round 20：hover/选中底挂在**整行**（标题 + ⋯ 同一圆角内；行间悬停隔离不变）
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
                  {/* hover / 键盘聚焦时出现的行尾操作（菜单无遮罩，菜单与重命名/删除对话框见
                      SessionActionsMenu——与对话页顶部栏共用同一份实现）。
                      round 26：**草稿也有这份菜单**（置顶/归档/移至项目先物化，重命名/删除就地执行），
                      不再"灰着不让用"；round 16：⋯ 用固定宽度占位（w-7 shrink-0）——出现/消失不挪动文本。 */}
                  <div className="w-7 shrink-0 opacity-0 transition-opacity duration-(--motion-fast) group-hover/row:opacity-100 focus-within:opacity-100">
                    <SessionActionsMenu
                      threadId={session.id}
                      title={session.title}
                      align="end"
                      onError={onActionError}
                      trigger={
                        <IconButton
                          label={`会话操作：${title}`}
                          data-testid={`session-more-${session.id}`}
                          icon={<Ellipsis />}
                          className="size-7 border-transparent"
                        />
                      }
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        </li>
      ))}
    </ul>
  )
}
