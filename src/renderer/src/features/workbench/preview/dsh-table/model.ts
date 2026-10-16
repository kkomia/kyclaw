/**
 * 展示数据形状、资源上限与单元格收尾（不依赖 React、不依赖宿主）。
 *
 * 移植自 DeepSeek Harness（MIT）`packages/client/ui-sidebar-documentpreview/src/client/excel/model.ts`
 * 与 `src/config.ts` 的 `excel` 段；出处与许可见同目录 `NOTICE.md`。
 * 与上游的差异只在**上限的默认值来源**（上游由 cordis 配置注入，这里给一份缺省常量，见下）。
 */
import {
  update as formatNumber,
  type Cell,
  type Sheet,
  type SheetConfig
} from '@fortune-sheet/core'

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

/** XLSX 里认得出来、但本预览**不显示**的内容（顺序稳定，界面按这个顺序说） */
export const EXCEL_UNSUPPORTED_FEATURES = [
  'charts',
  'images',
  'shapes',
  'conditionalFormatting'
] as const

/** 本预览不显示的一类内容 */
export type ExcelUnsupportedFeature = (typeof EXCEL_UNSUPPORTED_FEATURES)[number]

/** 解析结果：展示用的工作表 + 缺公式结果的格数 + 认出来但不显示的内容 */
export interface ExcelPreview {
  sheets: Sheet[]
  missingResults: number
  unsupportedFeatures: ExcelUnsupportedFeature[]
}

/**
 * 激活工作表时的初始选区（含 A1 上的合并块，选中的是可寻址的范围）。
 * @param config 工作表版面（只用 `merge`）
 * @returns 初始选区
 */
export function initialSelection(
  config: SheetConfig
): NonNullable<Sheet['luckysheet_select_save']> {
  const merge = config.merge?.['0_0']
  return [
    {
      row: [0, (merge?.rs ?? 1) - 1],
      column: [0, (merge?.cs ?? 1) - 1],
      row_focus: 0,
      column_focus: 0
    }
  ]
}

/**
 * 补上数字格式与缺省对齐（**不重算公式**）。
 * @param cell 待收尾的展示格（就地改）
 * @param numberFormat Excel 的数字格式串
 * @returns 同一个格（已带 `m` 展示文本与 `ct` 类型）
 */
export function formatCell(cell: Cell, numberFormat: string): Cell {
  if (cell.ht === undefined) {
    cell.ht = typeof cell.v === 'number' ? 2 : typeof cell.v === 'boolean' ? 0 : 1
  }
  if (cell.ct === undefined) {
    cell.ct = {
      fa: numberFormat,
      t: typeof cell.v === 'number' ? 'n' : typeof cell.v === 'boolean' ? 'b' : 's'
    }
  }
  const formatted =
    typeof cell.v === 'number' ? (formatNumber(numberFormat, cell.v) as string | number) : cell.v
  cell.m = formatted === undefined ? '' : String(formatted)
  return cell
}
