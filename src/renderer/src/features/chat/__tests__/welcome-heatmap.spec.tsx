import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FeatureDisabledError } from '@renderer/lib/feature-disabled'
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

  it('标题/副题整块删除；网格、统计、图例、年份切换仍在', async () => {
    renderHeatmap(async (year) => calendar(year, [day('2026-03-04', 500, 100, 4, 6)]))
    await waitFor(() => expect(screen.getByTestId('welcome-heatmap-stat')).toBeInTheDocument())

    // 用户口径：首页热力图上方「本地活动」+「近一年 · 数据不出这台机器」整块删掉
    expect(screen.queryByRole('heading', { name: '本地活动' })).not.toBeInTheDocument()
    expect(screen.queryByText('本地活动')).not.toBeInTheDocument()
    expect(screen.queryByText('近一年 · 数据不出这台机器')).not.toBeInTheDocument()

    // 保留下来的读数
    expect(screen.getByTestId('welcome-heatmap-grid')).toBeInTheDocument()
    expect(screen.getByTestId('welcome-heatmap-stat')).toHaveTextContent('1 个活跃日')
    expect(screen.getByTestId('welcome-heatmap-year-nav')).toBeInTheDocument()
    expect(screen.getByTestId('welcome-heatmap-year')).toHaveTextContent('2026')
    expect(document.querySelectorAll('.welcome-heatmap-legend i')).toHaveLength(5)
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

  it('hover 首行（jsdom 零矩形）：用标题行轻量读数，不弹浮卡、不遮网格', async () => {
    renderHeatmap(async (year) => calendar(year, [day('2026-03-04', 500, 100, 4, 6)]))
    await waitFor(() => expect(screen.getByTestId('welcome-heatmap-stat')).toBeInTheDocument())
    const cell = screen
      .getByTestId('welcome-heatmap-grid')
      .querySelector('[data-date="2026-03-04"]')
    expect(cell).not.toBeNull()
    fireEvent.mouseEnter(cell as Element)
    const inline = await screen.findByTestId('welcome-heatmap-inline')
    expect(inline).toHaveTextContent('03-04')
    expect(inline).toHaveTextContent('600')
    expect(inline).toHaveTextContent('4 轮')
    expect(screen.queryByTestId('welcome-heatmap-tip')).not.toBeInTheDocument()
    fireEvent.mouseLeave(cell as Element)
    await waitFor(() =>
      expect(screen.queryByTestId('welcome-heatmap-inline')).not.toBeInTheDocument()
    )
    // 标题/副题已删；离开首行 hover 后只剩年份行
    expect(screen.queryByText('近一年 · 数据不出这台机器')).not.toBeInTheDocument()
    expect(screen.getByTestId('welcome-heatmap-year')).toBeInTheDocument()
  })

  it('hover 非首行：浮卡（portal）出现日期/tokens/轮次，移出消失', async () => {
    renderHeatmap(async (year) => calendar(year, [day('2026-03-04', 500, 100, 4, 6)]))
    await waitFor(() => expect(screen.getByTestId('welcome-heatmap-stat')).toBeInTheDocument())
    const section = screen.getByTestId('welcome-heatmap')
    const cell = section
      .querySelector('[data-testid="welcome-heatmap-grid"]')
      ?.querySelector('[data-date="2026-03-04"]')
    expect(cell).not.toBeNull()
    const rect = (overrides: Partial<DOMRect>): DOMRect =>
      ({
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        top: 0,
        left: 0,
        right: 10,
        bottom: 10,
        toJSON: () => ({}),
        ...overrides
      }) as DOMRect
    Object.defineProperty(section, 'getBoundingClientRect', {
      value: () => rect({ top: 200, left: 400, right: 1300, width: 900, height: 300, bottom: 500 })
    })
    Object.defineProperty(cell as Element, 'getBoundingClientRect', {
      value: () => rect({ top: 400, left: 500, right: 515, width: 15, height: 15, bottom: 415 })
    })
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

  /**
   * 0.2.1（PB-053 泛化）：/api/usage/calendar 是 0.2.0 起**主动下架**（501）→
   * 热力图只给中性说明，不画「本地活动读取失败」红字、不给永远失败的重试。
   */
  it('本版下架（501）：中性说明，不报错、不重试', async () => {
    renderHeatmap(async () => {
      throw new FeatureDisabledError('usage')
    })
    expect(await screen.findByTestId('welcome-heatmap-unavailable')).toHaveTextContent(
      '本版暂不可用（0.2.x 恢复）'
    )
    expect(screen.queryByTestId('welcome-heatmap-error')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument()
    // 网格照出（不闪空/不塌布局）
    expect(screen.getByTestId('welcome-heatmap-grid')).toBeInTheDocument()
  })

  it('普通读取失败：仍是错误行 + 重试（下架降级不吞真实失败）', async () => {
    renderHeatmap(async () => {
      throw new Error('服务返回 500')
    })
    expect(await screen.findByTestId('welcome-heatmap-error')).toHaveTextContent('服务返回 500')
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('CSS 契约：暖色阶、2px 圆角/3px gap、reduced 静态、矮窗压缩/隐藏、focus 可见', () => {
    const css = readFileSync(join(__dirname, '../parts/welcome-heatmap.css'), 'utf8')
    expect(css).toContain('color-mix(in srgb, var(--accent-text) 22%, transparent)')
    expect(css).toContain('color-mix(in srgb, var(--accent-text) 88%, transparent)')
    expect(css).toContain('--hm-radius: 2px')
    expect(css).toContain('--hm-gap: 3px')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('transform: none')
    // 矮窗：760 以下收底部统计/图例，620 以下整块隐藏（输入卡不被挤）；620–759（含实测 660）同一压缩档
    expect(css).toMatch(
      /@media \(max-height: 759px\)[\s\S]*?\.welcome-heatmap-foot[\s\S]*?display: none/
    )
    expect(css).toMatch(
      /@media \(max-height: 619px\)[\s\S]*?\.welcome-heatmap[\s\S]*?display: none/
    )
    expect(css).toContain('含实测 660')
    // 标题/副题样式已随 DOM 一起删除（防回潮）
    expect(css).not.toContain('.welcome-heatmap-sub')
    expect(css).not.toContain('.welcome-heatmap-title')
    // 首行 hover 的轻量读数（不挡网格/图例）
    expect(css).toContain('.welcome-heatmap-inline')
    expect(css).toContain('text-overflow: ellipsis')
    // 年按钮键盘 focus 可见
    expect(css).toContain('outline: 2px solid var(--accent-text)')
  })
})
