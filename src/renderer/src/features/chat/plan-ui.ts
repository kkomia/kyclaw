import type { SessionPlan } from '@shared/plan'

/**
 * 计划状态的展示文案（纯函数）：从 PlanModeChip.tsx 搬出来 —— 组件文件只该导出组件，
 * 常量 / 函数另开模块（react-refresh/only-export-components；同目录的 ask-user-ui.ts 是同一手法）。
 */
export function planModeLabel(state: SessionPlan): string {
  if (state.mode === 'awaiting_approval') return state.approval ? '已批准，待继续' : '等待批准'
  return { normal: '普通模式', planning: '规划中', executing: '执行中', cancelled: '已取消' }[
    state.mode
  ]
}

/** 收起时那一行摘要最多铺多少个字（码点；超了加省略号） */
const PLAN_SUMMARY_CHARS = 60

/**
 * 计划正文的**一行摘要**（round 81）：收起状态下计划只铺这一行，点开才看完整 Markdown。
 * 取第一行非空文本，去掉行首的 Markdown 记号（`#` / `-` / `*` / 引用符），按**码点**截断
 * （不劈代理对）。没有正文时给一句实话（计划还没提交，不是"加载中"）。
 */
export function planSummaryOf(body: string | null): string {
  const line = (body ?? '')
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text !== '')
  if (line === undefined) return '计划还没提交，提交后由你决定是否批准。'
  const flat = line
    .replace(/^[#>*\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  const text = flat === '' ? line : flat
  const points = [...text]
  return points.length <= PLAN_SUMMARY_CHARS
    ? text
    : `${points.slice(0, PLAN_SUMMARY_CHARS).join('')}…`
}
