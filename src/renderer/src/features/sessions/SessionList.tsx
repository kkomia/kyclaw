import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Ellipsis } from 'lucide-react'
import { Button } from '../../components/ui/button'
import { Dialog } from '../../components/ui/dialog'
import { IconButton } from '../../components/ui/icon-button'
import { Input } from '../../components/ui/input'
import { Menu } from '../../components/ui/menu'
import { navItemClass } from '../../components/shell/nav-item'

/**
 * 会话列表（T9 接真实数据）：分组"今天 / 更早"、选中 Fills-F2、hover Fills-F1（§6.2 / 附录 A）。
 * 纯展示组件：数据与动作都由 SessionsController 给（不直接碰 store / 网络），方便单测。
 *
 * 交互：
 *   - 点会话 = 选中 + 切回对话页（当前页不在会话上时，点击要能回到对话）；
 *   - 行尾"更多"菜单（hover/聚焦出现）：重命名 / 删除；
 *   - 重命名与删除各是一个**受控 Dialog**（R12）：删除必须二次确认；重命名给输入框；
 *   - `notices[id]` = 该会话在后台完成了回复（人不在它上面）：行内一个小圆点。
 */
export interface SessionListEntry {
  id: string
  title: string | null
  /** ISO 时间串（分组用） */
  updatedAt: string
  /**
   * 草稿（新建了还没发过消息的本地会话 id）：服务端还没有它，
   * 重命名/删除都没有意义（删草稿 = 换一个会话），所以草稿行不给这两个动作。
   */
  draft?: boolean
}

export interface SessionListProps {
  sessions: SessionListEntry[]
  activeId: string | null
  notices?: Record<string, true>
  onSelect: (threadId: string) => void
  onRename: (threadId: string, title: string) => void
  onDelete: (threadId: string) => void
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
  key: 'today' | 'earlier'
  label: string
  sessions: SessionListEntry[]
}

function groupSessions(sessions: SessionListEntry[]): SessionGroup[] {
  const today: SessionListEntry[] = []
  const earlier: SessionListEntry[] = []
  for (const session of sessions) {
    ;(isToday(session.updatedAt) ? today : earlier).push(session)
  }
  return [
    { key: 'today', label: '今天', sessions: today },
    { key: 'earlier', label: '更早', sessions: earlier }
  ].filter((group) => group.sessions.length > 0) as SessionGroup[]
}

const GROUP_TESTID: Record<SessionGroup['key'], string> = {
  today: 'session-group-today',
  earlier: 'session-group-earlier'
}

export function SessionList({
  sessions,
  activeId,
  notices = {},
  onSelect,
  onRename,
  onDelete
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

  const groups = groupSessions(sessions)

  return (
    <>
      <ul
        data-testid="session-list"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
      >
        {sessions.length === 0 ? (
          <li data-testid="session-list-empty" className="px-2 py-1 text-c1 text-ink-tertiary">
            还没有会话
          </li>
        ) : null}
        {groups.map((group) => (
          <li key={group.key} data-testid={GROUP_TESTID[group.key]}>
            <p className="px-2 pt-2 pb-1 text-c2 text-ink-tertiary">{group.label}</p>
            <ul className="flex flex-col gap-0.5">
              {group.sessions.map((session) => {
                const selected = session.id === activeId
                const title = session.title ?? UNTITLED

                return (
                  <li key={session.id} className="group/row relative flex items-center">
                    <button
                      type="button"
                      data-testid={`session-item-${session.id}`}
                      aria-current={selected ? 'true' : undefined}
                      className={navItemClass({ selected })}
                      onClick={() => {
                        onSelect(session.id)
                        navigate('/chat')
                      }}
                    >
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
                    {/* hover / 键盘聚焦时出现的行尾操作（菜单无遮罩，样式见 Menu）；草稿没有 */}
                    {session.draft === true ? null : (
                      <div className="absolute right-1 opacity-0 transition-opacity duration-(--motion-fast) group-hover/row:opacity-100 focus-within:opacity-100">
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
                          items={[
                            {
                              id: 'rename',
                              label: '重命名',
                              testId: `session-rename-${session.id}`,
                              onSelect: () => openRename(session)
                            },
                            {
                              id: 'delete',
                              label: '删除',
                              danger: true,
                              testId: `session-delete-${session.id}`,
                              onSelect: () => setDeleteTarget(session)
                            }
                          ]}
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
