import type { SessionPlan } from '@shared/plan'
import type { KernelPlanProjection } from '@shared/kernel-ui'
import { kernelPlanActive, planActiveOf, planModeLabel } from './plan-ui'

export interface PlanModeChipProps {
  /** 计划状态（null = 还没读到） */
  state: SessionPlan | null
  /**
   * PB-018：内核 plan 投影。**只要给了就以内核为准**（flag 开）；两种合法形态
   * `{active:true}` / `{pending:true}` 都算"规划中"（见 `kernelPlanActive`）。
   */
  kernelPlan?: KernelPlanProjection | null
}

/**
 * 模式状态摘要（round 81 改）。旧形态是工具条上一颗常驻件：普通模式也铺一枚「普通模式」胶囊，
 * 外加一颗「进入规划模式」按钮 —— 用户口径是这两样都收进左下角的 ＋ 菜单（见 ComposerControls
 * 的 PlusMenu，**不另造第二个模式菜单**）。
 *
 * 现在它只干一件事：**真的在规划里时**露一枚紧凑状态。内核模式读内核投影（规划中）；
 * 旧路径读 `planModeLabel` 那一份真话，不伪造进度、不假装在跑。普通模式（或状态还没读到）
 * 什么都不铺 —— 没有正在发生的模式，就没有常驻件。
 */
export function PlanModeChip({ state, kernelPlan }: PlanModeChipProps): React.JSX.Element | null {
  if (kernelPlan !== undefined) {
    if (!kernelPlanActive(kernelPlan)) return null
    return (
      <div
        data-testid="plan-mode-chip"
        className="flex min-w-0 flex-wrap items-center gap-2 text-c1"
      >
        <span
          role="status"
          className="rounded-badge bg-(--fill-selected) px-2 py-1 text-ink-secondary"
        >
          规划中
        </span>
      </div>
    )
  }
  if (!planActiveOf(state)) return null
  return (
    <div data-testid="plan-mode-chip" className="flex min-w-0 flex-wrap items-center gap-2 text-c1">
      <span
        role="status"
        className="rounded-badge bg-(--fill-selected) px-2 py-1 text-ink-secondary"
      >
        {planModeLabel(state)}
      </span>
    </div>
  )
}
