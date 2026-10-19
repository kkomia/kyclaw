/**
 * B3.5 提问侧状态（renderer 视图模型）。
 *
 * 文案唯一来源：Gwen `b3-5-approval-design.md` §4.2。
 * 内核事实：超时 **不是拒绝**——timed 到期返回 `pending`，问题仍可回答（Ada 研究 §2）；
 * 迟到回答作为用户消息送达，标「超时后补答」。
 */
export type AskUserState = 'waiting' | 'timed-out' | 'late-answer' | 'settled' | 'unavailable'

export interface AskUserStateInput {
  state: AskUserState
  /** waiting + timed：总超时毫秒（用于倒计时显示） */
  timeoutMs?: number
  /** waiting + timed：剩余毫秒（没有 = 无倒计时） */
  remainingMs?: number
  /** settled：所选标签摘要（展示用，不伪造） */
  answerSummary?: string
  /** 应用关闭导致的取消 */
  appClosed?: boolean
}

export interface AskUserStateView {
  state: AskUserState
  title: string
  body?: string
  /** waiting 的徽标文案（有倒计时/无倒计时两态） */
  badge?: string
  primaryLabel?: string
  secondaryLabel?: string
}

export function formatRemaining(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function askUserStateView(input: AskUserStateInput): AskUserStateView {
  switch (input.state) {
    case 'waiting':
      return {
        state: input.state,
        title: '等待回答中',
        badge:
          input.remainingMs === undefined
            ? '等待回答'
            : `距离超时 ${formatRemaining(input.remainingMs)}`
      }
    case 'timed-out':
      return {
        state: input.state,
        title: '等待超时，模型先继续了',
        body: '这道题仍然有效，回答会作为新消息送达',
        primaryLabel: '继续回答',
        secondaryLabel: '忽略'
      }
    case 'late-answer':
      return {
        state: input.state,
        title: '已回答（超时后补答）',
        body: '模型当时已继续，这次回答会作为新消息送达'
      }
    case 'settled':
      return {
        state: input.state,
        title: '已回答',
        body: input.answerSummary
      }
    case 'unavailable':
      return {
        state: input.state,
        title: input.appClosed === true ? '提问因应用关闭而取消' : '问题没能显示给你',
        body:
          input.appClosed === true
            ? '没有收到回答；重新打开后可再发起'
            : '当时没有可用的回答界面，本轮无法继续',
        primaryLabel: '重新提问'
      }
  }
}
