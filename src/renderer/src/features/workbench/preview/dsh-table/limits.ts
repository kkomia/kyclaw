/**
 * Excel 预览的资源上限（不依赖 React / 宿主，也**不 import FortuneSheet 运行时**）。
 *
 * 从 `model.ts` 拆出来（task-127 之后的包体优化）：`ExcelPreview` 的入口只需要这三个上限，
 * 原来它经 `model.ts` 静态拖进 `@fortune-sheet/core`（~2.9MB）到首屏主包。
 * `@fortune-sheet/core` 的 `update` 只被单元格收尾（`model.formatCell`）用，随
 * `ExcelBody` 的懒分支一起加载即可；上游出处与许可见同目录 `NOTICE.md`。
 */

/**
 * 解析前就套上的资源上限（三条都是"分配前"的护栏，不是解析完再裁）。
 */
export interface ExcelLimits {
  /** 源文件最大字节数 */
  maxBytes: number
  /** 所有工作表加起来的矩形格数上限（行列相乘再累加） */
  maxCells: number
  /** 单个解析 Worker 的最长存活时间（毫秒） */
  timeoutMs: number
}

/**
 * 缺省上限：
 *   - `maxCells` / `timeoutMs` 取 DSH 原值（25 万格 / 15s）——前者是 FortuneSheet 稠密矩阵的分配护栏；
 *   - `maxBytes` 取 **32 MiB**（DSH 原值 16 MiB）：与 kyclaw 字节通道 `PREVIEW_OFFICE_MAX_BYTES`
 *     对齐，免得"主进程放行、渲染端又拿超过上限挡回去"。要回到上游口径就传 16 * 1024 * 1024。
 */
export const EXCEL_LIMITS: ExcelLimits = {
  maxBytes: 32 * 1024 * 1024,
  maxCells: 250_000,
  timeoutMs: 15_000
}

/** 把调用方给的部分上限补成一份完整上限（显式的 `undefined` 不当覆盖，照缺省走） */
export function resolveLimits(overrides?: Partial<ExcelLimits>): ExcelLimits {
  const resolved: ExcelLimits = { ...EXCEL_LIMITS }
  for (const key of ['maxBytes', 'maxCells', 'timeoutMs'] as const) {
    const value = overrides?.[key]
    if (typeof value === 'number') resolved[key] = value
  }
  return resolved
}
