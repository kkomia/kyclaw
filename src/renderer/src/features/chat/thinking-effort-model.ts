/**
 * 思考强度（推理等级）百分比 ↔ 档位映射（task-70；task-78 按 dsh-claude-style 源码重做面板）。
 *
 * 产品口径：滑杆是**无极** 0–100%；底层仍写现有 `thinkingEffort` 设置（字符串档位）。
 * 映射：把 0–100 均分给当前模型的 N 档（`default/low/high/max` 这类，档位表来自
 * `thinkingEffortsOf`）——第 i 档占 `[i/N, (i+1)/N)`，100% 归最后一档。
 *
 * 例（N=4）：0–24 → default；25–49 → low；50–74 → high；75–100 → max。
 * N=1 时永远唯一档；N=0 时回退空字符串（调用方不渲染面板）。
 *
 * 文案英文化（用户 2026-10-18：「推理强度，显示英文，不要显示中文」）：
 * dsh-claude-style 源码里档位名来自 provider 的 effort name（英文），兜底 `Default`；
 * 这里按 id 映射英文（`src/shared/models.ts` 的中文 label 不动，其它地方仍在用）。
 *
 * apex 元素格布局/动画参数照抄 dsh-claude-style `lib/client.js` 的 T2/r()/n() 算法：
 * 26px 高的轨道里铺 5 行元素格，列数按宽度算；Max 档（75–100%）切到 apex 状态。
 */
import type { ThinkingEffortSpec } from '@shared/models'

/**
 * 面板文案集中常量（task-87：面板文案中文化，档位名保留英文）。
 * 用户口径：「推理等级几个字右边就有挡位」——标题/两端中文，档位仍是 Default/Low/High/Max。
 */
export const EFFORT_COPY = {
  /** 面板标题（中文；用户 2026-10-18 04:0x：「我们这个英文 还没改啊」） */
  title: '推理等级',
  /** 左端（更省/更快） */
  faster: '更快',
  /** 右端（更强） */
  smarter: '更强',
  /** 右上百分比后缀 */
  percent: '%',
  /** 档位英文名（用户此前明确：档位显示英文，不要中文） */
  tiers: {
    default: 'Default',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'XHigh',
    max: 'Max'
  }
} as const

/** 档位英文名（供应商 effort id → UI 文案；dsh-claude-style 用 provider name，兜底 Default） */
export const EFFORT_LABELS_EN: Readonly<Record<string, string>> = EFFORT_COPY.tiers

/** 当前档位的英文显示名；未知 id 用首字母大写兜底（再不行 Default） */
export function effortDisplayLabel(effortId: string | undefined | null): string {
  if (effortId === undefined || effortId === null || effortId === '') return 'Default'
  const mapped = EFFORT_LABELS_EN[effortId]
  if (mapped !== undefined) return mapped
  return effortId.charAt(0).toUpperCase() + effortId.slice(1)
}

/** 面板标题 / 两端文案（task-87 中文化；集中常量见上，档位名仍英文） */
export const EFFORT_LABEL_TEXT = EFFORT_COPY.title
export const EFFORT_FASTER_TEXT = EFFORT_COPY.faster
export const EFFORT_SMARTER_TEXT = EFFORT_COPY.smarter

/** 滑轨上的刻度位置（0/25/50/75/100 = 四档均分边界） */
export const EFFORT_TICK_PERCENTS = [0, 25, 50, 75, 100] as const

/** 进入 apex（Max 档 / 元素格盛放 + 紫色发光）的百分比阈值 */
export const EFFORT_APEX_PERCENT = 75

/** 是否进入 apex 状态（Max 档 = 75–100%） */
export function isApexPercent(percent: number): boolean {
  return percent >= EFFORT_APEX_PERCENT
}

/** 档位 → 百分比（该档位桶内的中位点；用于初始位置） */
export function percentForEffort(efforts: readonly ThinkingEffortSpec[], effortId: string): number {
  const count = efforts.length
  if (count === 0) return 0
  const index = Math.max(
    0,
    efforts.findIndex((effort) => effort.id === effortId)
  )
  if (count === 1) return 100
  return Math.round((index / (count - 1)) * 100)
}

/** 百分比 → 档位（均分桶；0–100 任意值都有结果，100% 归最后一档） */
export function effortForPercent(
  efforts: readonly ThinkingEffortSpec[],
  percent: number
): ThinkingEffortSpec | null {
  const count = efforts.length
  if (count === 0) return null
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0))
  const index = Math.min(count - 1, Math.floor((clamped / 100) * count))
  return efforts[index] ?? efforts[count - 1] ?? null
}

/** apex 元素格布局（移植 dsh-claude-style 的 r()；单位 CSS px，height=26、gap=1） */
export interface EffortMatrixLayout {
  cols: number
  rows: number
  sq: number
  gap: number
  padTop: number
  padBottom: number
  padLeft: number
  padRight: number
}

export function effortMatrixLayout(
  width: number,
  options: { height?: number; gap?: number } = {}
): EffortMatrixLayout {
  const height = options.height ?? 26
  const gap = options.gap ?? 1
  const pad = 1
  const sq = Math.max(3, Math.floor((height - 2 * pad - 4 * gap) / 5))
  const cols = Math.max(1, Math.floor((Math.max(1, width) + gap) / (sq + gap)))
  const leftover = Math.max(0, width - (cols * sq + (cols - 1) * gap))
  return {
    cols,
    rows: 5,
    sq,
    gap,
    padTop: Math.floor(leftover / 2),
    padBottom: leftover - Math.floor(leftover / 2),
    padLeft: Math.floor(leftover / 2),
    padRight: leftover - Math.floor(leftover / 2)
  }
}

/** 列方向强度曲线（移植 dsh 的 n()：左淡 → 右满，smoothstep） */
export function effortMatrixOpacity(columnFraction: number): number {
  const fraction = Math.min(1, Math.max(0, columnFraction))
  if (fraction <= 0.05) return 0
  if (fraction >= 0.75) return 1
  const t = (fraction - 0.05) / 0.7
  return t * t * (3 - 2 * t)
}

/** 元素格的 tone/动画参数（移植 dsh 的伪随机；period 单位秒，默认 1.45s 闪一次） */
export interface EffortMatrixCellStyle {
  tone: number
  opacity: number
  animationDelay: string
  animationDuration: string
}

export function effortMatrixCellStyle(
  row: number,
  col: number,
  cols: number,
  periodSeconds = 1.45
): EffortMatrixCellStyle {
  const fraction = cols > 1 ? col / (cols - 1) : 1
  // dsh 的伪随机：三组整数哈希，分别决定 tone / 延迟 / 时长
  const hash = (salt: number): number => {
    let value = (Math.imul(row + 1, 2654435761) ^ Math.imul(col + 1, 2246822507)) >>> 0
    value = (value ^ Math.imul(salt + 1, 668265263)) >>> 0
    value = Math.imul(value ^ (value >>> 15), 625341585) >>> 0
    value = (value ^ (value >>> 13)) >>> 0
    return value / 4294967296
  }
  return {
    tone: Math.floor(hash(1) * 8) % 8,
    opacity: effortMatrixOpacity(fraction),
    animationDelay: `${(hash(2) * periodSeconds * 0.95 + periodSeconds * 0.21).toFixed(3)}s`,
    animationDuration: `${(periodSeconds * (0.92 + hash(3) * 0.16)).toFixed(3)}s`
  }
}
