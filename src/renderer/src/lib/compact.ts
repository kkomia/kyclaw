/**
 * 渲染端压缩口径（round 19）：阈值换算与自动触发判定。
 *
 * 阈值 = 当前默认模型 × 对话长度（modelPrefs.contextPct，缺省 100%）× 上下文长度 ——
 * 与 ModelChip 上下文环的分母同一处 `contextTokensFor`，环变警示色的那一刻正是自动压缩的触发点。
 * round 22：上下文长度取 **probed 实测优先**（settings.probedModels，`<providerId>:<model>` 键）。
 */
import { contextTokensFor, probedKeyOf } from '@shared/models'
import type { AppSettings } from '@shared/settings'

/**
 * 阈值的**依赖面**（round 62）：换算只用得上这三块 —— 默认模型来自 providers，上下文长度来自
 * modelPrefs（用户挡位）与 probedModels（实测）。把它单独标出来，调用方就能只依赖这三块
 * （比如输入卡的 `/` 浮窗：任何别的设置变更都不该白拉一次用量）。
 */
export type ThresholdSettings = Pick<AppSettings, 'providers' | 'modelPrefs' | 'probedModels'>

/** 当前设置下"超阈值"的 token 数（没有 provider → null，不触发也不显示使用率） */
export function thresholdTokensOf(settings: ThresholdSettings): number | null {
  const provider = settings.providers.find((item) => item.isDefault) ?? settings.providers[0]
  if (provider === undefined) return null
  const probed = settings.probedModels[probedKeyOf(provider.id, provider.model)]
  const pct = settings.modelPrefs[`${provider.id}/${provider.model}`]?.contextPct
  return contextTokensFor(provider.model, pct, probed)
}

/** 最近一轮输入 → 使用率（0–100 的整数；阈值判不出来时返回 null） */
export function usagePercentOf(
  usedInput: number | null,
  thresholdTokens: number | null
): number | null {
  if (usedInput === null || thresholdTokens === null || thresholdTokens <= 0) return null
  return Math.min(100, Math.round((usedInput / thresholdTokens) * 100))
}

/**
 * round 57：「压缩上下文」作曲栏按钮的出现线 —— 上下文用量 ≥ 80% 时出现。
 * 口径与环同一份 `usedPct`（最近一轮 `lastInput` / `thresholdTokensOf(...)`，四舍五入、封顶 100）；
 * 对齐 Kimi Code 桌面版的那枚 chip（`pct >= 80` 才 `ir`）。取不到数据时 `usedPct = 0`，自然不出现。
 */
export const COMPACT_CHIP_PCT = 80

/** 自动压缩触发条件：最近一轮用量 ≥ 阈值（用量/阈值取不到时不触发） */
export function shouldCompact(
  lastInput: number | null | undefined,
  thresholdTokens: number | null
): boolean {
  return thresholdTokens !== null && typeof lastInput === 'number' && lastInput >= thresholdTokens
}
