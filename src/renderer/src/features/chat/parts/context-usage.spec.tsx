import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { UsageThreadContext } from '@shared/usage'
import { ContextMeterGlyph } from './ContextMeterGlyph'
import { ContextUsagePanel } from './ContextUsagePanel'
import {
  breakdownRows,
  computeContextUsage,
  formatTokenValue,
  sessionStats,
  tokenStats,
  type ContextUsageData
} from './context-usage-model'

/**
 * task-107：上下文饼图 + Claude style 浮窗的单元契约。
 * 数据面口径（totals / composition）由 mastra usage.spec 覆盖；这里钉：
 *   1. 一个 hook（computeContextUsage）出全部数字；2. 饼图几何与警示色；
 *   3. 浮窗结构 / 延迟显示 / reduced；4. 拆不动时合并一行（不编两个数）。
 */
function contextOf(overrides: Partial<UsageThreadContext> = {}): UsageThreadContext {
  return {
    threadId: 't1',
    lastInput: 500_000,
    lastCachedInput: 375_000,
    baselineInput: 100_000,
    todayInput: 1_000_000,
    todayCachedInput: 750_000,
    totals: {
      rounds: 3,
      modelCalls: 7,
      input: 900_000,
      cachedInput: 675_000,
      uncachedInput: 225_000,
      output: 20_000,
      hitRate: 75
    },
    composition: { systemPrompt: 60_000, toolDefinitions: 40_000 },
    ...overrides
  }
}

function statsOf(overrides: Partial<UsageThreadContext> = {}): ContextUsageData {
  return computeContextUsage(contextOf(overrides), 500_000, 50)
}

describe('task-107 · 上下文口径（一处算）', () => {
  it('computeContextUsage：百分比 / 警示 / 基线分解 / 命中率 / totals 同源', () => {
    const stats = statsOf()
    expect(stats.usedPct).toBe(100)
    expect(stats.overThreshold).toBe(true)
    expect(stats.messageTokens).toBe(400_000)
    expect(stats.lastHitRate).toBe(75)
    expect(stats.todayHitRate).toBe(75)
    expect(stats.totals?.hitRate).toBe(75)
    expect(stats.composition).toEqual({ systemPrompt: 60_000, toolDefinitions: 40_000 })
  })

  it('breakdownRows：可拆 → 3 行；拆不动 → 合并 1 行（不编两个数）', () => {
    expect(breakdownRows(statsOf()).map((row) => row.label)).toEqual([
      '系统提示词',
      '工具定义',
      '对话消息'
    ])
    const merged = breakdownRows(statsOf({ composition: null }))
    expect(merged.map((row) => row.label)).toEqual(['系统提示词 + 工具定义', '对话消息'])
    expect(merged[0]?.tokens).toBe(100_000)
  })

  it('统计只放真实可得数：轮次 / 模型调用 / 平均输入输出；Token 四格数字', () => {
    const stats = statsOf()
    expect(sessionStats(stats)).toEqual([
      { label: '轮次', value: '3' },
      { label: '模型调用', value: '7' },
      { label: '平均每轮输入', value: '~300K' },
      { label: '平均每轮输出', value: '~6.7K' }
    ])
    expect(tokenStats(stats)).toEqual([
      { label: '缓存命中', value: '75%' },
      { label: '未缓存输入', value: '225Ktok' },
      { label: '缓存读取', value: '675Ktok' },
      { label: '输出', value: '20Ktok' }
    ])
    expect(formatTokenValue(0)).toBe('0')
    expect(formatTokenValue(999)).toBe('999')
  })

  it('没有总量数据 → 统计四格如实显示「—」（不假装 0）', () => {
    const empty = computeContextUsage(null, 500_000, 50)
    expect(sessionStats(empty).every((cell) => cell.value === '—')).toBe(true)
    expect(tokenStats(empty).every((cell) => cell.value === '—')).toBe(true)
  })
})

describe('task-107 · 饼图 + 浮窗', () => {
  it('饼图：percent 扇区 / 警示色 / data 属性；0% 只有底盘', () => {
    const { rerender } = render(<ContextMeterGlyph percent={4} warning={false} />)
    const pie = screen.getByTestId('context-pie')
    expect(pie).toHaveAttribute('data-percent', '4')
    expect(pie).not.toHaveAttribute('data-warning')
    expect(pie.querySelectorAll('path')).toHaveLength(1)

    rerender(<ContextMeterGlyph percent={120} warning />)
    expect(screen.getByTestId('context-pie')).toHaveAttribute('data-percent', '100')
    expect(screen.getByTestId('context-pie')).toHaveAttribute('data-warning', 'true')
    // 100% 用整圆（不再画扇区 path）
    expect(screen.getByTestId('context-pie').querySelectorAll('path')).toHaveLength(0)

    rerender(<ContextMeterGlyph percent={0} warning={false} />)
    expect(screen.getByTestId('context-pie').querySelectorAll('path')).toHaveLength(0)
  })

  it('浮窗结构：头行 / 分段条 / 图例 / 会话统计 / Token 用量；读数带延迟序号', () => {
    render(<ContextUsagePanel stats={statsOf()} loading={false} />)

    const panel = screen.getByTestId('context-panel')
    expect(panel).toHaveTextContent('上下文已用 100%')
    expect(panel).toHaveTextContent('~500K / 500K')
    expect(screen.getByTestId('context-composition')).toHaveTextContent('系统提示词')
    expect(screen.getByTestId('context-composition')).toHaveTextContent('~60K')
    expect(screen.getByTestId('context-composition')).toHaveTextContent('工具定义')
    expect(screen.getByTestId('context-composition')).toHaveTextContent('~40K')
    expect(screen.getByTestId('context-composition')).toHaveTextContent('对话消息')
    expect(screen.getByTestId('context-composition')).toHaveTextContent('~400K')

    expect(screen.getByTestId('context-session-stats')).toHaveTextContent('轮次')
    expect(screen.getByTestId('context-session-stats')).toHaveTextContent('模型调用')
    expect(screen.getByTestId('context-session-stats')).toHaveTextContent('平均每轮输入')
    expect(screen.getByTestId('context-session-stats')).toHaveTextContent('平均每轮输出')
    expect(screen.getByTestId('context-token-stats')).toHaveTextContent('缓存命中')
    expect(screen.getByTestId('context-token-stats')).toHaveTextContent('75%')
    expect(screen.getByTestId('context-token-stats')).toHaveTextContent('未缓存输入')
    expect(screen.getByTestId('context-token-stats')).toHaveTextContent('缓存读取')
    expect(screen.getByTestId('context-token-stats')).toHaveTextContent('输出')

    // 三段进度（composition 可拆）+ 图例值延迟序号
    expect(screen.getByTestId('context-seg-system')).toBeInTheDocument()
    expect(screen.getByTestId('context-seg-tools')).toBeInTheDocument()
    expect(screen.getByTestId('context-seg-messages')).toBeInTheDocument()
    expect(panel.querySelector('.ctx-num')?.getAttribute('style')).toContain('--i')
  })

  it('拆不动时只有两段（基线合并），浮窗不留「工具定义」独立行', () => {
    render(<ContextUsagePanel stats={statsOf({ composition: null })} loading={false} />)
    expect(screen.getByTestId('context-composition')).toHaveTextContent('系统提示词 + 工具定义')
    expect(screen.queryByTestId('context-seg-system')).not.toBeInTheDocument()
    expect(screen.queryByTestId('context-seg-tools')).not.toBeInTheDocument()
    expect(screen.getByTestId('context-seg-baseline')).toBeInTheDocument()
  })

  it('加载态：结构骨架先到（不闪假的 0%）', () => {
    render(<ContextUsagePanel stats={statsOf()} loading />)
    expect(screen.getByTestId('context-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('context-panel')).not.toBeInTheDocument()
    expect(screen.queryByText(/上下文已用/)).not.toBeInTheDocument()
  })

  it('CSS 契约：数字 150ms 起错峰淡入；reduced 直接显示', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/renderer/src/features/chat/parts/context-usage.css'),
      'utf8'
    )
    expect(css).toMatch(/@keyframes ctx-num-in/)
    expect(css).toMatch(/animation-delay: calc\(150ms \+ var\(--i, 0\) \* 18ms\)/)
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.ctx-num \{\s*animation: none;/
    )
    expect(css).toMatch(/:root\[data-motion='reduced'\] \.ctx-num \{\s*animation: none;/)
  })
})
