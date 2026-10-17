import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '../../components/ui/cn'
import { navItemClass } from '../../components/shell/nav-item'
import { readCollapsedProjects, TASKS_FOLD_ID, toggleCollapsed } from '../projects/project-fold'
import { SessionList, type SessionListEntry } from './SessionList'

/**
 * 侧栏「任务」组（round 61）：**没有项目**的会话（含草稿）都归到这里——对齐 Kimi 侧栏
 * 「项目」区之后的那个分区头（纯文字 + chevron，无图标）。
 *
 * 形态（对齐项目行的折叠范式，见 ProjectList）：
 *   - 组头一行 = `navItemClass` 行 + 行首 `ChevronRight`（展开转 90°）+ `aria-expanded`，
 *     **点整行开合**；没有行尾 ⋯ / ⊕（这一组没有"对组本身"的动作）；
 *   - 内容 = SessionList 平铺（`emptyHint={false}`，顺序沿用 composeSidebarSessions 的
 *     ungrouped：草稿最前 → 置顶 → 其余），嵌在 `.trace-fold` 里开合（不硬切）；
 *   - 折叠状态与项目折叠**同一份存储**（project-fold；保留 id `TASKS_FOLD_ID`），重启后保持。
 *
 * 空态：没有无项目会话时**整组不渲染**（组头也不留）。
 * 纯展示：数据与选中回调都由 SessionsController 给（方便单测）。
 */
export interface TasksGroupProps {
  /** 没有项目的会话（含草稿），顺序即渲染顺序 */
  sessions: SessionListEntry[]
  activeId: string | null
  notices?: Record<string, true>
  /** round 20：置顶会话的行内图钉标识（透传给 SessionList） */
  pinnedIds?: ReadonlySet<string>
  /** 010：在跑的会话 id（透传给 SessionList → 行尾灰圈） */
  runningIds?: ReadonlySet<string>
  onSelect: (threadId: string) => void
  /** 行内动作失败的一句话（重命名/归档/置顶…） */
  onActionError?: (message: string) => void
}

export function TasksGroup({
  sessions,
  activeId,
  notices,
  pinnedIds,
  runningIds,
  onSelect,
  onActionError
}: TasksGroupProps): React.JSX.Element | null {
  /** 收起状态（localStorage 轻量持久；默认展开 = 不在集合里） */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => readCollapsedProjects())
  const isCollapsed = collapsed.has(TASKS_FOLD_ID)

  // 空态：整组不渲染（含组头）——"项目区之后什么都没有"比一个空组头诚实
  if (sessions.length === 0) return null

  return (
    <div data-testid="session-group-tasks" className="flex flex-col gap-0.5 px-2 pt-2">
      <button
        type="button"
        data-testid="tasks-item"
        aria-expanded={!isCollapsed}
        className={cn(
          navItemClass(),
          'text-left text-[11px] font-medium text-ink-tertiary hover:text-ink-secondary'
        )}
        onClick={() => setCollapsed(toggleCollapsed(TASKS_FOLD_ID))}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-ink-tertiary transition-transform duration-(--motion-fast) ease-main motion-reduce:transition-none',
            !isCollapsed && 'rotate-90'
          )}
        />
        <span className="min-w-0 flex-1 truncate">任务</span>
      </button>

      <div
        data-testid="tasks-sessions"
        data-open={isCollapsed ? 'false' : 'true'}
        className="trace-fold"
      >
        <div className="trace-fold-in">
          {/* px-0：外层组已经有 px-2 的缩进（与项目行对齐），列表不再叠一层 */}
          <SessionList
            sessions={sessions}
            activeId={activeId}
            notices={notices}
            emptyHint={false}
            listClassName="min-h-0 overflow-visible px-0 pt-0"
            onSelect={onSelect}
            pinnedIds={pinnedIds}
            runningIds={runningIds}
            onActionError={onActionError}
          />
        </div>
      </div>
    </div>
  )
}
