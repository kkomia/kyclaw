import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { UsageCalendar, UsageCalendarDay } from '@shared/usage'
import { WelcomeHeatmap } from '../parts/WelcomeHeatmap'

/**
 * task-127 · 首页日历热力图组件契约：
 *   - 53/54 × 7 网格（2026 年 53 周 × 7 = 371 格；366 天平年由 data-out 补齐）；
 *   - 色阶（有记录 > 0；空天 = 0）；空态 ghost grid + 文案；
 *   - hover 卡（portal）；年份切换重新取数；aria 汇总；reduced 静态 CSS。
 */
const NOW = new Date(2026, 9, 15, 12, 0, 0)

function day(date: string, input: number, output: number, runs = 1, steps = 1): UsageCalendarDay {
  return { date, input, output, cachedInput: 0, runs, steps }
}

function calendar(year: number, days: UsageCalendarDay[]): UsageCalendar {
  return {
    year,
    days,
    totalActiveDays: days.length,
    totalTokens: days.reduce((sum, item) => sum + item.input + item.output, 0)
  }
}

function renderHeatmap(
  loadCalendar: (year: number) => Promise<UsageCalendar>
): ReturnType<typeof render> {
  return render(<WelcomeHeatmap loadCalendar={loadCalendar} initialYear={2026} now={() => NOW} />)
}

describe('task-127 欢迎页日历热力图', () => {
  it('2026 年 53 周 × 7 天 = 371 格；平年 365 天在年内，其余 data-out 占位', async () => {
    renderHeatmap(async (year) => calendar(year, []))
    const grid = await screen.findByTestId('welcome-heatmap-grid')
    expect(grid).toHaveAttribute('data-weeks', '53')
    const all = grid.querySelectorAll('.welcome-heatmap-cell')
    expect(all).toHaveLength(371)
    const inYear = grid.querySelectorAll('[data-date]')
    expect(inYear).toHaveLength(365)
    expect(grid.querySelectorAll('[data-out="true"]')).toHaveLength(371 - 365)
  })

  it('色阶：有记录的天 level > 0、空天 0；图例 5 档；aria 汇总含活跃日/tokens', async () => {
    renderHeatmap(async (year) =>
      calendar(year, [
        day('2026-01-02', 10, 2, 2, 3),
        day('2026-02-03', 100, 20, 1, 1),
        day('2026-03-04', 500, 100, 4, 6),
        day('2026-05-06', 900, 200, 2, 2)
      ])
    )
    await waitFor(() => expect(screen.getByTestId('welcome-heatmap-stat')).toBeInTheDocument())
    const cells = screen.getByTestId('welcome-heatmap-grid').querySelectorAll('[data-date]')
    const levels = new Map(
      [...cells].map((cell) => [cell.getAttribute('data-date'), cell.getAttribute('data-level')])
    )
    expect(levels.get('2026-01-02')).not.toBe('0')
    expect(levels.get('2026-05-06')).toBe('4')
    expect(levels.get('2026-01-03')).toBe('0')
    expect(cells[0]?.closest('.welcome-heatmap')).toBeTruthy()
    const section = screen.getByTestId('welcome-heatmap')
    expect(section.getAttribute('aria-label')).toContain('4 个活跃日')
    expect(section.getAttribute('aria-label')).toContain('1,832') // 12+120+600+1100
    const legend = document.querySelectorAll('.welcome-heatmap-legend i')
    expect(legend).toHaveLength(5)
  })

  it('空态：ghost grid 仍 371 格 + 一行文案；aria 说明还没有本地活动', async () => {
    renderHeatmap(async (year) => calendar(year, []))
    await waitFor(() => expect(screen.getByTestId('welcome-heatmap-empty')).toBeInTheDocument())
    expect(screen.getByText('这一年还没有本地活动')).toBeInTheDocument()
    expect(
      screen.getByTestId('welcome-heatmap-grid').querySelectorAll('.welcome-heatmap-cell')
    ).toHaveLength(371)
    expect(screen.getByTestId('welcome-heatmap').getAttribute('aria-label')).toContain(
      '还没有本地活动'
    )
  })

  it('hover 卡：mouseenter 出现日期/tokens/轮次，mouseleave 消失（portal 到 body）', async () => {
    renderHeatmap(async (year) => calendar(year, [day('2026-03-04', 500, 100, 4, 6)]))
    await waitFor(() => expect(screen.getByTestId('welcome-heatmap-stat')).toBeInTheDocument())
    const cell = screen
      .getByTestId('welcome-heatmap-grid')
      .querySelector('[data-date="2026-03-04"]')
    expect(cell).not.toBeNull()
    fireEvent.mouseEnter(cell as Element)
    const tip = await screen.findByTestId('welcome-heatmap-tip')
    expect(tip).toHaveTextContent('2026 年 3 月 4 日')
    expect(tip).toHaveTextContent('600')
    expect(tip).toHaveTextContent('4 轮对话')
    fireEvent.mouseLeave(cell as Element)
    await waitFor(() => expect(screen.queryByTestId('welcome-heatmap-tip')).not.toBeInTheDocument())
  })

  it('年份切换：‹ 用前一年重新取数；到当前年后 › 禁用', async () => {
    const load = vi.fn(async (year: number) =>
      year === 2025 ? calendar(2025, [day('2025-12-31', 5, 5, 1, 1)]) : calendar(year, [])
    )
    renderHeatmap(load)
    await waitFor(() => expect(screen.getByTestId('welcome-heatmap-empty')).toBeInTheDocument())
    expect(screen.getByTestId('welcome-heatmap-next')).toBeDisabled()
    fireEvent.click(screen.getByTestId('welcome-heatmap-prev'))
    await waitFor(() =>
      expect(screen.getByTestId('welcome-heatmap-year')).toHaveTextContent('2025')
    )
    expect(load).toHaveBeenCalledWith(2025)
    await waitFor(() =>
      expect(screen.getByTestId('welcome-heatmap-stat')).toHaveTextContent('2025')
    )
    expect(screen.getByTestId('welcome-heatmap-next')).toBeEnabled()
  })

  it('年导航键盘：←/→ 直接换年；nav 的 aria-label 带当前年、年份 aria-live', async () => {
    const load = vi.fn(async (year: number) => calendar(year, []))
    renderHeatmap(load)
    await waitFor(() => expect(screen.getByTestId('welcome-heatmap-empty')).toBeInTheDocument())
    const nav = screen.getByTestId('welcome-heatmap-year-nav')
    expect(nav).toHaveAttribute('role', 'group')
    expect(nav.getAttribute('aria-label')).toContain('2026')
    expect(screen.getByTestId('welcome-heatmap-year')).toHaveAttribute('aria-live', 'polite')

    fireEvent.keyDown(nav, { key: 'ArrowLeft' })
    await waitFor(() =>
      expect(screen.getByTestId('welcome-heatmap-year')).toHaveTextContent('2025')
    )
    expect(load).toHaveBeenCalledWith(2025)
    expect(nav.getAttribute('aria-label')).toContain('2025')

    fireEvent.keyDown(nav, { key: 'ArrowRight' })
    await waitFor(() =>
      expect(screen.getByTestId('welcome-heatmap-year')).toHaveTextContent('2026')
    )
  })

  it('数据不足：只显示 ghost 网格；有记录但起始较晚 → 统计带「从 … 开始记录」', async () => {
    renderHeatmap(async (year) => calendar(year, [day('2026-10-17', 5, 5, 1, 1)]))
    await waitFor(() => expect(screen.getByTestId('welcome-heatmap-stat')).toBeInTheDocument())
    expect(screen.getByTestId('welcome-heatmap-stat')).toHaveTextContent('从 2026-10-17 开始记录')
  })

  it('CSS 契约：暖色阶、2px 圆角/3px gap、reduced 静态、矮窗压缩/隐藏、focus 可见', () => {
    const css = readFileSync(join(__dirname, '../parts/welcome-heatmap.css'), 'utf8')
    expect(css).toContain('color-mix(in srgb, var(--accent-text) 22%, transparent)')
    expect(css).toContain('color-mix(in srgb, var(--accent-text) 88%, transparent)')
    expect(css).toContain('--hm-radius: 2px')
    expect(css).toContain('--hm-gap: 3px')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('transform: none')
    // 矮窗：760 以下收副题+底部统计，620 以下整块隐藏（输入卡不被挤）
    expect(css).toMatch(
      /@media \(max-height: 759px\)[\s\S]*?\.welcome-heatmap-sub[\s\S]*?display: none/
    )
    expect(css).toMatch(
      /@media \(max-height: 619px\)[\s\S]*?\.welcome-heatmap[\s\S]*?display: none/
    )
    // 年按钮键盘 focus 可见
    expect(css).toContain('outline: 2px solid var(--accent-text)')
  })
})
