import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type AppSettings } from '@shared/settings'
import type { ProviderConfig } from '@shared/providers'
import { ModelSettings } from '../ModelSettings'

/**
 * 设置页「模型」组（T8，RTL）：
 *   - 预设/自定义入口 → provider 配置落盘（settings:update）；
 *   - key 只写不回显：保存后输入框清空、状态"已配置"、整页文本不含明文；
 *   - 半截配置行内报"配置不完整：缺 X"；解不开的密钥引导重录（Review Focus #5）；
 *   - 测试连接：先存后测，显示延迟或错误文案。
 */
const DEEPSEEK: ProviderConfig = {
  id: 'deepseek',
  type: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  isDefault: true
}

const OPENAI: ProviderConfig = {
  id: 'openai',
  type: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  isDefault: false
}

const KEY = 'sk-renderer-7f3a9c-SECRET'

function withProviders(...providers: ProviderConfig[]): AppSettings {
  return { ...defaultSettings(), providers }
}

/** 装桥 + 把 store 的副本同步成"已启动读过盘"的样子，再挂载模型组 */
async function mount(initial: AppSettings): Promise<ReturnType<typeof installKyclawBridge>> {
  const bridge = installKyclawBridge(initial)
  await useSettingsStore.getState().load()
  render(<ModelSettings />)
  return bridge
}

function input(testId: string): HTMLInputElement {
  return screen.getByTestId(testId) as HTMLInputElement
}

beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

describe('模型组 · provider 的增删与默认', () => {
  it('一条都没有：空态 + 预设入口都在', async () => {
    await mount(defaultSettings())

    expect(screen.getByTestId('model-empty')).toHaveTextContent('还没有模型通道')
    for (const preset of ['deepseek', 'moonshot', 'openai', 'anthropic']) {
      expect(screen.getByTestId(`add-preset-${preset}`), preset).toBeInTheDocument()
    }
    expect(screen.getByTestId('add-custom-openai-compatible')).toBeInTheDocument()
    expect(screen.getByTestId('add-custom-anthropic')).toBeInTheDocument()
  })

  it('点 DeepSeek 预设：按官方 baseUrl 与缺省模型落盘，第一条自动成默认', async () => {
    const bridge = await mount(defaultSettings())

    fireEvent.click(screen.getByTestId('add-preset-deepseek'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        providers: [
          {
            id: 'deepseek',
            type: 'openai-compatible',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            isDefault: true
          }
        ]
      })
    )
    expect(await screen.findByTestId('provider-deepseek')).toBeInTheDocument()
    expect(input('provider-deepseek-base-url').value).toBe('https://api.deepseek.com')
    expect(input('provider-deepseek-model').value).toBe('deepseek-flash')
    expect(screen.getByTestId('provider-deepseek-default-badge')).toHaveTextContent('默认')
    // 已添加的预设不再可点
    expect(screen.getByTestId('add-preset-deepseek')).toBeDisabled()
  })

  it('自定义：id 递增、model 留空（先落配置再填内容）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))

    fireEvent.click(screen.getByTestId('add-custom-openai-compatible'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenLastCalledWith({
        providers: [
          DEEPSEEK,
          { id: 'custom-1', type: 'openai-compatible', model: '', isDefault: false }
        ]
      })
    )
    expect(await screen.findByTestId('provider-custom-1')).toBeInTheDocument()
  })

  it('设为默认：默认标记只挪到点的那条上', async () => {
    const bridge = await mount(withProviders(DEEPSEEK, OPENAI))

    fireEvent.click(screen.getByTestId('provider-openai-set-default'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenLastCalledWith({
        providers: [
          { ...DEEPSEEK, isDefault: false },
          { ...OPENAI, isDefault: true }
        ]
      })
    )
    expect(await screen.findByTestId('provider-openai-default-badge')).toBeInTheDocument()
  })

  it('删除：走 settings:remove-provider，卡片消失', async () => {
    const bridge = await mount(withProviders(DEEPSEEK, OPENAI))

    fireEvent.click(screen.getByTestId('provider-openai-remove'))

    await waitFor(() => expect(bridge.removeProvider).toHaveBeenCalledWith('openai'))
    await waitFor(() => expect(screen.queryByTestId('provider-openai')).not.toBeInTheDocument())
    expect(screen.getByTestId('provider-deepseek')).toBeInTheDocument()
  })
})

describe('模型组 · 密钥只写不回显', () => {
  it('填 key 保存：只把 [id, key] 交给主进程；状态转"已配置"，输入框清空，整页不含明文', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    // 先等密钥状态读完（读到"未配置"才谈得上"转已配置"）
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('未配置')
    )

    fireEvent.change(screen.getByTestId('provider-deepseek-key'), { target: { value: KEY } })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    await waitFor(() => expect(bridge.setProviderKey).toHaveBeenCalledWith('deepseek', KEY))
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('已配置')
    )
    expect(input('provider-deepseek-key').value).toBe('')
    expect(document.body.textContent ?? '').not.toContain(KEY)
  })

  it('配置与 key 一起保存：先落配置再写 key（顺序不能反）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))

    fireEvent.change(screen.getByTestId('provider-deepseek-model'), {
      target: { value: 'deepseek-v4-pro' }
    })
    fireEvent.change(screen.getByTestId('provider-deepseek-key'), { target: { value: KEY } })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    await waitFor(() => expect(bridge.setProviderKey).toHaveBeenCalled())
    expect(bridge.update.mock.calls.at(-1)?.[0]).toMatchObject({
      providers: [{ model: 'deepseek-v4-pro' }]
    })
    expect(bridge.update.mock.invocationCallOrder.at(-1)).toBeLessThan(
      bridge.setProviderKey.mock.invocationCallOrder[0]
    )
  })

  it('密钥状态还没读到（IPC 未返回）：状态显示"读取中…"，不误报"缺 API 密钥"', async () => {
    const bridge = installKyclawBridge(withProviders(DEEPSEEK))
    bridge.providerKeyStates.mockImplementation(() => new Promise(() => {}))
    await useSettingsStore.getState().load()
    render(<ModelSettings />)

    expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('读取中')
    expect(screen.queryByTestId('provider-deepseek-problems')).not.toBeInTheDocument()
    await waitFor(() => expect(bridge.providerKeyStates).toHaveBeenCalled())
  })

  it('密钥解不开（换机/迁移）→ 状态"需要重新录入" + 引导重录（Review Focus #5）', async () => {
    const bridge = installKyclawBridge(withProviders(DEEPSEEK))
    bridge.providerKeyStates.mockResolvedValue({
      deepseek: { hasKey: false, needsReentry: true }
    })
    await useSettingsStore.getState().load()
    render(<ModelSettings />)

    expect(await screen.findByTestId('provider-deepseek-reentry')).toHaveTextContent('重新录入')
    expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('需要重新录入')
    expect(screen.getByTestId('provider-deepseek-problems')).toHaveTextContent(
      '配置不完整：缺 API 密钥'
    )
  })

  it('保存失败：行内报错（不假装已保存）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    bridge.setProviderKey.mockRejectedValueOnce(new Error('系统安全存储不可用'))

    fireEvent.change(screen.getByTestId('provider-deepseek-key'), { target: { value: KEY } })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    expect(await screen.findByTestId('provider-deepseek-error')).toHaveTextContent(
      '系统安全存储不可用'
    )
    expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('未配置')
  })
})

describe('模型组 · 半截配置的行内提示', () => {
  it('缺模型名 / 缺 Base URL / 缺 key 全部点名', async () => {
    await mount(
      withProviders({ id: 'custom-1', type: 'openai-compatible', model: '', isDefault: true })
    )

    // 等密钥状态读完，三条缺项才齐（读到之前不报"缺 API 密钥"）
    await waitFor(() =>
      expect(screen.getByTestId('provider-custom-1-key-status')).toHaveTextContent('未配置')
    )
    expect(screen.getByTestId('provider-custom-1-problems')).toHaveTextContent(
      '配置不完整：缺模型名；配置不完整：缺 Base URL；配置不完整：缺 API 密钥'
    )
  })

  it('Anthropic 不需要 Base URL（配齐就无提示）', async () => {
    const bridge = installKyclawBridge(
      withProviders({
        id: 'anthropic',
        type: 'anthropic',
        model: 'claude-sonnet-4-5',
        isDefault: true
      })
    )
    bridge.providerKeyStates.mockResolvedValue({
      anthropic: { hasKey: true, needsReentry: false }
    })
    await useSettingsStore.getState().load()
    render(<ModelSettings />)

    // 等"已配置"先上屏（密钥状态读完），这时才谈得上"配齐了"
    await waitFor(() =>
      expect(screen.getByTestId('provider-anthropic-key-status')).toHaveTextContent('已配置')
    )

    expect(screen.queryByTestId('provider-anthropic-problems')).not.toBeInTheDocument()
    expect(screen.queryByTestId('provider-anthropic-base-url')).not.toBeInTheDocument()
  })
})

describe('模型组 · 测试连接', () => {
  it('成功：显示延迟（主进程发的那条最小请求）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))

    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    await waitFor(() => expect(bridge.testProvider).toHaveBeenCalledWith('deepseek'))
    expect(await screen.findByTestId('provider-deepseek-test-result')).toHaveTextContent(
      '连接正常，延迟 128 ms'
    )
  })

  it('round 22：成功之后顺带触发一次模型元数据探测（真实上下文/挡位；后台、静默）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))

    // 探测回包带实测值：存储跟着更新（probeModels 的动作把回吐设置为准）
    bridge.probeModels.mockResolvedValueOnce({
      ...withProviders(DEEPSEEK),
      probedModels: {
        'deepseek:deepseek-flash': {
          contextWindow: 1_048_576,
          efforts: ['low', 'high', 'max'],
          defaultEffort: 'high',
          fetchedAt: '2026-10-11T00:00:00.000Z'
        }
      }
    })

    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    await waitFor(() => expect(bridge.probeModels).toHaveBeenCalledWith('deepseek'))
    await waitFor(() =>
      expect(
        useSettingsStore.getState().settings.probedModels['deepseek:deepseek-flash']?.contextWindow
      ).toBe(1_048_576)
    )
  })

  it('round 22：连接失败不触发探测（没连上就不去抓）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    bridge.testProvider.mockResolvedValueOnce({ ok: false, message: '认证失败（401）' })

    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    await screen.findByTestId('provider-deepseek-test-result')
    expect(bridge.probeModels).not.toHaveBeenCalled()
  })

  it('失败：原样显示主进程翻译的错误文案', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    bridge.testProvider.mockResolvedValueOnce({
      ok: false,
      message: '认证失败（401）：API Key 无效或没有该模型的权限'
    })

    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    expect(await screen.findByTestId('provider-deepseek-test-result')).toHaveTextContent(
      '连接失败：认证失败（401）'
    )
  })

  it('有未保存的改动时：先保存再测（测的就是聊天接下来要走的那条路）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))

    fireEvent.change(screen.getByTestId('provider-deepseek-model'), {
      target: { value: 'deepseek-v4-pro' }
    })
    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    await waitFor(() => expect(bridge.testProvider).toHaveBeenCalledWith('deepseek'))
    expect(bridge.update).toHaveBeenLastCalledWith({
      providers: [{ ...DEEPSEEK, model: 'deepseek-v4-pro' }]
    })
    expect(bridge.update.mock.invocationCallOrder.at(-1)).toBeLessThan(
      bridge.testProvider.mock.invocationCallOrder[0]
    )
  })

  it('保存失败就不发测试请求（先修配置）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))

    fireEvent.change(screen.getByTestId('provider-deepseek-model'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    expect(await screen.findByTestId('provider-deepseek-error')).toHaveTextContent('磁盘满了')
    expect(bridge.testProvider).not.toHaveBeenCalled()
  })
})
