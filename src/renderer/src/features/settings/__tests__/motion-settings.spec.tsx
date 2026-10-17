import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultMotionSettings, defaultSettings, type MotionSettings } from '@shared/settings'
import { MotionSettings as MotionSettingsPanel } from '../MotionSettings'

/**
 * 设置 →「动效」面板（task-58，抄 DSH claude-style「动画效果」）：
 *   6 个设置行 + 三档模式 + 四个 demo 预览行；每次改动都发 settings:update 的 { motion } 补丁；
 *   减弱（mode=reduced，或 system + 系统 prefers-reduced-motion）时 demo 定格 + 备注，选择仍可改。
 * 另外在文件末尾钉 reduced 三档的 CSS 语义（motion.css / tailwind.css 的 attr 规则）。
 */

const REPO_ROOT = process.cwd()
const MOTION_CSS = readFileSync(
  resolve(REPO_ROOT, 'src/renderer/src/styles/tokens/motion.css'),
  'utf8'
)
const TAILWIND_CSS = readFileSync(
  resolve(REPO_ROOT, 'src/renderer/src/styles/tailwind.css'),
  'utf8'
)

function withMotion(patch: Partial<MotionSettings> = {}): MotionSettings {
  const motion = { ...defaultMotionSettings(), ...patch }
  const base = defaultSettings()
  useSettingsStore.setState({ settings: { ...base, motion }, loaded: true })
  return motion
}

/** 系统 prefers-reduced-motion 替身（jsdom 没有 matchMedia） */
function stubSystemReduce(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn()
    }))
  )
}

beforeEach(() => {
  withMotion()
})

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
})

describe('动效面板 · 结构与默认值', () => {
  it('6 个设置行都在；三档模式 + 两个开关 + 精确状态行 + 消息气泡开关', () => {
    installKyclawBridge()
    render(<MotionSettingsPanel />)

    expect(screen.getByTestId('settings-group-motion')).toBeInTheDocument()
    for (const row of [
      'motion-row-mode',
      'motion-row-chat-scroll',
      'motion-row-status-line',
      'motion-row-precise-status',
      'motion-row-chat-send'
    ]) {
      expect(screen.getByTestId(row), row).toBeInTheDocument()
    }
    // 三档模式：随系统（默认选中）/ 减弱 / 总是
    for (const mode of ['system', 'reduced', 'always']) {
      expect(screen.getByTestId(`motion-mode-${mode}`), mode).toBeInTheDocument()
    }
    expect(screen.getByTestId('motion-mode-system')).toHaveAttribute('aria-selected', 'true')
    // 四个开关默认全开（聊天区滚动 / 状态行 / 精确状态 / 消息气泡）
    for (const id of [
      'motion-chat-scroll',
      'motion-status-line',
      'motion-precise-status',
      'motion-chat-send'
    ]) {
      expect(screen.getByTestId(id), id).toHaveAttribute('aria-checked', 'true')
    }
  })

  it('四个 demo 预览行 + 默认选中的卡（扫光 / 光标开 / 淡入 / 从输入框飞上来）', () => {
    installKyclawBridge()
    render(<MotionSettingsPanel />)

    // 状态画法：扫光 selected；两张卡各有一份 demo 文案（每张卡 = 底字 + 画法覆盖层）
    expect(screen.getAllByText('正在检出当前工作树')).toHaveLength(4)
    expect(screen.getByTestId('motion-status-paint-sweep')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('motion-status-paint-wash')).toHaveAttribute('aria-checked', 'false')

    // 光标：开 / 关
    expect(screen.getAllByText('Hello World!')).toHaveLength(2)
    expect(screen.getByTestId('motion-caret-typing')).toHaveAttribute('aria-checked', 'true')

    // 新文字淡入：淡入 / 直接出现（同一个 13 字样例）
    expect(screen.getByTestId('motion-reveal-on')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('motion-reveal-off')).toHaveAttribute('aria-checked', 'false')

    // 气泡出场：从输入框飞上来 selected；两张卡各两句 demo 气泡
    expect(screen.getAllByText('帮我给kyclaw点个star')).toHaveLength(2)
    expect(screen.getByTestId('motion-message-enter-flight')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByTestId('motion-message-enter-grow')).toHaveAttribute('aria-checked', 'false')
  })
})

describe('动效面板 · 写回 settings:update', () => {
  it('切三档模式 → 整段 motion 补丁（只改 mode）', async () => {
    const bridge = installKyclawBridge()
    render(<MotionSettingsPanel />)

    fireEvent.click(screen.getByTestId('motion-mode-reduced'))
    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        motion: { ...defaultMotionSettings(), mode: 'reduced' }
      })
    )

    fireEvent.click(screen.getByTestId('motion-mode-always'))
    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        motion: { ...defaultMotionSettings(), mode: 'always' }
      })
    )
  })

  it('开关 → 对应布尔；画法/光标/淡入/气泡出场 → 对应枚举', async () => {
    const bridge = installKyclawBridge()
    render(<MotionSettingsPanel />)

    const cases: Array<[string, Partial<MotionSettings>]> = [
      ['motion-chat-scroll', { chatScroll: false }],
      ['motion-status-line', { statusLine: false }],
      ['motion-chat-send', { chatSend: false }],
      ['motion-status-paint-wash', { statusPaint: 'wash' }],
      ['motion-caret-off', { caret: 'off' }],
      ['motion-reveal-off', { reveal: 'off' }],
      ['motion-message-enter-grow', { messageEnter: 'grow' }]
    ]

    for (const [testId, patch] of cases) {
      // 每次从默认值起：点击后 store 会累积上一项改动，这里要断言的是"这一项"的补丁
      // （act 保证 reset 后的重渲染先落定，点击用的才是默认值那版闭包）
      act(() => withMotion())
      fireEvent.click(screen.getByTestId(testId))
      await waitFor(() =>
        expect(bridge.update).toHaveBeenLastCalledWith({
          motion: { ...defaultMotionSettings(), ...patch }
        })
      )
    }
  })

  it('级联禁用：状态行动画关 → 精确状态行与画法卡灰；气泡动画关 → 出场卡灰（值不动）', () => {
    installKyclawBridge()
    withMotion({ statusLine: false, chatSend: false })
    render(<MotionSettingsPanel />)

    expect(screen.getByTestId('motion-precise-status')).toBeDisabled()
    expect(screen.getByTestId('motion-status-paint-sweep')).toBeDisabled()
    expect(screen.getByTestId('motion-status-paint-wash')).toBeDisabled()
    expect(screen.getByTestId('motion-message-enter-grow')).toBeDisabled()
    expect(screen.getByTestId('motion-message-enter-flight')).toBeDisabled()
    // 选项值保持原样（不因为禁用被改）
    expect(screen.getByTestId('motion-status-paint-sweep')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('motion-message-enter-flight')).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })
})

describe('动效面板 · reduced 三档（减弱 / 随系统 / 总是）', () => {
  it('mode=reduced：demo 根 data-motion=reduced、四个 demo 行给 motionStillNote、选择仍可改', () => {
    const bridge = installKyclawBridge()
    withMotion({ mode: 'reduced' })
    render(<MotionSettingsPanel />)

    expect(screen.getByTestId('settings-group-motion')).toHaveAttribute('data-motion', 'reduced')
    for (const row of [
      'motion-row-status-paint',
      'motion-row-caret',
      'motion-row-reveal',
      'motion-row-message-enter'
    ]) {
      expect(screen.getByTestId(`${row}-still`), row).toHaveTextContent(
        '动画设为「减弱」时这一项不生效，卡片只显示定格画面。'
      )
    }
    // 选择仍可改（值照存）：减弱态下点「渐变流动」照样写补丁
    fireEvent.click(screen.getByTestId('motion-status-paint-wash'))
    expect(bridge.update).toHaveBeenCalledWith({
      motion: { ...defaultMotionSettings(), mode: 'reduced', statusPaint: 'wash' }
    })
  })

  it('mode=system + 系统 prefers-reduced-motion → reduced；切换「总是」→ full（忽略系统）', () => {
    stubSystemReduce(true)
    installKyclawBridge()
    withMotion({ mode: 'system' })
    const view = render(<MotionSettingsPanel />)

    expect(screen.getByTestId('settings-group-motion')).toHaveAttribute('data-motion', 'reduced')

    withMotion({ mode: 'always' })
    view.rerender(<MotionSettingsPanel />)
    expect(screen.getByTestId('settings-group-motion')).toHaveAttribute('data-motion', 'full')
    expect(screen.queryByTestId('motion-row-caret-still')).not.toBeInTheDocument()
  })

  it('mode=system + 系统未减弱 → full（默认不动，不额外提示）', () => {
    stubSystemReduce(false)
    installKyclawBridge()
    withMotion({ mode: 'system' })
    render(<MotionSettingsPanel />)

    expect(screen.getByTestId('settings-group-motion')).toHaveAttribute('data-motion', 'full')
    expect(screen.queryByTestId('motion-row-status-paint-still')).not.toBeInTheDocument()
  })
})

/**
 * reduced 三档的 CSS 语义（doc §3）：`<html data-motion>` 是唯一裁决点 ——
 *   - `data-motion="reduced"`：所有动效角色压到 --motion-reduced（面板选「减弱」）；
 *   - `data-motion="full"`：重声明真实时长（面板选「总是」→ 忽略系统媒体查询）；
 *   - 无 attr / 其它：沿用系统媒体查询（随系统）。
 * 另外全局兜底的 0.01ms 规则必须让「总是」能跳过媒体查询。
 */
describe('reduced 三档 · CSS 契约', () => {
  it('motion.css：attr=reduced 压档、attr=full 重声明真实时长（特异性高于媒体查询）', () => {
    expect(MOTION_CSS).toMatch(
      /:root\[data-motion='reduced'\] \{[\s\S]*?--motion-feedback: var\(--motion-reduced\)/
    )
    expect(MOTION_CSS).toMatch(/:root\[data-motion='full'\] \{[\s\S]*?--motion-feedback: 120ms/)
    for (const token of [
      '--motion-reveal: 150ms',
      '--motion-enter: 320ms',
      '--motion-flight: 400ms',
      '--motion-sweep: 1500ms'
    ]) {
      expect(MOTION_CSS, token).toContain(token)
    }
  })

  it('tailwind.css：全局 reduced 兜底跳过「总是」；显式减弱压档', () => {
    expect(TAILWIND_CSS).toContain(":root:not([data-motion='full']) *,")
    expect(TAILWIND_CSS).toMatch(
      /:root\[data-motion='reduced'\] \*,[\s\S]*?animation-duration: 0\.01ms !important;/
    )
  })
})

describe('字体声部 / 字阶（task-67 字体统一 P2 收尾）', () => {
  it('区块标题与设置页分组同口径（16/600 衬线）；面板字号归到 12/14 两档', () => {
    withMotion()
    render(<MotionSettingsPanel />)

    const heading = screen.getByRole('heading', { level: 2, name: '动效' })
    expect(heading).toHaveClass('font-serif', 'font-semibold', 'text-t2')

    const PANEL_CSS = readFileSync(
      resolve(REPO_ROOT, 'src/renderer/src/features/settings/motion-settings.css'),
      'utf8'
    )
    // 审计 P2：13/11 不是六档 → 说明/demo 全归 12（C1），行标题仍 14（B2）
    expect(PANEL_CSS).not.toContain('font-size: 13px')
    expect(PANEL_CSS).not.toContain('font-size: 11px')
    expect(PANEL_CSS).toContain('font-size: 14px')
    expect(PANEL_CSS).toContain('font-size: 12px')
  })
})
