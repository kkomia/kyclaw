import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  approvalAllowView,
  approvalOutcomeView,
  isUserBlameForbidden,
  type ApprovalOutcome
} from '../approval-outcome'
import { ApprovalOutcomeRow } from '../ApprovalOutcomeRow'
import { approvalOutcomesFromEvents } from '../kernel-approval-adapter'
import { askUserStateView, formatRemaining } from '../ask-user-state'
import { AskUserPendingBadge, AskUserStateRow } from '../AskUserStateRow'
import { ToolCard } from '../../parts/ToolCard'
import { latestStepStage } from '../../parts/turn-latest-status-model'
import type { TurnProcessEntry } from '../../parts/TurnProcess'

/**
 * B3.5 前端：审批四态 / 提问三态文案与红线（Gwen `b3-5-approval-design.md` §4，逐字）。
 * 红线硬判据：`unavailable` / `cancelled` 的 DOM 文本**不得出现「你拒绝」**；只有 `rejected` 可以。
 */
const OUTCOMES: ApprovalOutcome[] = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

describe('PB-026：服务端 copy 优先 + 归因红线', () => {
  const copy = {
    title: '服务端标题',
    detail: '服务端详情',
    attribution: 'system' as const,
    canRetry: true
  }

  it('有 copy 时标题/正文/归因来自服务端；system 不归因给用户', () => {
    const view = approvalOutcomeView({
      outcome: 'unavailable',
      toolName: 'write',
      copy,
      systemInitiated: true
    })
    expect(view.title).toBe('服务端标题')
    expect(view.body).toBe('服务端详情')
    expect(view.attribution).toBe('system')
    expect(view.blamesUser).toBe(false)
    expect(view.primaryLabel).toBe('重新发起')
    expect(view.secondaryLabel).toBe('查看详情')
  })

  it('只有 rejected + attribution=user 才 blamesUser=true', () => {
    const rejected = approvalOutcomeView({
      outcome: 'rejected',
      toolName: 'write',
      copy: { ...copy, attribution: 'user', title: '你拒绝了' }
    })
    expect(rejected.blamesUser).toBe(true)
    const systemRejected = approvalOutcomeView({
      outcome: 'rejected',
      toolName: 'write',
      copy,
      systemInitiated: true
    })
    expect(systemRejected.blamesUser).toBe(false)
  })
})

describe('审批四态：文案与红线', () => {
  it('unavailable 逐字文案：自动拒绝 + 不是你点的 + 重试/详情', () => {
    const view = approvalOutcomeView({ outcome: 'unavailable', toolName: 'write' })
    expect(view.title).toBe('这次操作被自动拒绝了')
    expect(view.body).toBe(
      '因为你当时不在（审批界面不可用），系统按安全策略默认拒绝；这不是你点的。没有执行任何操作。'
    )
    expect(view.primaryLabel).toBe('重新发起')
    expect(view.secondaryLabel).toBe('查看详情')
    expect(view.blamesUser).toBe(false)
  })

  it('rejected 是唯一可以说「你拒绝」的状态', () => {
    const view = approvalOutcomeView({ outcome: 'rejected', toolName: 'write' })
    expect(view.title).toBe('你拒绝了这次操作')
    expect(view.blamesUser).toBe(true)
    for (const outcome of OUTCOMES) {
      if (outcome === 'rejected') continue
      expect(approvalOutcomeView({ outcome, toolName: 'write' }).title).not.toContain('你拒绝')
      expect(approvalOutcomeView({ outcome, toolName: 'write' }).body).not.toContain('你拒绝')
    }
  })

  it('红线做进 DOM 断言：unavailable / cancelled 不含「你拒绝」，rejected 含', () => {
    const { unmount } = render(
      <ApprovalOutcomeRow
        view={approvalOutcomeView({ outcome: 'unavailable', toolName: 'write' })}
      />
    )
    expect(document.body.textContent ?? '').not.toContain('你拒绝')
    unmount()

    const cancelled = render(
      <ApprovalOutcomeRow view={approvalOutcomeView({ outcome: 'cancelled', toolName: 'write' })} />
    )
    expect(cancelled.container.textContent ?? '').not.toContain('你拒绝')
    cancelled.unmount()

    render(
      <ApprovalOutcomeRow view={approvalOutcomeView({ outcome: 'rejected', toolName: 'write' })} />
    )
    expect(screen.getByTestId('approval-outcome').textContent ?? '').toContain('你拒绝')
  })

  it('cancelled 两种文案：用户取消 / 应用关闭；从不写成拒绝', () => {
    const user = approvalOutcomeView({ outcome: 'cancelled', toolName: 'write' })
    expect(user.title).toBe('这次审批已取消')
    expect(user.body).toBe('没有执行这次操作')
    const app = approvalOutcomeView({ outcome: 'cancelled', toolName: 'write', appClosed: true })
    expect(app.title).toBe('审批因应用关闭而取消')
    expect(app.body).toBe('没有执行；重新打开后可再发起')
    for (const view of [user, app]) {
      expect(view.blamesUser).toBe(false)
      expect(view.title).not.toContain('你拒绝')
      expect(view.body).not.toContain('你拒绝')
    }
    expect(isUserBlameForbidden('cancelled')).toBe(true)
    expect(isUserBlameForbidden('rejected')).toBe(false)
  })

  it('allowed-once / 允许范围文案（本会话/始终是宿主语义）', () => {
    expect(approvalOutcomeView({ outcome: 'allowed-once', toolName: 'write' }).title).toBe(
      '已允许一次'
    )
    expect(approvalAllowView('session').body).toBe('之后同类操作会自动允许；换对话仍会询问')
    expect(approvalAllowView('forever').body).toBe('已写入权限规则；可在设置 → 工作区撤销')
  })

  it('行组件：按钮可点；查看详情展开原因与时间', () => {
    const onRetry = vi.fn()
    const view = approvalOutcomeView({
      outcome: 'unavailable',
      toolName: 'write',
      cause: '审批界面不可用',
      at: 1
    })
    render(<ApprovalOutcomeRow view={view} onRetry={onRetry} />)
    fireEvent.click(screen.getByTestId('approval-outcome-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('approval-outcome-cause')).toBeNull()
    fireEvent.click(screen.getByTestId('approval-outcome-details-toggle'))
    expect(screen.getByTestId('approval-outcome-cause')).toHaveTextContent('审批界面不可用')
  })
})

describe('提问三态：等待（有/无倒计时）/ 迟到回答 / 已 settle', () => {
  it('等待回答：无倒计时与有倒计时两态', () => {
    const plain = askUserStateView({ state: 'waiting' })
    expect(plain.title).toBe('等待回答中')
    expect(plain.badge).toBe('等待回答')
    const timed = askUserStateView({ state: 'waiting', remainingMs: 151_000 })
    expect(timed.badge).toBe('距离超时 02:31')
    expect(formatRemaining(151_000)).toBe('02:31')

    const { unmount } = render(<AskUserPendingBadge view={plain} />)
    expect(screen.getByTestId('ask-user-pending-badge')).not.toHaveAttribute('data-has-countdown')
    unmount()
    render(<AskUserPendingBadge view={timed} />)
    expect(screen.getByTestId('ask-user-pending-badge')).toHaveAttribute(
      'data-has-countdown',
      'true'
    )
  })

  it('超时仍可答 → 迟到回答 → 已 settle（超时不是拒绝）', () => {
    const timedOut = askUserStateView({ state: 'timed-out' })
    expect(timedOut.title).toBe('等待超时，模型先继续了')
    expect(timedOut.body).toBe('这道题仍然有效，回答会作为新消息送达')
    expect(timedOut.primaryLabel).toBe('继续回答')

    const late = askUserStateView({ state: 'late-answer' })
    expect(late.title).toBe('已回答（超时后补答）')
    expect(late.body).toBe('模型当时已继续，这次回答会作为新消息送达')

    const settled = askUserStateView({ state: 'settled', answerSummary: '选了「方案 A」' })
    expect(settled.title).toBe('已回答')
    expect(settled.body).toBe('选了「方案 A」')
    for (const view of [timedOut, late, settled]) {
      expect(view.title).not.toContain('拒绝')
      expect(view.body ?? '').not.toContain('拒绝')
    }
  })

  it('结果行渲染：迟到回答 / 无法显示问题（重新提问）', () => {
    const late = render(<AskUserStateRow view={askUserStateView({ state: 'late-answer' })} />)
    expect(late.container).toHaveTextContent('已回答（超时后补答）')
    late.unmount()

    const unavailable = askUserStateView({ state: 'unavailable' })
    expect(unavailable.title).toBe('问题没能显示给你')
    expect(unavailable.primaryLabel).toBe('重新提问')
    const { container } = render(<AskUserStateRow view={unavailable} onPrimary={vi.fn()} />)
    expect(container).toHaveTextContent('问题没能显示给你')
  })
})

describe('内核事件 → 四态（fake 事件 fixture）', () => {
  it('asked + decided 按 id 配对；四态原样透传；answeredBy 从自记映射', () => {
    const events = [
      { type: 'approval/asked', seq: 1, id: 'a1', toolName: 'write', reason: '写工作区外文件' },
      { type: 'approval/decided', seq: 2, id: 'a1', outcome: 'unavailable' },
      { type: 'approval/asked', seq: 3, id: 'a2', toolName: 'bash' },
      { type: 'approval/decided', seq: 4, id: 'a2', outcome: 'rejected' },
      { type: 'approval/asked', seq: 5, id: 'a3', toolName: 'bash' },
      { type: 'approval/decided', seq: 6, id: 'a3', outcome: 'allowed-once' },
      { type: 'approval/asked', seq: 7, id: 'a4', toolName: 'bash' },
      { type: 'approval/decided', seq: 8, id: 'a4', outcome: 'cancelled' },
      { type: 'approval/decided', seq: 9, id: 'missing', outcome: 'rejected' }
    ]
    const results = approvalOutcomesFromEvents(events, {
      answeredBy: { a3: 'renderer', a4: 'host-auto' }
    })
    expect(results.map((result) => result.outcome)).toEqual([
      'unavailable',
      'rejected',
      'allowed-once',
      'cancelled'
    ])
    expect(results[0]).toMatchObject({ toolName: 'write', cause: '写工作区外文件' })
    expect(results[2]).toMatchObject({ answeredBy: 'renderer' })
    expect(results[3]).toMatchObject({ answeredBy: 'host-auto' })
  })
})

describe('复用现有状态行（TurnLatestStatus 的 data-stage）与工具卡', () => {
  const entry = (part: Record<string, unknown>): TurnProcessEntry =>
    ({ index: 0, part }) as unknown as TurnProcessEntry

  it('四态映射到状态行阶段；unavailable 不出现「你拒绝」', () => {
    expect(
      latestStepStage([
        entry({ type: 'tool-write', state: 'approval-responded', approvalOutcome: 'unavailable' })
      ])
    ).toMatchObject({
      key: 'approval-unavailable',
      label: '审批被自动拒绝'
    })
    expect(
      latestStepStage([
        entry({ type: 'tool-write', state: 'approval-responded', approvalOutcome: 'rejected' })
      ])
    ).toMatchObject({
      key: 'approval-rejected'
    })
    expect(
      latestStepStage([
        entry({ type: 'tool-write', state: 'approval-responded', approvalOutcome: 'unavailable' })
      ]).label
    ).not.toContain('你拒绝')
  })

  it('ToolCard 带 outcome 时渲染结果行，旧 part（无字段）不渲染', () => {
    const withOutcome = render(
      <ToolCard
        part={{
          toolName: 'write',
          state: 'approval-responded',
          input: { path: 'a.txt' },
          approvalOutcome: 'unavailable',
          approvalCause: '审批界面不可用'
        }}
        onApprovalRetry={vi.fn()}
      />
    )
    expect(withOutcome.container.querySelector('[data-testid=approval-outcome]')).not.toBeNull()
    expect(withOutcome.container.textContent ?? '').not.toContain('你拒绝')
    withOutcome.unmount()

    const legacy = render(
      <ToolCard part={{ toolName: 'write', state: 'output-denied', input: { path: 'a.txt' } }} />
    )
    expect(legacy.container.querySelector('[data-testid=approval-outcome]')).toBeNull()
    expect(legacy.container.querySelector('[data-testid=ask-user-state]')).toBeNull()
  })

  it('ask_user part 带状态时渲染提问结果行（迟到回答）', () => {
    const { container } = render(
      <ToolCard
        part={{ toolName: 'ask_user', state: 'output-available', askUserState: 'late-answer' }}
      />
    )
    expect(container.querySelector('[data-testid=ask-user-state]')).not.toBeNull()
    expect(container.textContent ?? '').toContain('已回答（超时后补答）')
  })
})
