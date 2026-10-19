/**
 * PB-033 活数据 store（模块级，绕开 ChatPage）：流内 `data-usage` 的最新值存这里，
 * 供 composer 读数优先使用。规则：
 *   - `reported=false`（没有 usage）→ UI 显示「—」，绝不显示 0 / 不估算；
 *   - 优先 live；live 缺失或未 reported 时回落 `/api/usage/context` 落库值；
 *   - 轮末对账由调用方做一次：live 与库不一致时**以库为准**（`resolveUsageReadout` 传 `settled=true`）。
 */
import { useSyncExternalStore } from 'react'
import type { UsageLatest } from './useUsageStream'

export interface UsageReadout {
  contextInput: number | null
  reported: boolean
  source: 'live' | 'stored'
}

const EMPTY: UsageLatest = {
  input: null,
  output: null,
  total: null,
  cached: null,
  contextInput: null,
  reported: false
}

let live: UsageLatest = EMPTY
const listeners = new Set<() => void>()

export function pushUsage(next: UsageLatest): void {
  live = next
  for (const listener of listeners) listener()
}

export function getLiveUsage(): UsageLatest {
  return live
}

export function resetLiveUsage(): void {
  live = EMPTY
  for (const listener of listeners) listener()
}

export function subscribeUsage(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLiveUsage(): UsageLatest {
  return useSyncExternalStore(subscribeUsage, getLiveUsage, getLiveUsage)
}

/**
 * 读数优先级：轮末（settled=true）一律用库值；流内优先 live（reported=true 时），否则回落库值。
 * `reported=false` 时 contextInput 必须为 null（UI 显示「—」）。
 */
export function resolveUsageReadout(input: {
  live: UsageLatest
  stored: { contextInput: number | null; reported: boolean } | null
  settled: boolean
}): UsageReadout {
  const stored = input.stored
  if (input.settled) {
    if (stored === null || !stored.reported) return { contextInput: null, reported: false, source: 'stored' }
    return { contextInput: stored.contextInput, reported: true, source: 'stored' }
  }
  if (input.live.reported) {
    return { contextInput: input.live.contextInput, reported: true, source: 'live' }
  }
  if (stored !== null && stored.reported) {
    return { contextInput: stored.contextInput, reported: true, source: 'stored' }
  }
  return { contextInput: null, reported: false, source: 'stored' }
}
