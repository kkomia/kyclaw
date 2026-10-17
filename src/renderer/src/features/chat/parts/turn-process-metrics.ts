/**
 * 「本轮过程」容器的纯口径（task-52）：行数硬上限、跟随距离、用时文案。
 *
 * 单独文件的两个原因：
 *   1. 组件文件只导出组件（react-refresh 的 only-export-components 纪律）；
 *   2. 这些是纯函数/常量，单测可以直接打，不用挂 React。
 */

/** 行数硬上限（无虚拟化时的保护：超过只渲染最近 200 行 + 一行「更早的已折叠」） */
export const TURN_PROCESS_MAX_ROWS = 200

/** 用户离底部多少 px 内算"停在底部"（跟随时不被 1–2px 抖动打断） */
export const TURN_PROCESS_STICKY_DISTANCE = 32

/** 用时文案：X 秒 / X 分 Y 秒（1 分钟以内只给秒，避免「0 分 5 秒」） */
export function formatTurnDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  return `${Math.floor(totalSeconds / 60)} 分 ${totalSeconds % 60} 秒`
}
