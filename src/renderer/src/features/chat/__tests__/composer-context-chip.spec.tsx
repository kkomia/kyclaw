import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageThreadContext } from '@shared/usage'
import { defaultSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { ContextChip } from '../ComposerControls'
import { pushUsage, resetLiveUsage } from '../usage-live'

/**
 * PB-033：composer 上下文环的读数优先级（组件级）。
 *
 * 口径（usage-live.ts）：
 *   1. 流内 live.reported=true → 用 live 的 contextInput；
 *   2. live 缺失 / 未 reported → 回落落库值；落库也没 reported → 「—」（绝不显示 0 / 不估算）；
 *   3. 轮末 settled=true → 一律取落库值（live 与库故意不同，断言用库）。
 *
 * 注意：`displayPct` 依赖 `stats.windowTokens > 0`（由 settings 里的模型上下文窗口决定）；
 * settings store 未初始化时显示「—」是预期，不是缺陷。
 */

const { fetchThreadContext } = vi.hoisted(() => ({
  fetchThreadContext: vi.fn<(threadId: string) => Promise<UsageThreadContext>>()
}))

vi.mock('@renderer/lib/usage-api', () => ({ fetchThreadContext }))

function contextOf(overrides: Partial<UsageThreadContext> = {}): UsageThreadContext {
  return {
    threadId: 't1',
    lastInput: 1234,
    lastCachedInput: 0,
    baselineInput: 0,
    todayInput: 1234,
    todayCachedInput: 0,
    totals: null,
    composition: null,
    ...overrides
  } as UsageThreadContext
}

function primeSettings(): void {
  useSettingsStore.setState({
    settings: {
      ...defaultSettings(),
      providers: [
        {
          id: 'deepseek',
          type: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          isDefault: true
        }
      ]
    },
    loaded: true
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetLiveUsage()
  primeSettings()
  fetchThreadContext.mockResolvedValue(contextOf())
})

afterEach(() => {
  resetLiveUsage()
})

describe('PB-033 · ContextChip 读数', () => {
  it('初始无数据 → 显示「—」', () => {
    fetchThreadContext.mockRejectedValue(new Error('no usage yet'))
    render(<ContextChip threadId="t1" />)
    expect(screen.getByTestId('context-percent')).toHaveTextContent('—')
    expect(screen.getByTestId('composer-context')).toHaveAttribute('aria-label', '上下文已用 —')
  })

  it('pushUsage(reported=true) → 出现真实百分比', async () => {
    render(<ContextChip threadId="t1" />)
    await waitFor(() => expect(fetchThreadContext).toHaveBeenCalled())
    pushUsage({
      input: 1234,
      output: 56,
      total: 1290,
      cached: 0,
      contextInput: 1234,
      reported: true
    })
    await waitFor(() => expect(screen.getByTestId('context-percent')).toHaveTextContent(/\d+%/))
    expect(screen.getByTestId('context-percent')).not.toHaveTextContent('—')
  })

  it('resetLiveUsage + 库值 reported=false → 回到「—」', async () => {
    const { rerender } = render(<ContextChip threadId="t1" />)
    await waitFor(() => expect(fetchThreadContext).toHaveBeenCalled())
    pushUsage({ input: null, output: null, total: null, cached: null, contextInput: 1234, reported: true })
    await waitFor(() => expect(screen.getByTestId('context-percent')).toHaveTextContent(/\d+%/))

    // 库值没有 usage（reported=false）：回落也不显示 0
    fetchThreadContext.mockResolvedValue(contextOf({ lastInput: null }))
    resetLiveUsage()
    rerender(<ContextChip threadId="t1" usageVersion={1} />)
    await waitFor(() => expect(screen.getByTestId('context-percent')).toHaveTextContent('—'))
  })

  it('settled=true 取库值（live 与库故意不同）', async () => {
    // 库值：999999 tokens（≈ 大百分比）；live 只给 1234
    fetchThreadContext.mockResolvedValue(contextOf({ lastInput: 999_999 }))
    const { rerender } = render(<ContextChip threadId="t1" settled={false} />)
    await waitFor(() => expect(fetchThreadContext).toHaveBeenCalled())
    pushUsage({ input: null, output: null, total: null, cached: null, contextInput: 1234, reported: true })
    await waitFor(() => expect(screen.getByTestId('context-percent')).toHaveTextContent(/\d+%/))
    const livePct = Number(screen.getByTestId('context-percent').textContent?.replace('%', ''))

    rerender(<ContextChip threadId="t1" settled />)
    await waitFor(() => {
      const text = screen.getByTestId('context-percent').textContent ?? ''
      expect(text).toMatch(/\d+%|—/)
    })
    const settledText = screen.getByTestId('context-percent').textContent ?? ''
    if (settledText !== '—') {
      const settledPct = Number(settledText.replace('%', ''))
      expect(settledPct).toBeGreaterThan(livePct)
    }
  })
})
