import { useEffect, useId, useState } from 'react'
import { useStore } from 'zustand'
import { ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Textarea } from '@renderer/components/ui/input'
import { Menu, type MenuEntry } from '@renderer/components/ui/menu'
import {
  tasksStore,
  taskSession,
  EMPTY_TASK_SESSION,
  type TaskSessionState,
  type TasksStore
} from '@renderer/lib/tasks-store'
import type { TaskItem, TaskStatus } from '@shared/tasks'
import { TASK_STATUS_LABELS, taskProgress } from './task-history'

export interface TaskListPanelProps {
  state: TaskSessionState
  onRefresh: () => void
  onCollapsedChange: (collapsed: boolean) => void
  onStatusChange: (id: string, status: TaskStatus, note?: string) => void
  onClear: () => void
}

function TaskRow({
  item,
  busy,
  hasOtherInProgress,
  onStatusChange
}: {
  item: TaskItem
  busy: boolean
  hasOtherInProgress: boolean
  onStatusChange: TaskListPanelProps['onStatusChange']
}): React.JSX.Element {
  const id = useId()
  const [editingReason, setEditingReason] = useState(false)
  const [reason, setReason] = useState(item.note ?? '')
  const [error, setError] = useState<string | null>(null)
  const statusEntries: MenuEntry[] = (Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map(
    (status) => ({
      id: status,
      label: TASK_STATUS_LABELS[status],
      selected: item.status === status,
      disabled: busy || (status === 'in_progress' && hasOtherInProgress),
      onSelect: () => {
        if (busy) return
        setError(null)
        if (status === 'blocked') {
          setReason(item.note ?? '')
          setEditingReason(true)
          return
        }
        setEditingReason(false)
        onStatusChange(item.id, status)
      }
    })
  )
  return (
    <li className="min-w-0 space-y-1 rounded-control px-2 py-1 focus-within:bg-hover">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="whitespace-pre-wrap text-b2 text-ink [overflow-wrap:anywhere]">
            {item.title}
          </p>
          {item.note ? (
            <p className="whitespace-pre-wrap text-c1 text-ink-secondary [overflow-wrap:anywhere]">
              {item.note}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {item.status === 'blocked' && !editingReason ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setEditingReason(true)}
            >
              修改原因
            </Button>
          ) : null}
          <Menu
            trigger={
              <button
                type="button"
                aria-label={`任务状态：${item.title}`}
                disabled={busy}
                className={cn(
                  'inline-flex h-(--control-height-sm) max-w-40 shrink-0 items-center gap-1 rounded-control px-2 text-c1 transition-colors duration-(--motion-fast) ease-main hover:bg-hover data-[state=open]:bg-hover disabled:cursor-not-allowed disabled:text-(--text-disabled) motion-reduce:transition-none',
                  item.status === 'blocked'
                    ? 'text-warning'
                    : 'text-ink-secondary hover:text-ink data-[state=open]:text-ink'
                )}
              >
                <span className="truncate">{TASK_STATUS_LABELS[item.status]}</span>
                <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
              </button>
            }
            items={statusEntries}
            align="end"
          />
        </div>
      </div>
      {editingReason ? (
        <form
          aria-label={`阻塞原因：${item.title}`}
          onSubmit={(event) => {
            event.preventDefault()
            if (busy) return
            if (!reason.trim()) {
              setError('请填写阻塞原因')
              return
            }
            if (reason.length > 1000) {
              setError('原因不能超过 1000 字')
              return
            }
            onStatusChange(item.id, 'blocked', reason.trim())
          }}
          className="min-w-0 space-y-2"
        >
          <label htmlFor={id} className="text-c1 text-ink-secondary">
            阻塞原因（必填，最多 1000 字）
          </label>
          <Textarea
            id={id}
            value={reason}
            disabled={busy}
            maxLength={1000}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => {
              setReason(event.target.value)
              setError(null)
            }}
            className="min-w-0 w-full"
          />
          {error ? (
            <p id={`${id}-error`} role="alert" className="text-c1 text-warning">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              保存阻塞原因
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditingReason(false)
                setError(null)
              }}
            >
              取消
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  )
}

export function TaskListPanel({
  state,
  onRefresh,
  onCollapsedChange,
  onStatusChange,
  onClear
}: TaskListPanelProps): React.JSX.Element {
  const id = useId()
  const [confirmClear, setConfirmClear] = useState(false)
  const { snapshot, loading, saving, error, conflict, collapsed } = state
  const progress = taskProgress(snapshot)
  const busy = loading || saving
  /** 当前进行项（摘要里要露它，round 81：「任务摘要显示完成数/总数和当前进行项」） */
  const currentItem = snapshot?.items.find((item) => item.status === 'in_progress') ?? null
  return (
    <section
      aria-label="会话任务清单"
      aria-busy={busy || undefined}
      data-testid="task-list-dock"
      data-collapsed={collapsed ? 'true' : 'false'}
      className="mx-auto flex max-h-[min(32vh,20rem)] w-full min-w-0 max-w-(--chat-input-max-width) flex-col overflow-hidden rounded-panel border-(length:--hairline-width) border-surface-border bg-secondary [overflow-wrap:anywhere]"
    >
      {/* 摘要行本身就是展开/收起的把手（round 81：默认收起，点一下看详情、再点收起）——
          不复用「展开任务/折叠任务」那枚单独按钮：摘要与把手是同一个目标，不必点两次。
          「刷新任务」是另一件事，留在摘要行右边（同层兄弟，不嵌进摘要按钮里）。 */}
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <button
          type="button"
          data-testid="task-dock-toggle"
          aria-expanded={!collapsed}
          onClick={() => onCollapsedChange(!collapsed)}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-control px-1 py-1 text-left transition-colors duration-(--motion-fast) ease-main hover:bg-hover motion-reduce:transition-none"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 text-ink-tertiary transition-transform duration-(--motion-fast) ease-main motion-reduce:transition-none',
              collapsed && '-rotate-90'
            )}
          />
          <span className="font-medium text-b2 text-ink">任务清单</span>
          <span className="text-b2 text-ink">
            {progress.done}/{progress.total} 已完成
          </span>
          {progress.allDone ? <span className="text-c1 text-ink-secondary">全部完成</span> : null}
          {progress.inProgress ? (
            <span className="text-c1 text-ink-secondary">{progress.inProgress} 项进行中</span>
          ) : null}
          {progress.blocked ? (
            <span className="text-c1 text-warning">{progress.blocked} 项阻塞</span>
          ) : null}
          {currentItem ? (
            <span className="min-w-0 max-w-full truncate text-c1 text-ink-secondary">
              当前：{currentItem.title}
            </span>
          ) : null}
        </button>
        <Button variant="ghost" size="sm" className="shrink-0" disabled={busy} onClick={onRefresh}>
          刷新任务
        </Button>
      </div>
      {loading ? (
        <p role="status" className="shrink-0 px-3 pb-1 text-c1 text-ink-secondary">
          正在加载任务…
        </p>
      ) : null}
      {saving ? (
        <p role="status" className="shrink-0 px-3 pb-1 text-c1 text-ink-secondary">
          正在保存任务…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="shrink-0 whitespace-pre-wrap px-3 pb-1 text-c1 text-warning">
          {error}
        </p>
      ) : null}
      {conflict ? (
        <p role="alert" className="shrink-0 whitespace-pre-wrap px-3 pb-1 text-c1 text-warning">
          {conflict}
        </p>
      ) : null}
      {!collapsed ? (
        <div id={id} className="flex min-h-0 min-w-0 flex-col">
          {snapshot === null && !loading ? (
            <p className="px-3 pb-2 text-b2 text-ink-secondary">任务尚未加载，请刷新。</p>
          ) : null}
          {snapshot !== null && progress.total === 0 ? (
            <p className="px-3 pb-2 text-b2 text-ink-secondary">暂无任务</p>
          ) : null}
          {progress.total > 0 ? (
            <>
              <ul
                tabIndex={0}
                aria-label="任务列表"
                className="min-h-0 min-w-0 flex-1 space-y-1 overflow-y-auto overscroll-contain px-3 pb-2"
              >
                {snapshot?.items.map((item) => (
                  <TaskRow
                    key={`${item.id}:${item.updatedAt}:${snapshot.revision}`}
                    item={item}
                    busy={busy}
                    hasOtherInProgress={Boolean(
                      snapshot.items.some(
                        (other) => other.id !== item.id && other.status === 'in_progress'
                      )
                    )}
                    onStatusChange={onStatusChange}
                  />
                ))}
              </ul>
              <div className="shrink-0 border-t border-surface-border px-3 py-2">
                {confirmClear ? (
                  <div className="space-y-1">
                    <p className="text-c1 text-ink-secondary">
                      确定清空本会话的全部任务？这会移除清单，不会将未完成项标记为完成。
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setConfirmClear(false)
                          onClear()
                        }}
                      >
                        确认清空任务
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setConfirmClear(false)}
                      >
                        取消清空
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmClear(true)}
                  >
                    清空任务清单
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

export interface TaskListDockProps {
  threadId: string | null
  store?: TasksStore
}

export function TaskListDock({
  threadId,
  store = tasksStore
}: TaskListDockProps): React.JSX.Element | null {
  const state = useStore(store, (value) =>
    threadId === null ? EMPTY_TASK_SESSION : taskSession(value, threadId)
  )
  useEffect(() => {
    if (threadId !== null) void store.getState().load(threadId)
  }, [threadId, store])
  if (threadId === null) return null
  return (
    <TaskListPanel
      key={JSON.stringify([threadId, state.snapshot?.revision ?? null])}
      state={state}
      onRefresh={() => {
        void store.getState().load(threadId)
      }}
      onCollapsedChange={(collapsed) => store.getState().setCollapsed(threadId, collapsed)}
      onStatusChange={(id, status, note) => {
        void store.getState().setStatus(threadId, id, status, note)
      }}
      onClear={() => {
        void store.getState().clear(threadId)
      }}
    />
  )
}
