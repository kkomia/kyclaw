import type { KernelGoalProjection } from '@shared/kernel-ui'

/**
 * PB-018：goal 条（composer 上方，DSH `client-ui-goal:129` 数值照抄）。
 *
 * 数据**只读** main 的六行投影：phase/objective/rounds/可用命令全部来自
 * `KernelGoalProjection`（内核权威；flag 关时由 main 的旧 store 投影出同形数据）。
 * 组件不再自己解释 GoalView/activation —— 四动作是否出现看投影给的 `commands`。
 *
 * - 高 36px、radius 12、glass 背景；phase label 13/24/500，objective 13/20 次级省略；
 * - 右侧 28×28 圆钮（pause/resume/edit/clear），按投影命令集合显隐；
 * - complete / 无 goal → 不渲染（由调用方控制）。
 */
export interface GoalDockProps {
  projection: KernelGoalProjection
  onPause?: () => void
  onResume?: () => void
  onEdit?: () => void
  onClear?: () => void
}

function rowValue(projection: KernelGoalProjection, id: 'status' | 'objective'): string {
  return projection.rows.find((row) => row.id === id)?.value ?? ''
}

export function GoalDock({
  projection,
  onPause,
  onResume,
  onEdit,
  onClear
}: GoalDockProps): React.JSX.Element {
  const canPause = projection.commands.includes('goal pause')
  const canResume = projection.commands.includes('goal resume')
  const canEdit = onEdit !== undefined && projection.commands.includes('goal edit')
  const canClear = projection.commands.includes('goal clear')
  const rounds =
    projection.rounds?.label ?? projection.rows.find((row) => row.id === 'rounds')?.value
  return (
    <div
      data-testid="goal-dock"
      data-phase={projection.phase}
      className="flex h-9 shrink-0 items-center gap-[10px] rounded-[12px] border-(length:--hairline-width) border-hairline bg-menu py-1 pr-[5px] pl-3 shadow-(--shadow-overlay) backdrop-blur-(--blur-glass)"
    >
      <span aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary">
        ◎
      </span>
      <span className="shrink-0 text-[13px] leading-6 font-medium text-ink">
        {rowValue(projection, 'status')}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink-tertiary">
        {rowValue(projection, 'objective')}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-ink-tertiary">{rounds ?? ''}</span>
      {canPause ? (
        <button
          type="button"
          data-testid="goal-dock-pause"
          aria-label="暂停 goal"
          title="暂停 goal"
          onClick={onPause}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-hover hover:text-ink"
        >
          ‖
        </button>
      ) : null}
      {canResume ? (
        <button
          type="button"
          data-testid="goal-dock-resume"
          aria-label="恢复 goal"
          title="恢复 goal"
          onClick={onResume}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-hover hover:text-ink"
        >
          ▶
        </button>
      ) : null}
      {canEdit ? (
        <button
          type="button"
          data-testid="goal-dock-edit"
          aria-label="编辑 goal"
          title="编辑 goal"
          onClick={onEdit}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-hover hover:text-ink"
        >
          ✎
        </button>
      ) : null}
      {canClear ? (
        <button
          type="button"
          data-testid="goal-dock-clear"
          aria-label="清除 goal"
          title="清除 goal"
          onClick={onClear}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-ink-tertiary hover:bg-hover hover:text-ink"
        >
          ×
        </button>
      ) : null}
    </div>
  )
}
