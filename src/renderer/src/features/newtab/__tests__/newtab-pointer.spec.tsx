import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { defaultMotionSettings, defaultSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { resetOfficeTabsStore } from '@renderer/features/office/office-tabs-store'
import { resetNotesStore } from '@renderer/features/notes/notes-store'
import { NewTabPage } from '../NewTabPage'
import {
  LATTICE,
  POINTER_VAR_NAMES,
  latticeFalloff,
  rippleEnvelope,
  rippleRadius,
  shouldTrackPointer
} from '../use-newtab-pointer'
import { resetNewTabStore, useNewTabStore } from '../new-tab-store'

const ROOT = process.cwd()
const read = (relative: string): string => readFileSync(resolve(ROOT, relative), 'utf8')

const rafQueue: FrameRequestCallback[] = []
const flushRaf = (): void => {
  for (let index = 0; index < 8 && rafQueue.length > 0; index += 1) {
    const frame = rafQueue.shift()
    if (frame !== undefined) act(() => frame(0))
  }
}

const fakeCtx = {
  globalAlpha: 1,
  fillStyle: '',
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  fillRect: vi.fn()
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/office']}>
      <NewTabPage />
    </MemoryRouter>
  )
}

const cssVar = (name: string): string =>
  screen.getByTestId('newtab-page').style.getPropertyValue(name)

beforeEach(() => {
  installKyclawBridge()
  resetOfficeTabsStore()
  resetNotesStore()
  resetNewTabStore()
  useNewTabStore.getState().open()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    fakeCtx as unknown as CanvasRenderingContext2D
  )
  rafQueue.length = 0
  // 受控 rAF：不递归自触发；测试显式 flush 一帧（绘制循环也由它驱动）
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      rafQueue.push(callback)
      return rafQueue.length
    })
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  clearKyclawBridge()
  resetNewTabStore()
  resetOfficeTabsStore()
  resetNotesStore()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('task-109 · lattice 纯函数（格距/衰减/涟漪）', () => {
  it('格距 32、点亮半径 180、涟漪速度/寿命/叠加上限', () => {
    expect(LATTICE.cell).toBe(32)
    expect(LATTICE.radius).toBe(180)
    expect(LATTICE.rippleSpeed).toBe(440)
    expect(LATTICE.rippleLifeMs).toBe(1050)
    expect(LATTICE.maxRipples).toBe(6)
  })

  it('falloff：(1−d/R)²；中心=1、半径外=0、边缘自然衰减', () => {
    expect(latticeFalloff(0)).toBe(1)
    expect(latticeFalloff(90)).toBeCloseTo(0.25, 5)
    expect(latticeFalloff(LATTICE.radius)).toBe(0)
    expect(latticeFalloff(LATTICE.radius + 1)).toBe(0)
    const near = latticeFalloff(140)
    const far = latticeFalloff(175)
    expect(near).toBeGreaterThan(far)
    expect(far).toBeGreaterThan(0)
  })

  it('涟漪：半径 = speed×t；包络 (1−t)² 单调降、到寿命归零', () => {
    expect(rippleRadius(0)).toBe(0)
    expect(rippleRadius(500)).toBe(220)
    expect(rippleEnvelope(0)).toBe(1)
    expect(rippleEnvelope(LATTICE.rippleLifeMs / 2)).toBeCloseTo(0.25, 5)
    expect(rippleEnvelope(LATTICE.rippleLifeMs)).toBe(0)
    expect(rippleEnvelope(400)).toBeGreaterThan(rippleEnvelope(800))
  })

  it('reduced / coarse 不启用', () => {
    expect(shouldTrackPointer(false, false)).toBe(true)
    expect(shouldTrackPointer(true, false)).toBe(false)
    expect(shouldTrackPointer(false, true)).toBe(false)
  })
})

describe('task-109 · 静态契约（无大光晕 / canvas 与网格同相位 / 降级）', () => {
  it('CSS：删掉 `.lt-bg::after` 光晕，canvas 层与静态网格并存，reduced/coarse 隐藏', () => {
    const css = read('src/renderer/src/features/newtab/newtab.css')
    expect(css).not.toMatch(/\.lt-bg::after\s*\{/)
    expect(css).not.toContain('circle 360px at var(--npw-mx)')
    expect(css).toContain('.lt-lattice')
    expect(css).toMatch(/\.lt-lattice \{[\s\S]*?position: absolute;[\s\S]*?inset: 0/)
    expect(css).toContain('background-position: calc(var(--npw-dx) * 3px)')
    expect(css).toContain(":root[data-motion='reduced'] .lt-lattice")
    expect(css).toContain('@media (pointer: coarse)')
  })

  it('hook：事件/passive/ResizeObserver/DPR/rAF 空闲停止/涟漪上限，保留水印视差变量', () => {
    const source = read('src/renderer/src/features/newtab/use-newtab-pointer.ts')
    expect(source).toContain("addEventListener('pointermove', onMove, { passive: true })")
    expect(source).toContain("addEventListener('pointerdown', onDown)")
    expect(source).toContain('ResizeObserver')
    expect(source).toContain('devicePixelRatio')
    expect(source).toContain('requestAnimationFrame')
    expect(source).toContain('LATTICE.maxRipples')
    for (const name of POINTER_VAR_NAMES) expect(source).toContain(name)
  })

  it('NewTabView：canvas 挂在 .lt-bg 内，hook 接到 canvasRef', () => {
    const view = read('src/renderer/src/features/newtab/NewTabView.tsx')
    expect(view).toContain('data-testid="npw-lattice"')
    expect(view).toContain('useNewTabPointer(pageRef, latticeCanvasRef)')
  })
})

describe('task-109 · 运行时（jsdom）', () => {
  it('pointermove 写像素/视差变量并 active=1，rAF 绘制一次格子', async () => {
    renderPage()
    const page = screen.getByTestId('newtab-page')
    fireEvent.pointerMove(page, { clientX: 320, clientY: 180 })
    flushRaf()

    await waitFor(() => expect(cssVar('--npw-mx')).not.toBe(''))
    expect(cssVar('--npw-active')).toBe('1')
    expect(Number(cssVar('--npw-dx'))).toBeGreaterThanOrEqual(-1)
    expect(Number(cssVar('--npw-dx'))).toBeLessThanOrEqual(1)
  })

  it('pointerMove 写变量后 pointerleave 归位（active/dx/dy=0）', async () => {
    renderPage()
    const page = screen.getByTestId('newtab-page')
    fireEvent.pointerMove(page, { clientX: 400, clientY: 200 })
    flushRaf()
    await waitFor(() => expect(cssVar('--npw-active')).toBe('1'))
    fireEvent.pointerLeave(page)
    await waitFor(() => expect(cssVar('--npw-active')).toBe('0'))
    expect(cssVar('--npw-dx')).toBe('0')
    expect(cssVar('--npw-dy')).toBe('0')
  })

  it('reduced：不创建监听/不写变量', () => {
    useSettingsStore.setState({
      settings: { ...defaultSettings(), motion: { ...defaultMotionSettings(), mode: 'reduced' } },
      loaded: true
    })
    renderPage()
    fireEvent.pointerMove(screen.getByTestId('newtab-page'), { clientX: 320, clientY: 180 })
    expect(cssVar('--npw-mx')).toBe('')
    expect(cssVar('--npw-active')).toBe('')
  })

  it('触摸设备（pointer: coarse）：不写变量', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('pointer: coarse'),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => false)
      }))
    )
    renderPage()
    fireEvent.pointerMove(screen.getByTestId('newtab-page'), { clientX: 320, clientY: 180 })
    expect(cssVar('--npw-mx')).toBe('')
  })
})
