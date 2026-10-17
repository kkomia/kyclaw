import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/components/ui/cn'
import { Textarea } from '@renderer/components/ui/input'
import { PLAN_BODY_MAX_CHARS, type PlanRef, type SessionPlan } from '@shared/plan'
import { CollapsibleRow } from './CollapsibleRow'
import { TextPart } from './parts/TextPart'
import { planSummaryOf } from './plan-ui'

export interface PlanApprovalDockProps {
  state: SessionPlan | null
  planRef: PlanRef | null
  busy?: boolean
  error?: string | null
  feedback: string
  onFeedbackChange: (feedback: string) => void
  onApprove: (threadId: string, ref: PlanRef) => Promise<void>
  onRevise: (threadId: string, ref: PlanRef, feedback: string) => Promise<void>
  onCancel: (threadId: string, expectedVersion: number) => Promise<void>
}

export function PlanApprovalDock(props: PlanApprovalDockProps): React.JSX.Element | null {
  const { state } = props
  if (!state || state.mode === 'normal') return null
  const key = JSON.stringify([
    state.threadId,
    state.planId,
    state.revision,
    state.version,
    props.error
  ])
  return <PlanApprovalPanel key={key} {...props} state={state} />
}

/**
 * 计划审批卡（round 81 改密度：**默认只铺一行摘要，点开才看完整计划与修订内容**）。
 *
 * 为什么这么改（用户口径「任务和计划摘要点击展开」）：计划正文可以很长，常驻铺满会把输入框挤下去、
 * 也把真正的待办动作淹掉。现在是两截：
 *   - 摘要行（`plan-approval-toggle`）：计划版本 / 状态版本 + 一行正文摘要（`planSummaryOf`），
 *     点它展开 / 收起（aria-expanded）；模式状态本身由 ChatPage 那枚 `PlanModeChip` 说，不重复；
 *   - 详情（`plan-approval-details`，复用 `CollapsibleRow` 收合）：完整 Markdown + 上一轮修改要求
 *     + 修改反馈输入框（只在等待批准时给）。
 *
 * 动作**不跟着折叠**（「不能折叠后让用户找不到待处理动作」）：批准 / 修改计划 / 停止本轮三颗按钮
 * 与「批准不等于放开文件权限」那句话一直在卡片底部。反馈为空时点「修改计划」不会闷着不动 ——
 * 它把详情展开并把焦点送到输入框，用户接着写；写好了再点它才是真的提交修订。
 * 批准的能力一字未动：不升级权限、不绕过工具审批、不静默自动批准。
 */
function PlanApprovalPanel({
  state,
  planRef,
  busy = false,
  error,
  feedback,
  onFeedbackChange,
  onApprove,
  onRevise,
  onCancel
}: PlanApprovalDockProps & { state: SessionPlan }): React.JSX.Element {
  const id = useId()
  const locked = useRef(false)
  const [pending, setPending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  /** 详情是否展开（默认收起；换版本会按 key 重挂，回到收起态） */
  const [expanded, setExpanded] = useState(false)
  /**
   * 展开之后要不要把焦点送到反馈框（点「修改计划」但还没写反馈时用）。
   * 用 ref 而不是 state：这只是"展开那一下"的一次性动作，写进 state 就得在 effect 里
   * setState 收尾（级联渲染），而它并不参与渲染。
   */
  const focusFeedbackPending = useRef(false)
  const feedbackRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!expanded || !focusFeedbackPending.current) return
    focusFeedbackPending.current = false
    feedbackRef.current?.focus()
  }, [expanded])
  const current =
    planRef !== null &&
    planRef.planId === state.planId &&
    planRef.revision === state.revision &&
    planRef.version === state.version
  const disabled = busy || pending || !current
  const awaiting = state.mode === 'awaiting_approval'
  const canApprove = awaiting && state.approval === null
  const active = state.mode !== 'cancelled'
  const act = (callback: () => Promise<void>): void => {
    if (disabled || locked.current) return
    locked.current = true
    setPending(true)
    setLocalError(null)
    try {
      Promise.resolve(callback()).catch((failure: unknown) => {
        locked.current = false
        setPending(false)
        setLocalError(failure instanceof Error ? failure.message : '操作失败，请重试。')
      })
    } catch (failure) {
      locked.current = false
      setPending(false)
      setLocalError(failure instanceof Error ? failure.message : '操作失败，请重试。')
    }
  }
  return (
    <section
      aria-label="计划审批"
      aria-busy={busy || pending || undefined}
      data-testid="plan-approval-dock"
      className={cn(
        'chat-dock-enter mx-auto mb-2 flex w-full min-w-0 max-w-(--chat-input-max-width) shrink-0 flex-col overflow-hidden rounded-panel border border-surface-border bg-secondary text-b2 [overflow-wrap:anywhere]',
        // 展开详情时整卡给高一档的上限：正文（可滚）+ 反馈框 + 底部那行动作都要落在这张卡里。
        // 原来不管展开与否都是 36vh：展开时正文把底座挤满，`overflow-hidden` 会把**动作行裁掉**
        // （实测 1280×800 下「批准此计划/修改计划/停止本轮」整行看不见）——用户口径是
        // 「不能折叠后让用户找不到待处理动作」，展开时更不能。
        expanded ? 'max-h-[min(52vh,32rem)]' : 'max-h-[min(36vh,22rem)]'
      )}
    >
      <button
        type="button"
        data-testid="plan-approval-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((previous) => !previous)}
        className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left transition-colors duration-(--motion-fast) ease-main hover:bg-hover motion-reduce:transition-none"
      >
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-ink-tertiary transition-transform duration-(--motion-fast) ease-main motion-reduce:transition-none',
            !expanded && '-rotate-90'
          )}
        />
        <span className="font-medium text-ink">
          计划版本 {state.revision} · 状态版本 {state.version}
        </span>
        <span className="min-w-0 max-w-full truncate text-c1 text-ink-secondary">
          {planSummaryOf(state.body)}
        </span>
      </button>
      <CollapsibleRow
        active={expanded}
        testId="plan-approval-details"
        className="min-h-0 px-3 pb-2"
      >
        <div
          role="region"
          aria-label="计划正文与反馈"
          tabIndex={0}
          className="min-h-0 max-h-[min(26vh,15rem)] overflow-y-auto overscroll-contain focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
        >
          {state.body ? (
            <TextPart text={state.body} />
          ) : (
            <p className="text-ink-secondary">正在准备计划，提交后由你决定是否批准。</p>
          )}
          {state.feedback ? (
            <p className="mt-2 whitespace-pre-wrap text-c1 text-ink-secondary">
              修改要求：{state.feedback}
            </p>
          ) : null}
          {awaiting ? (
            <div className="mt-3 space-y-1">
              <label htmlFor={id} className="text-c1 text-ink-secondary">
                修改反馈（修改计划时必填）
              </label>
              <Textarea
                id={id}
                ref={feedbackRef}
                rows={2}
                value={feedback}
                disabled={disabled}
                maxLength={PLAN_BODY_MAX_CHARS}
                onChange={(event) => onFeedbackChange(event.target.value)}
                className="max-h-24 min-w-0 border-surface-border"
              />
            </div>
          ) : null}
        </div>
      </CollapsibleRow>
      <div className="shrink-0 space-y-2 border-t border-surface-border px-3 py-2">
        <p className="text-c1 text-ink-secondary">
          批准计划不等于允许所有文件操作；现有工作区权限与工具审批仍然生效。
        </p>
        {!current ? (
          <p role="alert" className="text-c1 text-warning">
            计划版本已变化，请等待最新服务器状态。
          </p>
        ) : null}
        {error || localError ? (
          <p role="alert" className="whitespace-pre-wrap text-c1 text-warning">
            {error || localError}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {awaiting ? (
            <>
              <Button
                size="sm"
                disabled={disabled || !canApprove}
                onClick={() => {
                  if (planRef && canApprove) act(() => onApprove(state.threadId, { ...planRef }))
                }}
              >
                {state.approval ? '已批准，待继续' : '批准此计划'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled || feedback.length > PLAN_BODY_MAX_CHARS}
                onClick={() => {
                  if (!planRef) return
                  // 还没写反馈：先展开详情 + 把焦点送到输入框（不闷着不动，也不假装提交了修订）
                  if (feedback.trim() === '') {
                    focusFeedbackPending.current = true
                    setExpanded(true)
                    return
                  }
                  act(() => onRevise(state.threadId, { ...planRef }, feedback.trim()))
                }}
              >
                修改计划
              </Button>
            </>
          ) : null}
          {active ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => act(() => onCancel(state.threadId, state.version))}
            >
              停止本轮
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  )
}
