/**
 * Office 面默认缩放（A2 / 用户 2026-10-17 第 3 条定调）。
 *
 * 目标：**默认 fit-width 缩放，让 1280 窗口下纸面视觉宽 ≈ 860px（830–880）**，
 * 同时不改文档字号/字体（Word-faithful 红线）。
 *
 * 口径：
 *   - 内核 `DEFAULT_PAGE_WIDTH = 816` CSS px（`packages/docx-react/.../internals/styles.ts:14`），
 *     纸面视觉宽 = 816 × zoom；
 *   - 目标视觉宽 860 → 首选 zoom = 860 / 816 ≈ 1.054；
 *   - 窗口/iframe 变窄时退化为 fit（留两侧各 48px 安全边距），避免横向溢出；
 *   - 夹在 [0.5, 2] 内（内核 zoom 的合理范围）。
 *
 * 为什么放在 surface 里算：隔离面拿不到 shell 的窗口尺寸，但 `window.innerWidth` 就是 iframe
 * 自身宽度（A1 起 iframe 全出血填满内容卡），正是"画布可用宽"。
 */

/** 内核默认页宽（CSS px）：`DEFAULT_PAGE_WIDTH`（0.4.3 源码 internals/styles.ts:14） */
export const OFFICE_PAGE_WIDTH = 816

/** 用户定调的纸面视觉宽（860；验收区间 830–880） */
export const OFFICE_TARGET_PAGE_WIDTH = 860

/**
 * fit 档两侧各留的最小安全边距（单边 12px）。
 * A3 的 320px AI 面板展开后，1280 窗口的 iframe 只剩 ≈898px：若按 48px 边距 fit，
 * 纸面会被压到 ≈802px（低于 830–880 验收区间）；12px 让 860 目标档仍放得下，
 * 窄窗（720 → iframe 659）再退化为 fit 不溢出。
 */
export const OFFICE_VIEWPORT_SIDE_PADDING = 12

/** 缩放夹取范围（与内核 zoom 的可用区间一致） */
export const OFFICE_MIN_ZOOM = 0.5
export const OFFICE_MAX_ZOOM = 2

/**
 * A4：窗口 resize → 重算 fit-width zoom 的防抖窗口。
 * 拖拽窗口时 `resize` 高频触发；120ms 内只算最后一次（与 `--office-motion-feedback` 同档，
 * 用户松手后一帧内跟手，且不会把内核 `setZoom` 打成动画队列）。
 */
export const OFFICE_ZOOM_RESIZE_DEBOUNCE_MS = 120

/**
 * 面内默认缩放（1 = 100%）。
 * @param viewportWidth 隔离面 iframe 的可用宽（`window.innerWidth`），非有限值时回退首选档
 */
export function officeDefaultZoom(viewportWidth: number): number {
  const preferred = OFFICE_TARGET_PAGE_WIDTH / OFFICE_PAGE_WIDTH
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return roundZoom(preferred)
  const fit = (viewportWidth - OFFICE_VIEWPORT_SIDE_PADDING * 2) / OFFICE_PAGE_WIDTH
  const zoom = Math.min(preferred, fit)
  return roundZoom(Math.min(OFFICE_MAX_ZOOM, Math.max(OFFICE_MIN_ZOOM, zoom)))
}

/** 保留 3 位小数：命令/断言里稳定（1.054 而不是 1.0539215686…） */
function roundZoom(zoom: number): number {
  return Math.round(zoom * 1000) / 1000
}
