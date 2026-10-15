import type { SessionPlan } from '@shared/plan'
import { planActiveOf, planModeLabel } from './plan-ui'

export interface PlanModeChipProps {
  /** 计划状态（null = 还没读到） */
  state: SessionPlan | null
}

/**
 * 模式状态摘要（round 81 改）。旧形态是工具条上一颗常驻件：普通模式也铺一枚「普通模式」胶囊，
 * 外加一颗「进入规划模式」按钮 —— 用户口径是这两样都收进左下角的 ＋ 菜单（见 ComposerControls
 * 的 PlusMenu，**不另造第二个模式菜单**）。
 *
 * 现在它只干一件事：**真的在规划里时**露一枚紧凑状态（规划中 / 等待批准 / 已批准待继续 / 执行中 /
 * 已取消），就是 `planModeLabel` 那一份真话，不伪造进度、不假装在跑。普通模式（或状态还没读到）
 * 什么都不铺 —— 没有正在发生的模式，就没有常驻件。取数错误由页脚那张错误卡（带重试）说，这里不重复。
 */
export function PlanModeChip({ state }: PlanModeChipProps): React.JSX.Element | null {
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
