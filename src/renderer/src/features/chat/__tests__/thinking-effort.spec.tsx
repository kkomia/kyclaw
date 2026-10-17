import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultMotionSettings, defaultSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { ThinkingEffort } from '../ThinkingEffort'

const EFFORTS = [
  { id: 'default', label: '默认' },
  { id: 'low', label: '低' },
  { id: 'high', label: '高' },
  { id: 'max', label: '最高' }
]

const PANEL_CSS = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/features/chat/thinking-effort.css'),
  'utf8'
)

function mount(effortId = 'default'): ReturnType<typeof vi.fn> {
  const onSelect = vi.fn()
  render(<ThinkingEffort efforts={EFFORTS} effortId={effortId} onSelect={onSelect} />)
  return onSelect
}

function setMotionReduced(): void {
  useSettingsStore.setState({
    settings: { ...defaultSettings(), motion: { ...defaultMotionSettings(), mode: 'reduced' } },
    loaded: true
  })
}

afterEach(() => {
  cleanup()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
})

describe('ThinkingEffort v2（task-78 · 照抄 dsh-claude-style）', () => {
  it('触发器英文档位；面板 = 推理等级 + 更快/更强，且没有重复的中文档位行', () => {
    mount('high')
    const trigger = screen.getByTestId('composer-effort')
    expect(trigger).toHaveTextContent('High')
    expect(trigger).not.toHaveTextContent('高')
    expect(trigger).toHaveAttribute('aria-label', '推理等级: High')

    fireEvent.click(trigger)
    const panel = screen.getByTestId('composer-effort-panel')
    expect(panel).toHaveTextContent('推理等级')
    expect(panel).toHaveTextContent('更快')
    expect(panel).toHaveTextContent('更强')
    expect(screen.getByTestId('effort-current-label')).toHaveTextContent('High')
    expect(screen.getByTestId('effort-percent')).toHaveTextContent('67%')

    // 用户反馈：滑杆下方那排「默认/低/高/最高」删掉（与标题右侧重复）
    expect(screen.queryByTestId('effort-tier-high')).not.toBeInTheDocument()
    expect(panel.querySelectorAll('[data-testid^="effort-tier-"]')).toHaveLength(0)
    expect(panel.querySelectorAll('button')).toHaveLength(0)
  })

  it('滑杆：英文 aria、0/25/50/75/100 映射档位并回调写回', () => {
    const onSelect = mount('default')
    fireEvent.click(screen.getByTestId('composer-effort'))
    const slider = screen.getByTestId('effort-slider')

    expect(screen.getByRole('slider', { name: '推理等级' })).toBe(slider)
    expect(slider).toHaveAttribute('aria-valuetext', 'Default (0%)')

    const cases: Array<[number, string]> = [
      [24, 'default'],
      [25, 'low'],
      [49, 'low'],
      [50, 'high'],
      [74, 'high'],
      [75, 'max'],
      [100, 'max']
    ]
    for (const [percent] of cases) {
      fireEvent.change(slider, { target: { value: String(percent) } })
      expect((slider as HTMLInputElement).value).toBe(String(percent))
    }
    // 只在档位真正切换时回调：default → low → high → max（同档内拖动不重复写回）
    expect(onSelect.mock.calls.map((call) => call[0])).toEqual(['low', 'high', 'max'])
    // 100% → Max 档（英文）+ 百分比同步
    fireEvent.change(slider, { target: { value: '100' } })
    expect(screen.getByTestId('effort-current-label')).toHaveTextContent('Max')
    expect(screen.getByTestId('effort-percent')).toHaveTextContent('100%')
    expect(slider).toHaveAttribute('aria-valuetext', 'Max (100%)')
  })

  it('元素格常驻（不拖动也有）：面板一打开就有矩阵 + 闪烁参数，左暗右亮梯度', () => {
    mount('default')
    fireEvent.click(screen.getByTestId('composer-effort'))

    const surface = screen.getByTestId('effort-slider-surface')
    expect(surface).not.toHaveAttribute('data-apex')
    // task-84：矩阵常驻（不再只在 Max 档/拖动时出现）
    const matrix = screen.getByTestId('effort-matrix')
    const cells = matrix.querySelectorAll('.thinking-effort-matrix-sq')
    expect(cells.length).toBeGreaterThan(5)
    // 每格都有低频闪烁的动画时长/延迟（CSS 承接，非拖动才播）
    expect((cells[0] as HTMLElement).style.animationDuration).not.toBe('')
    expect((cells[cells.length - 1] as HTMLElement).style.animationDelay).not.toBe('')

    // task-88：梯度暴露在 data-opacity + CSS 变量上（不再写 inline opacity，动画覆盖不到）
    const opacityOf = (el: Element): number =>
      Number.parseFloat((el as HTMLElement).dataset.opacity ?? 'NaN')
    const varOf = (el: Element): string =>
      (el as HTMLElement).style.getPropertyValue('--effort-cell-opacity')
    expect((cells[0] as HTMLElement).style.opacity).toBe('')
    expect(varOf(cells[0])).not.toBe('')
    expect(varOf(cells[0])).toBe(Number.parseFloat(varOf(cells[0])).toFixed(3))

    // 亮度梯度：最右列明显大于最左列（越靠右越亮）
    const first = opacityOf(cells[0])
    const last = opacityOf(cells[cells.length - 1])
    expect(first).toBeLessThan(0.1)
    expect(last).toBe(1)
    expect(last).toBeGreaterThan(first)
    // task-87：**纯横向**梯度——同一列内所有行亮度一致（不能有纵向成分）
    const grid = matrix.style.gridTemplateColumns
    const match = /^repeat\((\d+), 1fr\)$/.exec(grid)
    expect(match).not.toBeNull()
    const cols = Number(match?.[1])
    const rows = 5
    for (const col of [0, Math.floor(cols / 2), cols - 1]) {
      const columnOpacities = Array.from({ length: rows }, (_, row) =>
        opacityOf(cells[row * cols + col])
      )
      // 同列各行完全一致（浮点同源，直接相等）
      expect(new Set(columnOpacities).size).toBe(1)
    }
    // 同一行内：右端（最后一列）比左端（第一列）亮
    const row0Left = opacityOf(cells[0])
    const row0Right = opacityOf(cells[cols - 1])
    expect(row0Right).toBeGreaterThan(row0Left)
  })

  it('Max 档 apex：同一份常驻矩阵切紫色 + 滑钮辉光状态', () => {
    mount('max')
    fireEvent.click(screen.getByTestId('composer-effort'))

    expect(screen.getByTestId('effort-slider-surface')).toHaveAttribute('data-apex')
    const matrix = screen.getByTestId('effort-matrix')
    expect(matrix).toHaveClass('thinking-effort-matrix')
    // 单元格数 = 5 行 × 列数（按轨道宽算，jsdom 兜底 264 → 至少一屏）
    expect(matrix.querySelectorAll('.thinking-effort-matrix-sq').length).toBeGreaterThan(5)
    // 列用 1fr 填满轨道（避免首帧测量为 0 时只铺左半边）
    expect(matrix.style.gridTemplateColumns).toMatch(/^repeat\(\d+, 1fr\)$/)
  })

  it('拖动只更新填充/档位，不重建元素格（矩阵节点身份保持）', () => {
    mount('default')
    fireEvent.click(screen.getByTestId('composer-effort'))
    const matrixBefore = screen.getByTestId('effort-matrix')
    const cellBefore = matrixBefore.querySelector('.thinking-effort-matrix-sq')

    fireEvent.change(screen.getByTestId('effort-slider'), { target: { value: '55' } })

    // 矩阵/元素格是同一批 DOM（memo 子组件，不重播入场、不重建）
    const matrixAfter = screen.getByTestId('effort-matrix')
    expect(matrixAfter).toBe(matrixBefore)
    expect(matrixAfter.querySelector('.thinking-effort-matrix-sq')).toBe(cellBefore)
    expect(screen.getByTestId('effort-current-label')).toHaveTextContent('High')
  })

  it('reduced：面板 data-motion=reduced，触发器不挂荧光 class（CSS 停用闪烁/过渡）', () => {
    setMotionReduced()
    mount('default')
    const trigger = screen.getByTestId('composer-effort')
    expect(trigger).not.toHaveClass('thinking-effort-trigger--lit')
    fireEvent.click(trigger)
    expect(screen.getByTestId('composer-effort-panel')).toHaveAttribute('data-motion', 'reduced')
  })

  it('CSS 契约（照抄 dsh 尺寸）：轨道 30 高、填充 26、滑钮 16×30、apex keyframes 在', () => {
    const block = (selector: string): string => {
      const match = new RegExp(
        `${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`
      ).exec(PANEL_CSS)
      if (match === null) throw new Error(`找不到规则 ${selector}`)
      return match[1]
    }

    expect(block('.thinking-effort-track')).toContain('height: 30px')
    expect(block('.thinking-effort-fill')).toContain('height: 26px')
    // 基础滑钮块（apex 状态块也含 .thinking-effort-knob，这里按声明序列匹配基础块）
    expect(PANEL_CSS).toMatch(
      /\.thinking-effort-knob\s*\{\s*position: absolute;[\s\S]*?width: 16px;[\s\S]*?height: 30px;/
    )
    expect(PANEL_CSS).toContain('@keyframes effort-apex-flash')
    // task-84：常驻闪烁 keyframes（元素格不拖动也动）
    expect(PANEL_CSS).toContain('@keyframes effort-cell-twinkle')
    expect(PANEL_CSS).not.toContain('display: none;')
    expect(PANEL_CSS).not.toContain('.thinking-effort-tick') // 旧刻度点已退场
    expect(PANEL_CSS).not.toContain('.thinking-effort-cell') // 旧 14 格已退场
    expect(PANEL_CSS).not.toContain('.thinking-effort-tier') // 旧档位按钮样式已退场

    // task-88（真 bug 回归点）：梯度走 CSS 变量，闪烁/其它动画**不得**动画 opacity
    expect(block('.thinking-effort-matrix-sq')).toContain('opacity: var(--effort-cell-opacity')
    const twinkle = /@keyframes effort-cell-twinkle\s*\{[\s\S]*?\n\}/.exec(PANEL_CSS)?.[0] ?? ''
    expect(twinkle).not.toBe('')
    expect(twinkle).not.toContain('opacity')
    expect(twinkle).toContain('filter: brightness')
    // 旧的「入场 opacity 动画」已移除（它带 both，容易和梯度/断言打架）
    expect(PANEL_CSS).not.toContain('@keyframes effort-matrix-in')
    expect(block('.thinking-effort-matrix-cell')).not.toContain('animation')
    // apex flash 只动 background-color，不动 opacity
    const apexFlash = /@keyframes effort-apex-flash\s*\{[\s\S]*?\n\}/.exec(PANEL_CSS)?.[0] ?? ''
    expect(apexFlash).not.toBe('')
    expect(apexFlash).not.toContain('opacity')

    // reduced 下元素格动画全部停（保留梯度）
    expect(PANEL_CSS).toMatch(
      /\[data-motion='reduced'\] \.thinking-effort-matrix-sq[\s\S]*?animation: none/
    )
  })
})
