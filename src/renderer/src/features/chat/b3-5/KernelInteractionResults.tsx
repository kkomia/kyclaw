import type { KernelApprovalResult, KernelAskUserSettledItem } from '@shared/kernel-interactions'
import { ApprovalOutcomeRow } from './ApprovalOutcomeRow'
import { approvalOutcomeView } from './approval-outcome'
import { AskUserStateRow } from './AskUserStateRow'
import { askUserStateView } from './ask-user-state'

/**
 * PB-026：交互 **结果**进消息流（gwen 设计 §3.1；Lead 2026-10-19：挂起在 dock、结果在消息流）。
 *
 * 数据来自 snapshot 的 `approvals.results` / `askUser.settled`（服务端 copy 优先）。
 * 结果行不给「重新发起/补答」假按钮：当前没有对应的重发/补答路由，宁可不给，也不留死按钮。
 * 与 ToolCard 里的旧路径结果行同组件（ApprovalOutcomeRow / AskUserStateRow），形状一致。
 */
export function KernelInteractionResults({
  results,
  settled
}: {
  results: readonly KernelApprovalResult[]
  settled: readonly KernelAskUserSettledItem[]
}): React.JSX.Element | null {
  if (results.length === 0 && settled.length === 0) return null
  return (
    <div data-testid="kernel-interaction-results" className="flex flex-col gap-2">
      {results.map((result) => {
        const view = approvalOutcomeView({
          outcome: result.outcome,
          toolName: result.toolName ?? '',
          copy: result.copy,
          systemInitiated: result.systemInitiated || result.settledBy === 'system',
          ...(result.reason === undefined ? {} : { cause: result.reason }),
          ...(result.at === undefined ? {} : { at: result.at })
        })
        return (
          <div key={result.id} data-testid="kernel-approval-result" data-event-id={result.id}>
            <ApprovalOutcomeRow
              view={{ ...view, primaryLabel: undefined, secondaryLabel: undefined }}
            />
          </div>
        )
      })}
      {settled.map((item) => (
        <div key={item.callId} data-testid="kernel-askuser-result" data-call-id={item.callId}>
          <AskUserStateRow
            view={askUserStateView({
              state: 'settled',
              answerSummary: item.answers
                .map((answer) =>
                  [answer.selected.join(' / '), answer.custom ?? '']
                    .filter((part) => part.trim() !== '')
                    .join('：')
                )
                .filter((text) => text !== '')
                .join('；')
            })}
          />
        </div>
      ))}
    </div>
  )
}
