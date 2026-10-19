import type {
  KernelApprovalAttribution,
  KernelApprovalCopy,
  KernelApprovalOutcome
} from '@shared/kernel-interactions'

/**
 * B3.5 审批结果四态（renderer 视图模型）。
 *
 * 事实来源：内核 `approval/decided.outcome`；PB-026 起**文案优先用服务端 copy**
 * （`{title,detail,attribution,canRetry}`，见 `shared/kernel-interactions.ts`），不再由 renderer 推断；
 * 旧路径（flag 关 / 已有测试）没有 copy 时退回本地映射，保持文案不变。
 *
 * 红线：`unavailable` / `cancelled` **绝不可**归因为用户拒绝——只有 `rejected` 允许出现「你拒绝」。
 * 服务端 copy 若 attribution !== 'user'，即使文案写了「你」也不归因（`blamesUser=false`）。
 */
export type ApprovalOutcome = KernelApprovalOutcome

export interface ApprovalOutcomeInput {
  outcome: ApprovalOutcome
  toolName: string
  /** 目标/命令摘要（可选；卡上已有，不重复也可以传） */
  target?: string
  /** 应用关闭导致的中止（cancelled 细分文案用；无法区分时传 false） */
  appClosed?: boolean
  /** 内核审计里的原因/时间（只在「查看详情」里展示） */
  cause?: string
  at?: number
  /** 我方应答者自记（S2）：renderer=用户点的；host-auto=宿主规则自动应答 */
  answeredBy?: 'renderer' | 'host-auto' | null
  /** PB-026：服务端下发的最终文案（优先于本地映射） */
  copy?: KernelApprovalCopy
  /** PB-026：取消/自动拒绝/策略拒绝（不是你点的） */
  systemInitiated?: boolean
}

export interface ApprovalOutcomeView {
  outcome: ApprovalOutcome
  title: string
  body: string
  /** true 只可能来自 rejected（红线） */
  blamesUser: boolean
  primaryLabel?: string
  secondaryLabel?: string
  /** PB-026：服务端归因（有 copy 时必有） */
  attribution?: KernelApprovalAttribution
  details?: { cause?: string; at?: number; answeredBy?: string | null }
}

/** 已允许的三种范围（宿主语义；内核只收 allowed-once） */
export type ApprovalAllowScope = 'once' | 'session' | 'forever'

const ALLOW_BODY: Record<ApprovalAllowScope, string> = {
  once: '模型继续执行这次调用',
  session: '之后同类操作会自动允许；换对话仍会询问',
  forever: '已写入权限规则；可在设置 → 工作区撤销'
}

const ALLOW_TITLE: Record<ApprovalAllowScope, string> = {
  once: '已允许一次',
  session: '已允许（本次对话）',
  forever: '已允许（始终）'
}

export function approvalOutcomeView(input: ApprovalOutcomeInput): ApprovalOutcomeView {
  const details =
    input.cause === undefined && input.at === undefined && input.answeredBy === undefined
      ? undefined
      : { cause: input.cause, at: input.at, answeredBy: input.answeredBy }

  // PB-026：有服务端 copy 就照它展示（title/detail/attribution/canRetry）；
  // 红线仍由本地兜底：只有 rejected + attribution=user + 非系统发起才允许「你拒绝」。
  if (input.copy !== undefined) {
    const copy = input.copy
    const blamesUser =
      input.systemInitiated !== true && copy.attribution === 'user' && input.outcome === 'rejected'
    return {
      outcome: input.outcome,
      title: copy.title,
      body: copy.detail,
      blamesUser,
      attribution: copy.attribution,
      ...(copy.canRetry ? { primaryLabel: '重新发起' } : {}),
      ...(copy.attribution === 'user' ? {} : { secondaryLabel: '查看详情' }),
      ...(details === undefined ? {} : { details })
    }
  }

  switch (input.outcome) {
    case 'allowed-once':
      return {
        outcome: input.outcome,
        title: ALLOW_TITLE.once,
        body: ALLOW_BODY.once,
        blamesUser: false,
        details
      }
    case 'rejected':
      return {
        outcome: input.outcome,
        title: '你拒绝了这次操作',
        body: '模型会继续，这次调用不会执行',
        blamesUser: true,
        primaryLabel: '重新发起',
        details
      }
    case 'cancelled':
      return {
        outcome: input.outcome,
        title: input.appClosed === true ? '审批因应用关闭而取消' : '这次审批已取消',
        body: input.appClosed === true ? '没有执行；重新打开后可再发起' : '没有执行这次操作',
        blamesUser: false,
        primaryLabel: '重新发起',
        details
      }
    case 'unavailable':
      return {
        outcome: input.outcome,
        title: '这次操作被自动拒绝了',
        body: '因为你当时不在（审批界面不可用），系统按安全策略默认拒绝；这不是你点的。没有执行任何操作。',
        blamesUser: false,
        primaryLabel: '重新发起',
        secondaryLabel: '查看详情',
        details
      }
  }
}

/** 允许范围（宿主按钮语义）的展示文案 */
export function approvalAllowView(scope: ApprovalAllowScope): { title: string; body: string } {
  return { title: ALLOW_TITLE[scope], body: ALLOW_BODY[scope] }
}

/** 红线断言清单：这些状态的结果文案里不得出现「你拒绝」 */
export function isUserBlameForbidden(outcome: ApprovalOutcome): boolean {
  return outcome === 'unavailable' || outcome === 'cancelled'
}
