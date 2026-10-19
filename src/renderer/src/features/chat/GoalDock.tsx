import type { GoalActivation, GoalView } from '@shared/goal'

/**
 * PB-039 goal 条（composer 上方，DSH `client-ui-goal:129` 数值照抄）。
 *
 * - 高 36px、radius 12、glass 背景；phase label 13/24/500，objective 13/20 次级省略；
 * - 右侧 28×28 圆钮（pause/resume/edit/clear）；complete / 无 goal → 不渲染（由调用方控制）；
 * - dock 顺序 审批/提问 > goal > 海獭；**goal 存在时隐藏海獭**（由父级布局决定，本组件只报存在性）。
 * - 纯展示组件：动作通过 props 交给上层（真接口在 ChatPage/上层接 `POST /api/goal`）。
 */
export interface GoalDockProps {
  goal: GoalView
  activation: GoalActivation
  onPause?: () => void
  onResume?: () => void
  onEdit?: () => void
  onClear?: () => void
}

const PHASE_LABEL: Record<GoalView['phase'], string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  complete: '已完成'
}

export function GoalDock({
  goal,
  activation,
  onPause,
  onResume,
  onEdit,
  onClear
}: GoalDockProps): React.JSX.Element {
  const canPause = goal.phase === 'active' && activation === 'armed'
  const canResume = goal.phase !== 'complete' && (goal.phase !== 'active' || activation !== 'armed')
  return (
    <div
      data-testid="goal-dock"
      data-phase={goal.phase}
      data-activation={activation}
      className="flex h-9 shrink-0 items-center gap-[10px] rounded-[12px] border-(length:--hairline-width) border-hairline bg-menu py-1 pr-[5px] pl-3 shadow-(--shadow-overlay) backdrop-blur-(--blur-glass)"
    >
      <span aria-hidden="true" className="size-3.5 shrink-0 text-ink-tertiary">
        ◎
      </span>
      <span className="shrink-0 text-[13px] leading-6 font-medium text-ink">
        {PHASE_LABEL[goal.phase]}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink-tertiary">
        {goal.objective}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-ink-tertiary">
        {goal.roundsStarted}/{goal.maxGoalRounds}
      </span>
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
      {onEdit === undefined ? null : (
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
      )}
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
    </div>
  )
}
