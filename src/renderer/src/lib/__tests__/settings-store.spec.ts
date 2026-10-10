import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { DEFAULT_SETTINGS, defaultSettings } from '@shared/settings'
import type { ProviderConfig } from '@shared/providers'

/**
 * 渲染端设置副本：读落盘（settings:get）→ 应用外观（html 属性）；
 * 用户改动 → 先应用再落盘（settings:update），落盘失败不回滚（本次会话仍生效，只记日志）。
 */
const html = (): HTMLElement => document.documentElement

function store(): ReturnType<typeof useSettingsStore.getState> {
  return useSettingsStore.getState()
}

beforeEach(() => {
  html().removeAttribute('data-theme')
  html().removeAttribute('data-font-size')
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

describe('settings store · load（启动时读落盘）', () => {
  it('把落盘的主题与字号应用到 html，并标 loaded', async () => {
    installKyclawBridge({ ...DEFAULT_SETTINGS, theme: 'dark', fontTier: 'large' })

    await store().load()

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(html().getAttribute('data-font-size')).toBe('large')
    expect(store().settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', fontTier: 'large' })
    expect(store().loaded).toBe(true)
  })

  it('没有 preload 桥（浏览器 / 单测环境）时用默认值，不抛', async () => {
    clearKyclawBridge()

    await expect(store().load()).resolves.toBeUndefined()
    expect(store().settings).toEqual(DEFAULT_SETTINGS)
    expect(html().getAttribute('data-font-size')).toBe('default')
    expect(store().loaded).toBe(true)
  })

  it('主进程读失败时不炸启动：用默认值，且留下日志', async () => {
    const bridge = installKyclawBridge()
    bridge.get.mockRejectedValueOnce(new Error('ipc 断了'))

    await expect(store().load()).resolves.toBeUndefined()

    expect(store().settings).toEqual(DEFAULT_SETTINGS)
    expect(store().loaded).toBe(true)
    expect(console.error).toHaveBeenCalled()
  })
})

describe('settings store · update（用户改动）', () => {
  it('立刻应用（不等落盘），补丁按原样发给主进程', async () => {
    const bridge = installKyclawBridge()

    await store().update({ theme: 'dark' })

    expect(html().getAttribute('data-theme')).toBe('dark')
    expect(bridge.update).toHaveBeenCalledWith({ theme: 'dark' })
    expect(store().settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark' })
  })

  it('以主进程回吐的合并结果为准（落盘后的那份才是真相）', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, theme: 'dark', fontTier: 'small' })

    await store().update({ theme: 'dark' })

    expect(store().settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'dark', fontTier: 'small' })
    expect(html().getAttribute('data-font-size')).toBe('small')
  })

  it('落盘失败：本次改动仍生效，不抛，留日志（写失败不该让 UI 跳回去）', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))

    await expect(store().update({ theme: 'light' })).resolves.toBeUndefined()

    expect(html().getAttribute('data-theme')).toBe('light')
    expect(store().settings).toEqual({ ...DEFAULT_SETTINGS, theme: 'light' })
    expect(console.error).toHaveBeenCalled()
  })

  it('没有 preload 桥时只在本地生效，不抛', async () => {
    clearKyclawBridge()

    await expect(store().update({ fontTier: 'large' })).resolves.toBeUndefined()

    expect(html().getAttribute('data-font-size')).toBe('large')
    expect(store().settings).toEqual({ ...DEFAULT_SETTINGS, fontTier: 'large' })
  })
})

describe('settings store · provider（模型设置页用）', () => {
  const DEEPSEEK: ProviderConfig = {
    id: 'deepseek',
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    isDefault: true
  }

  it('saveProviders：补丁原样发出去，以落盘回吐为准（不做乐观应用）', async () => {
    const bridge = installKyclawBridge()

    await store().saveProviders([DEEPSEEK])

    expect(bridge.update).toHaveBeenCalledWith({ providers: [DEEPSEEK] })
    expect(store().settings.providers).toEqual([DEEPSEEK])
  })

  it('saveProviders 落盘失败 → 抛给调用方，store 保持原样（UI 才能报错）', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))

    await expect(store().saveProviders([DEEPSEEK])).rejects.toThrow('磁盘满了')

    expect(store().settings.providers).toEqual([])
  })

  it('没有 preload 桥时保存会抛（不假装成功）', async () => {
    clearKyclawBridge()

    await expect(store().saveProviders([DEEPSEEK])).rejects.toThrow(/设置通道不可用/)
    await expect(store().removeProvider('deepseek')).rejects.toThrow(/设置通道不可用/)
  })

  it('removeProvider：走 settings:remove-provider，并以回吐设置为准', async () => {
    const bridge = installKyclawBridge({ ...DEFAULT_SETTINGS, providers: [DEEPSEEK] })

    await store().removeProvider('deepseek')

    expect(bridge.removeProvider).toHaveBeenCalledWith('deepseek')
    expect(store().settings.providers).toEqual([])
  })
})
