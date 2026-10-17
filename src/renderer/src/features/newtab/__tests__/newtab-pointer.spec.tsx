import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
import { POINTER_VAR_NAMES, shouldTrackPointer } from '../use-newtab-pointer'
import { resetNewTabStore, useNewTabStore } from '../new-tab-store'

/**
 * task-89 追加要求：「背景做成动态的，根据鼠标位置有对应动效变化」。
 * 这里钉：指针位置写进 CSS 变量（光跟随/水印视差）、离页/失焦归位、
 * reduced 与触摸设备不挂监听且不写变量；视觉细节见 newtab.css 契约断言。
 */
const ROOT = process.cwd()
const read = (relative: string): string => readFileSync(resolve(ROOT, relative), 'utf8')

beforeEach(() => {
  installKyclawBridge()
  resetOfficeTabsStore()
  resetNotesStore()
  resetNewTabStore()
  useNewTabStore.getState().open()
  // rAF 同步化：让 pointermove → apply 在同一拍完成
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
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
  vi.unstubAllGlobals()
})

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={['/office']}>
      <NewTabPage />
    </MemoryRouter>
  )
}

const cssVar = (name: string): string =>
  screen.getByTestId('newtab-page').style.getPropertyValue(name)

describe('task-89 · 指针跟随背景（静态契约）', () => {
  it('hook：passive pointermove + rAF + 离页/失焦归位 + reduced/触摸门控', () => {
    const source = read('src/renderer/src/features/newtab/use-newtab-pointer.ts')
    expect(source).toContain("addEventListener('pointermove', onPointerMove, { passive: true })")
    expect(source).toContain('requestAnimationFrame')
    expect(source).toContain("addEventListener('pointerleave', reset)")
    expect(source).toContain("window.addEventListener('blur', reset)")
    expect(source).toContain("matchMedia('(pointer: coarse)')")
    expect(source).toContain('shouldTrackPointer')
    for (const name of POINTER_VAR_NAMES) expect(source).toContain(name)
    expect(shouldTrackPointer(false, false)).toBe(true)
    expect(shouldTrackPointer(true, false)).toBe(false)
    expect(shouldTrackPointer(false, true)).toBe(false)
  })

  it('CSS：背景层读 --npw-mx/my、水印读 --npw-dx/dy，reduced/触摸有静态兜底', () => {
    const css = read('src/renderer/src/features/newtab/newtab.css')
    expect(css).toContain('--npw-mx')
    expect(css).toContain('--npw-dx')
    expect(css).toMatch(/\.lt-bg::after \{[\s\S]*?radial-gradient\(/)
    expect(css).toMatch(/opacity: calc\(var\(--npw-active\) \* 0\.9\)/)
    expect(css).toMatch(/\.lt-cell--primary \.lt-watermark \{[\s\S]*?var\(--npw-dx\) \* 4px/)
    expect(css).toContain(":root[data-motion='reduced'] .lt-bg::after")
    expect(css).toContain('@media (pointer: coarse)')
    // 视觉层确实挂了 hook
    expect(read('src/renderer/src/features/newtab/NewTabView.tsx')).toContain(
      'useNewTabPointer(pageRef)'
    )
  })
})

describe('task-89 · 指针跟随背景（运行时）', () => {
  it('pointermove 写 CSS 变量（光跟随 + 视差归一化 + active=1）', async () => {
    renderPage()
    const page = screen.getByTestId('newtab-page')

    fireEvent.pointerMove(page, { clientX: 320, clientY: 180 })

    await waitFor(() => expect(cssVar('--npw-mx')).not.toBe(''))
    expect(cssVar('--npw-my')).not.toBe('')
    expect(cssVar('--npw-active')).toBe('1')
    // 归一化视差系数在 [-1, 1]；jsdom 无布局时按最小尺寸 clamp，值仍可读
    expect(Number(cssVar('--npw-dx'))).toBeGreaterThanOrEqual(-1)
    expect(Number(cssVar('--npw-dx'))).toBeLessThanOrEqual(1)
    expect(cssVar('--npw-dy')).not.toBe('')
  })

  it('指针离开页面：归位（active=0、dx/dy=0）', async () => {
    renderPage()
    const page = screen.getByTestId('newtab-page')
    fireEvent.pointerMove(page, { clientX: 320, clientY: 180 })
    await waitFor(() => expect(cssVar('--npw-active')).toBe('1'))

    fireEvent.pointerLeave(page)

    await waitFor(() => expect(cssVar('--npw-active')).toBe('0'))
    expect(cssVar('--npw-dx')).toBe('0')
    expect(cssVar('--npw-dy')).toBe('0')
  })

  it('reduced（用户「减弱」）：不挂监听、不写任何指针变量', () => {
    useSettingsStore.setState({
      settings: { ...defaultSettings(), motion: { ...defaultMotionSettings(), mode: 'reduced' } },
      loaded: true
    })
    renderPage()
    const page = screen.getByTestId('newtab-page')

    fireEvent.pointerMove(page, { clientX: 320, clientY: 180 })

    expect(cssVar('--npw-mx')).toBe('')
    expect(cssVar('--npw-active')).toBe('')
  })

  it('触摸设备（pointer: coarse）：不挂监听（静态背景保留）', () => {
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
    const page = screen.getByTestId('newtab-page')

    fireEvent.pointerMove(page, { clientX: 320, clientY: 180 })

    expect(cssVar('--npw-mx')).toBe('')
  })
})
