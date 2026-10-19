import type { GoalActivation, GoalView } from '@shared/goal'

/**
 * PB-039 `/goal` 命令结果卡片（V1：不进历史，只挂在命令结果区）。
 *
 * 六行结构照 DSH `command-goal/lib/index.js:59-77`：
 *   Status / Blocker / Objective / Rounds: n/max / Activation / Commands: <当前可用>
 * 无 goal 时显示契约原文（`No goal is currently set; /goal <action> requires one.`），
 * 不放假按钮、不造数据。
 */
export interface GoalCommandCardProps {
  goal: GoalView | null
  activation: GoalActivation
  /** 本次命令的错误（领域错误的中文 message；不渲染原始 id/revision） */
  error?: string
  onClose?: () => void
}

const PHASE_LABEL: Record<GoalView['phase'], string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  complete: '已完成'
}

/** 当前可用命令（与 phase/activation 对应；照 DSH 的下一步提示口径） */
function commandsOf(goal: GoalView, activation: GoalActivation): string {
  if (goal.phase === 'complete') return 'clear'
  if (goal.phase === 'blocked' || goal.phase === 'paused') return 'resume, clear'
  return activation === 'armed' ? 'pause, clear' : 'resume, pause, edit, clear'
}

export function GoalCommandCard({
  goal,
  activation,
  error,
  onClose
}: GoalCommandCardProps): React.JSX.Element {
  return (
    <div
      data-testid="goal-command-card"
      role="status"
      className="mx-auto w-full max-w-[calc(var(--chat-content-width)+32px)] px-4"
    >
      <div className="flex flex-col gap-1 rounded-panel border-(length:--hairline-width) border-hairline bg-(--bg-primary) px-4 py-3 text-c1 text-ink-secondary">
        <div className="flex items-center gap-2">
          <span className="font-sans text-b2 font-semibold text-ink">目标命令</span>
          {onClose === undefined ? null : (
            <button
              type="button"
              data-testid="goal-command-close"
              className="ml-auto text-c1 text-ink-tertiary hover:text-ink"
              onClick={onClose}
            >
              关闭
            </button>
          )}
        </div>
        {error === undefined ? null : (
          <p data-testid="goal-command-error" className="text-c1 text-danger">
            {error}
          </p>
        )}
        {goal === null ? (
          <p data-testid="goal-command-empty" className="font-mono text-c1 break-words">
            {'No goal is currently set; /goal <action> requires one.'}
          </p>
        ) : (
          <dl
            data-testid="goal-command-lines"
            className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-c1"
          >
            <dt className="text-ink-tertiary">Status</dt>
            <dd>{PHASE_LABEL[goal.phase]}</dd>
            <dt className="text-ink-tertiary">Blocker</dt>
            <dd>
              {goal.blockedReason === undefined
                ? '—'
                : `${goal.blockedReason.code}: ${goal.blockedReason.message}`}
            </dd>
            <dt className="text-ink-tertiary">Objective</dt>
            <dd className="break-words">{goal.objective}</dd>
            <dt className="text-ink-tertiary">Rounds</dt>
            <dd>
              {goal.roundsStarted}/{goal.maxGoalRounds}
            </dd>
            <dt className="text-ink-tertiary">Activation</dt>
            <dd>{activation}</dd>
            <dt className="text-ink-tertiary">Commands</dt>
            <dd>{commandsOf(goal, activation)}</dd>
          </dl>
        )}
      </div>
    </div>
  )
}
