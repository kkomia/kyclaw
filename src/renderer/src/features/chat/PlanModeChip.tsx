import type { KernelPlanProjection } from '@shared/kernel-ui'
import { kernelPlanActive } from './plan-ui'

export interface PlanModeChipProps {
  /**
   * 内核 plan 投影。**只读内核**（PB-041：旧 plans 状态机入口已下架）。
   * `{active:true}` / `{pending:true}` 都算"规划中"（见 `kernelPlanActive`）。
   */
  kernelPlan?: KernelPlanProjection | null
}

/**
 * 模式状态摘要（round 81 改）。旧形态是工具条上一颗常驻件：普通模式也铺一枚「普通模式」胶囊，
 * 外加一颗「进入规划模式」按钮 —— 用户口径是这两样都收进左下角的 ＋ 菜单（见 ComposerControls
 * 的 PlusMenu，**不另造第二个模式菜单**）。
 *
 * 现在它只干一件事：**真的在规划里时**露一枚紧凑状态；普通模式 / 投影没读到 / flag 关都什么都不铺。
 * 计划正文与批准动作**没有**内核替代通道，PB-041 起不再在 renderer 提供旧计划审批卡。
 */
export function PlanModeChip({ kernelPlan }: PlanModeChipProps): React.JSX.Element | null {
  if (!kernelPlanActive(kernelPlan)) return null
  return (
    <div data-testid="plan-mode-chip" className="flex min-w-0 flex-wrap items-center gap-2 text-c1">
      <span
        role="status"
        className="rounded-badge bg-(--fill-selected) px-2 py-1 text-ink-secondary"
      >
        规划中
      </span>
    </div>
  )
}
