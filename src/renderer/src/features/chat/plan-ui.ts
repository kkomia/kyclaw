import type { KernelPlanProjection } from '@shared/kernel-ui'

/**
 * PB-018 / PB-041：内核 plan 投影的**唯一判据**（Eve verdict R1）。
 *
 * `/plan` 后内核可能给两种合法形态：
 *   - `{active:true, pending:false}` —— 空闲时当场生效；
 *   - `{active:false, pending:true}` —— 有在途 turn 时"下一步生效"。
 * 两者都表示"在规划里"；UI 与测试只准调这一个函数，禁止各自钉一种形态（F1 就是这么 flaky 的）。
 * 旧 plans 状态机（`SessionPlan`）已随 PB-041 下架，这里不再有第二套判据。
 */
export function kernelPlanActive(plan: KernelPlanProjection | null | undefined): boolean {
  return plan !== null && plan !== undefined && (plan.active || plan.pending)
}

/**
 * 「进入规划模式」这条入口的文案（round 85）：＋ 菜单与 `/` 命令两处是**同一个动作、同一句话**，
 * 各写一份迟早会长歪，所以只有这一个出处。
 */
export const PLAN_ENTER_LABEL = '进入规划模式'
