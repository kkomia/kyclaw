import type { KernelGoalProjection, KernelPlanProjection } from '@shared/kernel-ui'
import { kernelPlanActive } from './plan-ui'

/**
 * PB-018：命令结果卡片（`command/run` → `command/done` 驱动；命令不进消息流）。
 *
 * 六行结构照内核 goal 投影（Status / Blocker / Objective / Rounds / Activation / Commands），
 * **逐字渲染 main 投影出来的 label/value/tone** —— renderer 不自己拼六行、不解释内核对象。
 * 错误只显示人话 message（不渲染命令 id / revision）；`/goal` 无 goal 时仍显示契约原文。
 */
export interface GoalCommandCardProps {
  /** 本次执行的整行命令（`/goal`、`/plan`…），用于空态文案判据 */
  line: string
  projection: KernelGoalProjection | null
  plan?: KernelPlanProjection | null
  running?: boolean
  /** 命令给的可读结果（plan on/off、export 等；goal 六行已在 projection 里） */
  resultText?: string
  error?: string
  onClose?: () => void
}

const EMPTY_GOAL_TEXT = 'No goal is currently set; /goal <action> requires one.'

export function GoalCommandCard({
  line,
  projection,
  plan = null,
  running = false,
  resultText,
  error,
  onClose
}: GoalCommandCardProps): React.JSX.Element {
  const isGoalLine = /^\/goal(?:\s|$)/u.test(line.trim())
  const hasRows = projection !== null && projection.visible && projection.rows.length > 0
  return (
    <div
      data-testid="goal-command-card"
      data-plan-active={kernelPlanActive(plan) ? 'true' : 'false'}
      role="status"
      className="mx-auto w-full max-w-[calc(var(--chat-content-width)+32px)] px-4"
    >
      <div className="flex flex-col gap-1 rounded-panel border-(length:--hairline-width) border-hairline bg-(--bg-primary) px-4 py-3 text-c1 text-ink-secondary">
        <div className="flex items-center gap-2">
          <span className="font-sans text-b2 font-semibold text-ink">命令结果</span>
          <span className="font-mono text-c1 text-ink-tertiary">{line}</span>
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
        {running ? (
          <p data-testid="goal-command-running" className="text-c1 text-ink-tertiary">
            执行中…
          </p>
        ) : null}
        {error === undefined ? null : (
          <p data-testid="goal-command-error" className="text-c1 text-danger">
            {error}
          </p>
        )}
        {hasRows ? (
          <dl
            data-testid="goal-command-lines"
            className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-c1"
          >
            {projection.rows.map((row) => (
              <div key={row.id} className="contents">
                <dt className="text-ink-tertiary">{row.label}</dt>
                <dd
                  data-tone={row.tone}
                  className={row.tone === 'warning' ? 'text-warning' : undefined}
                >
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : isGoalLine && error === undefined && running !== true && resultText === undefined ? (
          <p data-testid="goal-command-empty" className="font-mono text-c1 break-words">
            {EMPTY_GOAL_TEXT}
          </p>
        ) : null}
        {resultText === undefined || hasRows ? null : (
          <p data-testid="goal-command-result" className="font-mono text-c1 break-words">
            {resultText}
          </p>
        )}
      </div>
    </div>
  )
}
