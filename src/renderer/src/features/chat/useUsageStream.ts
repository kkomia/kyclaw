/**
 * PB-033 `data-usage` 消费（纯解析 + React hook）。
 *
 * 契约（Bao）：chat SSE 的 UI message part
 *   `{type:'data-usage', data:{stepIndex, inputTokens, outputTokens, totalTokens, cachedInputTokens, contextInput}}`
 * 规则：
 *   ① 只消费 data-usage，**不自己算 token**（禁止估算）；
 *   ② 一条都没有 → `latest.reported=false`，UI 显示「—」（不显示 0 / 不清环）；
 *   ③ 不写库、不碰 totals（纯内存态）；
 *   ④ 同一 stepIndex 只保留最新一条（后到覆盖先到），steps 按 stepIndex 升序。
 */
import { useMemo } from 'react'

export interface UsageStep {
  stepIndex: number
  input: number
  output: number
  total: number | null
  cached: number | null
  contextInput: number | null
}

export interface UsageLatest {
  input: number | null
  output: number | null
  total: number | null
  cached: number | null
  contextInput: number | null
  reported: boolean
}

export interface UsageStreamState {
  steps: UsageStep[]
  latest: UsageLatest
}

const EMPTY_LATEST: UsageLatest = {
  input: null,
  output: null,
  total: null,
  cached: null,
  contextInput: null,
  reported: false
}

interface DataUsagePart {
  type: 'data-usage'
  data: {
    stepIndex?: unknown
    inputTokens?: unknown
    outputTokens?: unknown
    totalTokens?: unknown
    cachedInputTokens?: unknown
    contextInput?: unknown
  }
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const nullableNumber = (value: unknown): number | null => (isNumber(value) ? value : null)

/** 纯函数：把 parts 里所有 data-usage 解析成 steps/latest（可在 hook 外复用于测试） */
export function collectUsage(parts: readonly unknown[]): UsageStreamState {
  const byStep = new Map<number, UsageStep>()
  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue
    const candidate = part as Partial<DataUsagePart>
    if (candidate.type !== 'data-usage') continue
    const data = candidate.data
    if (data === null || typeof data !== 'object') continue
    const stepIndex = data.stepIndex
    if (!isNumber(stepIndex)) continue
    if (!isNumber(data.inputTokens) || !isNumber(data.outputTokens)) continue
    // 同一 step 只保留最新一条（Map.set 覆盖）
    byStep.set(stepIndex, {
      stepIndex,
      input: data.inputTokens,
      output: data.outputTokens,
      total: nullableNumber(data.totalTokens),
      cached: nullableNumber(data.cachedInputTokens),
      contextInput: nullableNumber(data.contextInput)
    })
  }

  const steps = [...byStep.values()].sort((a, b) => a.stepIndex - b.stepIndex)
  const last = steps[steps.length - 1]
  const latest: UsageLatest =
    last === undefined
      ? EMPTY_LATEST
      : {
          input: last.input,
          output: last.output,
          total: last.total,
          cached: last.cached,
          contextInput: last.contextInput,
          reported: true
        }
  return { steps, latest }
}

/** 渲染端 hook：从消息 parts 读实时用量（不节流 setState，调用方只在渲染期用 useMemo 派生） */
export function useUsageStream(parts: readonly unknown[]): UsageStreamState {
  return useMemo(() => collectUsage(parts), [parts])
}
