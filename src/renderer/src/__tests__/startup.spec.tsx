import { waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from './kyclaw-bridge'
import { DEFAULT_SETTINGS } from '@shared/settings'

/**
 * 渲染端入口（main.tsx）的接线：initTheme 先落默认档，随后读落盘设置覆盖外观。
 * 这里真引入入口模块（jsdom 里 createRoot 能跑），所以能验到"启动时读设置"这条要求本身，
 * 而不是只验 store 的方法。
 */
describe('渲染端启动接线', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>'
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-font-size')
  })

  afterEach(() => {
    clearKyclawBridge()
  })

  it('启动时读落盘设置并应用主题与字号（入口一进来就生效）', async () => {
    const bridge = installKyclawBridge({ ...DEFAULT_SETTINGS, theme: 'dark', fontTier: 'large' })

    await import('@renderer/main')

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
      expect(document.documentElement.getAttribute('data-font-size')).toBe('large')
    })
    expect(bridge.get).toHaveBeenCalledTimes(1)
    expect(document.getElementById('root')?.childElementCount).toBeGreaterThan(0)
    // 真引入入口模块 + 真渲染，整仓并行跑时给足余量（round 37 去抖：5s 在满载机上会偶发超时）
  }, 15_000)
})
