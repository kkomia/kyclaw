import { useState } from 'react'
import type {
  KernelApprovalRespondOutcome,
  KernelInteractionSnapshot,
  KernelPendingQuestion,
  KernelQuestionAnswer,
  KernelQuestionItem
} from '@shared/kernel-interactions'
import { PlanReviewCard } from './PlanReviewCard'
import { planReviewOfPending } from './plan-review'

/**
 * PB-026：内核交互 **挂起 dock**（composer 上方；结果行在消息流，见 KernelInteractionResults）。
 *
 * 数据来自 `GET /api/kernel/interactions` snapshot；写面只走 `POST …/respond`：
 *   - 审批：只有 `allowed-once` / `rejected` 两个用户动作；`source:'asked'` 没有写通道 → 只读提示，不放假按钮；
 *   - 提问：`questions.pending`（内核阻塞式）可答；`askUser.active` 的 `continued` 当前无写路由 → 只读 + 明确提示；
 *   - 200 后由 hook 刷新快照（卡片随快照消失）；409/404 在 hook 里提示「已处理/已过期」；
 *   - 不发 unavailable/cancelled（系统结果不是用户动作）。
 */
export interface KernelInteractionDockProps {
  snapshot: KernelInteractionSnapshot | null
  error: string | null
  notice: string | null
  submittingEventId: string | null
  onRespondApproval: (eventId: string, outcome: KernelApprovalRespondOutcome) => void
  onRespondQuestion: (eventId: string, answers: readonly KernelQuestionAnswer[]) => void
  onClearNotice?: () => void
}

interface AnswerDraft {
  selected: string[]
  custom: string
}

function draftFor(): AnswerDraft {
  return { selected: [], custom: '' }
}

/** PB-026：按钮白名单来自服务端 `actions`（缺省退回 `respondable`），不读 source */
function allows(
  approval: { actions?: readonly ('allow-once' | 'reject')[]; respondable?: boolean },
  action: 'allow-once' | 'reject'
): boolean {
  if (approval.actions !== undefined) return approval.actions.includes(action)
  return approval.respondable === true
}

function QuestionForm({
  question,
  submitting,
  onSubmit
}: {
  question: KernelPendingQuestion
  submitting: boolean
  onSubmit: (answers: readonly KernelQuestionAnswer[]) => void
}): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>(() =>
    Object.fromEntries(question.questions.map((item) => [item.id, draftFor()]))
  )
  const valid = question.questions.every((item) => {
    const draft = drafts[item.id]
    return draft !== undefined && (draft.selected.length > 0 || draft.custom.trim() !== '')
  })
  const patch = (id: string, next: AnswerDraft): void => {
    setDrafts((current) => ({ ...current, [id]: next }))
  }
  const toggle = (item: KernelQuestionItem, label: string): void => {
    const current = drafts[item.id] ?? draftFor()
    if (item.multiSelect === true) {
      const selected = current.selected.includes(label)
        ? current.selected.filter((value) => value !== label)
        : [...current.selected, label]
      patch(item.id, { ...current, selected })
    } else {
      patch(item.id, { ...current, selected: [label] })
    }
  }
  return (
    <div
      data-testid="kernel-question-card"
      data-event-id={question.eventId}
      className="flex flex-col gap-2 rounded-panel border-(length:--hairline-width) border-hairline bg-(--bg-primary) px-3 py-2"
    >
      <p className="text-b2 font-medium text-ink">内核在等你回答</p>
      {question.questions.map((item) => {
        const draft = drafts[item.id] ?? draftFor()
        return (
          <fieldset key={item.id} className="flex flex-col gap-1">
            <legend className="text-c1 text-ink-secondary">{item.question}</legend>
            {item.options?.map((option) => (
              <label
                key={option.label}
                data-testid="kernel-question-option"
                data-selected={draft.selected.includes(option.label) ? 'true' : undefined}
                className="flex cursor-pointer items-start gap-2 text-c1 text-ink-secondary"
              >
                <input
                  type={item.multiSelect === true ? 'checkbox' : 'radio'}
                  name={`${question.eventId}-${item.id}`}
                  checked={draft.selected.includes(option.label)}
                  onChange={() => toggle(item, option.label)}
                  className="mt-0.5"
                />
                <span>
                  {option.label}
                  {option.description === undefined ? null : (
                    <span className="block text-c2 text-ink-tertiary">{option.description}</span>
                  )}
                </span>
              </label>
            ))}
            <input
              type="text"
              data-testid="kernel-question-custom"
              value={draft.custom}
              placeholder="其它（可选）"
              onChange={(event) => patch(item.id, { ...draft, custom: event.target.value })}
              className="mt-1 h-8 rounded-control border-(length:--hairline-width) border-hairline bg-surface px-2 text-c1 text-ink outline-none focus-visible:border-ink"
            />
          </fieldset>
        )
      })}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          data-testid="kernel-question-submit"
          disabled={!valid || submitting}
          onClick={() =>
            onSubmit(
              question.questions.map((item) => {
                const draft = drafts[item.id] ?? draftFor()
                return {
                  id: item.id,
                  selected: draft.selected,
                  ...(draft.custom.trim() === '' ? {} : { custom: draft.custom.trim() })
                }
              })
            )
          }
          className="min-h-[26px] rounded-badge border-(length:--hairline-width) border-hairline px-2 text-c1 text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          提交回答
        </button>
        {submitting ? <span className="text-c2 text-ink-tertiary">提交中…</span> : null}
      </div>
    </div>
  )
}

export function KernelInteractionDock({
  snapshot,
  error,
  notice,
  submittingEventId,
  onRespondApproval,
  onRespondQuestion,
  onClearNotice
}: KernelInteractionDockProps): React.JSX.Element | null {
  if (snapshot === null && error === null) return null
  // PB-026：真实链路同一次审批会同时出现 asked（审计、不可应答）+ waterfall（可应答）两条。
  // 只用服务端 `respondable` 决定卡片/按钮；字段未到位（undefined）时整条不渲染，绝不按 source 猜。
  const approvals = (snapshot?.approvals.pending ?? []).filter(
    (approval) => approval.respondable !== undefined || approval.actions !== undefined
  )
  const questions = snapshot?.questions.pending ?? []
  const continued = (snapshot?.askUser.active ?? []).filter((item) => item.state === 'continued')
  if (
    approvals.length === 0 &&
    questions.length === 0 &&
    continued.length === 0 &&
    error === null &&
    notice === null
  )
    return null

  return (
    <div data-testid="kernel-interaction-dock" className="flex flex-col gap-2">
      {error === null ? null : (
        <p
          data-testid="kernel-interaction-error"
          role="alert"
          className="rounded-control border-(length:--hairline-width) border-danger px-3 py-2 text-c1 text-danger"
        >
          {error}
        </p>
      )}
      {notice === null ? null : (
        <div
          data-testid="kernel-interaction-notice"
          role="status"
          className="flex items-center gap-2 rounded-control border-(length:--hairline-width) border-hairline px-3 py-2 text-c1 text-ink-secondary"
        >
          <span className="min-w-0 flex-1">{notice}</span>
          {onClearNotice === undefined ? null : (
            <button
              type="button"
              data-testid="kernel-interaction-notice-close"
              className="text-c1 text-ink-tertiary hover:text-ink"
              onClick={onClearNotice}
            >
              知道了
            </button>
          )}
        </div>
      )}
      {approvals.map((approval) => (
        <div
          key={approval.id}
          data-testid="kernel-approval-card"
          data-event-id={approval.id}
          data-source={approval.source}
          className="flex flex-col gap-2 rounded-panel border-(length:--hairline-width) border-hairline bg-(--bg-primary) px-3 py-2"
        >
          <p className="text-b2 font-medium text-ink">审批请求：{approval.toolName}</p>
          {approval.reason === undefined ? null : (
            <p className="text-c1 break-words text-ink-secondary">{approval.reason}</p>
          )}
          {allows(approval, 'allow-once') || allows(approval, 'reject') ? (
            <div className="flex items-center gap-2">
              {allows(approval, 'allow-once') ? (
                <button
                  type="button"
                  data-testid="kernel-approval-allow"
                  disabled={submittingEventId !== null}
                  onClick={() => onRespondApproval(approval.id, 'allowed-once')}
                  className="min-h-[26px] rounded-badge border-(length:--hairline-width) border-hairline px-2 text-c1 text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  允许一次
                </button>
              ) : null}
              {allows(approval, 'reject') ? (
                <button
                  type="button"
                  data-testid="kernel-approval-reject"
                  disabled={submittingEventId !== null}
                  onClick={() => onRespondApproval(approval.id, 'rejected')}
                  className="min-h-[26px] rounded-badge border-(length:--hairline-width) border-hairline px-2 text-c1 text-danger hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  拒绝
                </button>
              ) : null}
              {submittingEventId === approval.id ? (
                <span className="text-c2 text-ink-tertiary">提交中…</span>
              ) : null}
            </div>
          ) : (
            <p data-testid="kernel-approval-readonly" className="text-c1 text-ink-tertiary">
              这条审批只能在内核侧处理，当前界面暂不能应答。
            </p>
          )}
        </div>
      ))}
      {questions.map((question) => {
        const review = planReviewOfPending(question)
        if (review !== null) {
          return (
            <PlanReviewCard
              key={question.eventId}
              review={review}
              submitting={submittingEventId === question.eventId}
              onSubmit={(answers) => onRespondQuestion(question.eventId, answers)}
            />
          )
        }
        return (
          <QuestionForm
            key={question.eventId}
            question={question}
            submitting={submittingEventId === question.eventId}
            onSubmit={(answers) => onRespondQuestion(question.eventId, answers)}
          />
        )
      })}
      {continued.map((item) => (
        <div
          key={item.callId}
          data-testid="kernel-askuser-continued"
          role="status"
          className="rounded-control border-(length:--hairline-width) border-hairline px-3 py-2 text-c1 text-ink-secondary"
        >
          <p className="font-medium text-ink">这次提问已超时，模型先继续了</p>
          <p className="break-words">
            {item.questions.map((question) => question.question).join('；')}
          </p>
          <p className="text-c2 text-ink-tertiary">
            问题仍然有效；当前界面暂不支持补答，请在对话中继续回答。
          </p>
        </div>
      ))}
    </div>
  )
}
