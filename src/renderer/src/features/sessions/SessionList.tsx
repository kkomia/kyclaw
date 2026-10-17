import { useNavigate } from 'react-router'
import { Archive, Ellipsis, Pin } from 'lucide-react'
import { IconButton } from '../../components/ui/icon-button'
import { Spinner } from '../../components/ui/spinner'
import { cn } from '../../components/ui/cn'
import { navItemClass } from '../../components/shell/nav-item'
import { SessionActionsMenu } from './SessionActionsMenu'
import { useSessionActions } from './useSessionActions'
import { relativeSessionTime } from './session-time'

/**
 * 会话列表（T9 接真实数据；task-66 按 DSH claude-style 侧栏重设计行样式）：
 *
 * 行结构（一行一条，顺序由外层 composeSidebarSessions 给）：
 *   - **行首 8px 状态圆孔**：选中 = `--text-primary` 实心 + 整行 `bg-selected`；未选中 = `--text-tertiary`
 *     空心环；**在跑**换现有 Spinner（灰环）；**未读**用 accent 实心点 ——
 *     优先级 **运行 > 未读 > 选中/普通**（原有语义保持）。
 *   - 标题 b2 14 单行省略；草稿同样一行（title 可能为 null → 「新会话」占位）。
 *   - 行尾：置顶小图钉 + **相对时间**（c1 12、三级灰、tabular-nums）；hover / focus-within 时
 *     时间淡出、同一固定宽度槽内换成三枚 24px 动作（不挪标题、不抖）：⋯ 菜单 / 归档 / 置顶。
 *   - 行高 `--nav-item-height`（36）；hover 底挂整行（含行尾动作，圆角一体）。
 *
 * 动作口径复用 `useSessionActions`（与 SessionActionsMenu / 对话页顶栏同一份实现：
 * 置顶走 settings.pinnedThreads、归档写快照并让位选中；失败经 onActionError 露侧栏就地错误行）。
 * ⋯ 仍是 `SessionActionsMenu`（菜单本体与重命名/删除对话框不变）；分叉会话 / 复制 Session ID
 * 目前没有对应能力，**不做**（不造假入口）。
 *
 * 草稿行（还没落成线程）也给行尾动作（round 26 起口径：置顶/归档/移至项目先物化，重命名/删除就地做）。
 */
export interface SessionListEntry {
  id: string
  title: string | null
  /** ISO 时间串（排序用；行尾显示相对时间） */
  updatedAt: string
  /** 草稿（新建了还没发过消息的本地会话 id）：同样有行尾菜单（round 26 起） */
  draft?: boolean
}

export interface SessionListProps {
  sessions: SessionListEntry[]
  activeId: string | null
  notices?: Record<string, true>
  /** 空态那行"还没有会话"：分组里不显示（组里空着就是空着；「任务」组为空时整组不渲染） */
  emptyHint?: boolean
  /** 列表容器的追加类（默认自带滚动；嵌进外层滚动容器时用 overflow-visible 覆写） */
  listClassName?: string
  onSelect: (threadId: string) => void
  /** round 20：置顶的会话 id（行内图钉标识；"排最前"由 composeSidebarSessions 给） */
  pinnedIds?: ReadonlySet<string>
  /**
   * 010：正在跑（提交中 / 流式中）的会话 id —— 行首状态槽画**灰色圆环**（Spinner；
   * 运行优先于未读/选中）。数据源 = thread-run-store，由两个分组透传。
   */
  runningIds?: ReadonlySet<string>
  /** 行内动作失败的一句话（重命名/归档/置顶…；露在侧栏的就地错误行） */
  onActionError?: (message: string) => void
}

/** 未命名会话在列表里的占位标题（服务端标题还没生成时） */
const UNTITLED = '新会话'

/** 行尾三枚动作（hover/focus-within 出现；固定槽位，不挪标题） */
function SessionRowActions({
  threadId,
  title,
  pinned,
  onActionError
}: {
  threadId: string
  title: string | null
  pinned: boolean
  onActionError?: (message: string) => void
}): React.JSX.Element {
  // 与 ⋯ 菜单共用同一份动作接线（useSessionActions）；错误统一走 onActionError
  const { togglePin, archive } = useSessionActions({ threadId, title, onError: onActionError })
  const label = title ?? UNTITLED

  return (
    <div
      data-testid={`session-actions-${threadId}`}
      className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 transition-opacity duration-(--motion-fast) group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100"
    >
      <SessionActionsMenu
        threadId={threadId}
        title={title}
        align="end"
        onError={onActionError}
        trigger={
          <IconButton
            label={`会话操作：${label}`}
            data-testid={`session-more-${threadId}`}
            icon={<Ellipsis />}
            className="size-6 border-transparent"
          />
        }
      />
      <IconButton
        label={`归档会话：${label}`}
        data-testid={`session-quick-archive-${threadId}`}
        icon={<Archive />}
        className="size-6 border-transparent"
        onClick={() => archive()}
      />
      <IconButton
        label={pinned ? `取消置顶：${label}` : `置顶会话：${label}`}
        data-testid={`session-quick-pin-${threadId}`}
        icon={<Pin />}
        className="size-6 border-transparent"
        onClick={() => togglePin(!pinned)}
      />
    </div>
  )
}

/** 行首状态槽：运行 > 未读 > 选中（实心）/普通（空心环） */
function SessionRowStatus({
  threadId,
  running,
  unread,
  selected
}: {
  threadId: string
  running: boolean
  unread: boolean
  selected: boolean
}): React.JSX.Element {
  if (running) {
    return (
      <Spinner
        size="sm"
        label="正在生成回复"
        data-testid={`session-running-${threadId}`}
        className="text-ink-tertiary motion-reduce:animate-none"
      />
    )
  }
  if (unread) {
    return (
      <span
        data-testid={`session-done-${threadId}`}
        data-state="unread"
        title="新回复已完成"
        aria-label="新回复已完成"
        className="size-2 shrink-0 rounded-full bg-(--accent-text)"
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      data-testid={`session-dot-${threadId}`}
      data-state={selected ? 'selected' : 'idle'}
      className={cn(
        'size-2 shrink-0 rounded-full border',
        selected
          ? 'border-(--text-primary) bg-(--text-primary)'
          : 'border-(--text-tertiary) bg-transparent'
      )}
    />
  )
}

/** 一行会话：点标题选中并切回对话页；行尾时间/动作与行首状态点见文件头 */
function SessionRow({
  session,
  activeId,
  notices,
  pinnedIds,
  runningIds,
  onSelect,
  onActionError
}: {
  session: SessionListEntry
  activeId: string | null
  notices: Record<string, true>
  pinnedIds: ReadonlySet<string>
  runningIds: ReadonlySet<string>
  onSelect: (threadId: string) => void
  onActionError?: (message: string) => void
}): React.JSX.Element {
  const navigate = useNavigate()
  const selected = session.id === activeId
  const title = session.title ?? UNTITLED
  const isPinned = pinnedIds.has(session.id)
  const isRunning = runningIds.has(session.id)
  const unread = notices[session.id] === true
  const time = relativeSessionTime(session.updatedAt)

  return (
    // hover/选中底挂**整行**（标题 + 行尾时间/动作同一圆角内）
    <li
      data-testid={`session-row-${session.id}`}
      className={cn(navItemClass({ selected }), 'group/row gap-1 pe-1 ps-0')}
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
        <SessionRowStatus
          threadId={session.id}
          running={isRunning}
          unread={unread}
          selected={selected}
        />
        <span
          data-testid={`session-title-${session.id}`}
          className="min-w-0 flex-1 truncate text-left text-b2 text-ink"
        >
          {title}
        </span>
      </button>

      {/* 行尾固定槽：默认显示图钉 + 相对时间；hover/focus 时时间淡出、叠上三枚动作。
          min-w 固定 = 三枚 24px 动作的宽度 —— 出现/消失不挪标题、不抖动。 */}
      <span
        data-testid={`session-tail-${session.id}`}
        className="relative flex h-full min-w-[76px] shrink-0 items-center justify-end gap-1 pe-0.5"
      >
        {isPinned ? (
          <Pin
            aria-hidden="true"
            data-testid={`session-pin-mark-${session.id}`}
            className="size-(--icon-size-xs) shrink-0 text-ink-tertiary"
          />
        ) : null}
        {time === '' ? null : (
          <span
            data-testid={`session-time-${session.id}`}
            className="text-c1 text-ink-tertiary tabular-nums transition-opacity duration-(--motion-fast) group-hover/row:opacity-0 group-focus-within/row:opacity-0"
          >
            {time}
          </span>
        )}
        <SessionRowActions
          threadId={session.id}
          title={session.title}
          pinned={isPinned}
          onActionError={onActionError}
        />
      </span>
    </li>
  )
}

export function SessionList({
  sessions,
  activeId,
  notices = {},
  emptyHint = true,
  listClassName,
  onSelect,
  pinnedIds,
  runningIds,
  onActionError
}: SessionListProps): React.JSX.Element {
  const pinned = pinnedIds ?? new Set<string>()
  const running = runningIds ?? new Set<string>()

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
      {sessions.map((session) => (
        <SessionRow
          key={session.id}
          session={session}
          activeId={activeId}
          notices={notices}
          pinnedIds={pinned}
          runningIds={running}
          onSelect={onSelect}
          onActionError={onActionError}
        />
      ))}
    </ul>
  )
}
