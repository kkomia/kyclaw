import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultMotionSettings, defaultSettings, type AppSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/lib/settings-store'
import {
  defaultMotion,
  effectiveMotionOf,
  motionDataAttributes,
  readMotionSettings,
  resolveEffectiveMotion,
  resolveMotionReduced,
  useEffectiveMotion
} from '../motion'

let systemReduce = false

function mockMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes('prefers-reduced-motion') ? systemReduce : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => false)
    }))
  })
}

function settingsWith(motion: unknown): AppSettings {
  return { ...defaultSettings(), motion } as AppSettings
}

beforeEach(() => {
  systemReduce = false
  mockMatchMedia()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
})

describe('readMotionSettings：默认值/坏值兜底（A 的模型未落地时也不炸）', () => {
  it('undefined / 半截 / 坏枚举都回 doc 默认（用户截图选择）', () => {
    const fallback = defaultMotionSettings()
    expect(readMotionSettings(undefined)).toEqual(fallback)
    expect(readMotionSettings({ chatScroll: false })).toMatchObject({
      chatScroll: false,
      statusLine: true,
      caret: 'typing'
    })
    expect(
      readMotionSettings({ mode: 'nonsense', statusPaint: 'sparkle', chatSend: 'yes' })
    ).toEqual(fallback)
    expect(defaultMotion()).toEqual(fallback)
  })

  it('完整合法值原样保留（含 mode=always）', () => {
    const motion = { ...defaultMotionSettings(), mode: 'always' as const, reveal: 'off' as const }
    expect(readMotionSettings(motion)).toEqual(motion)
    expect(effectiveMotionOf({ motion }, true).reduced).toBe(false)
  })
})

describe('三档 × reduced 折算', () => {
  it('system 跟随系统；reduced 一律静态；always 忽略系统', () => {
    expect(resolveMotionReduced('system', true)).toBe(true)
    expect(resolveMotionReduced('system', false)).toBe(false)
    expect(resolveMotionReduced('reduced', false)).toBe(true)
    expect(resolveMotionReduced('always', true)).toBe(false)
  })

  it('减弱时所有会动的开关关掉（说法仍在、caret 回原生、气泡直接站位）', () => {
    const motion = defaultMotionSettings()
    const reduced = resolveEffectiveMotion({ ...motion, mode: 'reduced' }, false)
    expect(reduced).toMatchObject({
      reduced: true,
      chatScroll: false,
      statusLine: false,
      preciseStatus: false,
      caret: 'off',
      reveal: 'off',
      chatSend: false,
      messageEnter: 'none'
    })
    // 画法选择值仍保留（面板可切换；只是不动）
    expect(reduced.statusPaint).toBe('sweep')
  })

  it('单项关闭只影响该项；chatSend 关时 messageEnter 归 none', () => {
    const motion = defaultMotionSettings()
    const noScroll = resolveEffectiveMotion({ ...motion, chatScroll: false }, false)
    expect(noScroll.chatScroll).toBe(false)
    expect(noScroll.statusLine).toBe(true)
    expect(noScroll.caret).toBe('typing')

    const noSend = resolveEffectiveMotion({ ...motion, chatSend: false }, false)
    expect(noSend.chatSend).toBe(false)
    expect(noSend.messageEnter).toBe('none')
  })

  it('motionDataAttributes：聊天根 6 个 data-* 门控', () => {
    const attrs = motionDataAttributes(resolveEffectiveMotion(defaultMotionSettings(), false))
    expect(attrs).toEqual({
      'data-motion': 'full',
      'data-chat-scroll': 'on',
      'data-chat-reveal': 'on',
      'data-status-line': 'on',
      'data-status-paint': 'sweep',
      'data-chat-send': 'on',
      'data-message-enter': 'flight'
    })
  })
})

describe('useEffectiveMotion：从 settings store 读真值 + 系统媒体变化', () => {
  it('store 改 motion 后 hook 重算（不需要组件散落读 mode）', () => {
    const { result, rerender } = renderHook(() => useEffectiveMotion())
    expect(result.current.reduced).toBe(false)
    expect(result.current.caret).toBe('typing')

    act(() => {
      useSettingsStore.setState({
        settings: settingsWith({ ...defaultMotionSettings(), mode: 'reduced' })
      })
    })
    expect(result.current.reduced).toBe(true)
    expect(result.current.caret).toBe('off')

    act(() => {
      useSettingsStore.setState({
        settings: settingsWith({ ...defaultMotionSettings(), mode: 'always' })
      })
    })
    expect(result.current.reduced).toBe(false)

    systemReduce = true
    rerender()
    // always 覆盖系统减弱（无障碍例外，面板保留原文案）
    expect(result.current.reduced).toBe(false)

    act(() => {
      useSettingsStore.setState({ settings: defaultSettings() })
    })
    expect(result.current.reduced).toBe(true)
  })
})
