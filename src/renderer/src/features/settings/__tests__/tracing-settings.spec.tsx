import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { DEFAULT_SETTINGS, defaultSettings, LANGFUSE_PRESET } from '@shared/settings'
import { langfuseStatusText } from '../status-text'
import { TracingSettings } from '../TracingSettings'

/**
 * 设置页「追踪」组（T17）：地址落 settings.json、公私钥走 telemetry 通道（只进不出）、
 * 状态行说的是"当前会话有没有真挂上"（配置改动要重启应用才生效）。
 */
function renderTracing(): ReturnType<typeof installKyclawBridge> {
  const bridge = installKyclawBridge()
  render(<TracingSettings />)
  return bridge
}

beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

describe('状态文案（纯函数）', () => {
  const state = (
    over: Partial<NonNullable<Parameters<typeof langfuseStatusText>[0]>> = {}
  ): NonNullable<Parameters<typeof langfuseStatusText>[0]> => ({
    endpoint: 'https://cloud.langfuse.com',
    publicKey: { hasKey: true, needsReentry: false },
    secretKey: { hasKey: true, needsReentry: false },
    active: false,
    ...over
  })

  it('四种组合各一句：已开启 / 已配置待重启 / 本次运行开着 / 未开启', () => {
    expect(langfuseStatusText(null)).toBe('正在读取…')
    expect(langfuseStatusText(state({ active: true }))).toBe('已开启')
    expect(langfuseStatusText(state())).toBe('已配置，重启应用后开启')
    expect(langfuseStatusText(state({ publicKey: { hasKey: false, needsReentry: false } }))).toBe(
      '未开启'
    )
    expect(langfuseStatusText(state({ endpoint: '  ' }))).toBe('未开启')
    expect(
      langfuseStatusText(
        state({ endpoint: '', publicKey: { hasKey: false, needsReentry: false }, active: true })
      )
    ).toBe('本次运行已开启，重启应用后停止')
  })
})

describe('「追踪」组', () => {
  it('默认（没密钥）：状态是未开启；地址预填预置那台，代理空着', async () => {
    renderTracing()

    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启'))
    // round 67：地址的缺省是用户现用的那台自建实例（可见、可改，不是藏在代码里的魔法值）
    expect(screen.getByTestId('langfuse-endpoint')).toHaveValue(LANGFUSE_PRESET.endpoint)
    expect(screen.getByTestId('langfuse-proxy')).toHaveValue('')
    expect(screen.getByTestId('langfuse-public-key')).toHaveValue('')
    expect(screen.getByTestId('langfuse-secret-key')).toHaveValue('')
    expect(screen.queryByTestId('langfuse-clear-keys')).not.toBeInTheDocument()
  })

  it('保存地址 + 代理 + 公私钥：设置走 settings:update（地址与代理一起写）、密钥走 telemetry 通道', async () => {
    const bridge = renderTracing()
    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启'))

    fireEvent.change(screen.getByTestId('langfuse-endpoint'), {
      target: { value: '  http://100.66.1.1:3000  ' }
    })
    fireEvent.change(screen.getByTestId('langfuse-proxy'), {
      target: { value: '127.0.0.1:7890' }
    })
    fireEvent.change(screen.getByTestId('langfuse-public-key'), { target: { value: 'pk-test' } })
    fireEvent.change(screen.getByTestId('langfuse-secret-key'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByTestId('langfuse-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        langfuse: { endpoint: 'http://100.66.1.1:3000', proxyUrl: '127.0.0.1:7890' }
      })
    )
    expect(bridge.telemetry.setLangfuseKeys).toHaveBeenCalledWith('pk-test', 'sk-test')

    // 密钥草稿清空（不回显），状态行跟着落盘结果走
    await waitFor(() =>
      expect(screen.getByTestId('langfuse-status')).toHaveTextContent('已配置，重启应用后开启')
    )
    expect(screen.getByTestId('langfuse-public-key')).toHaveValue('')
    expect(screen.getByTestId('langfuse-secret-key')).toHaveValue('')
    expect(screen.getByTestId('langfuse-proxy')).toHaveValue('127.0.0.1:7890')
  })

  it('只改代理（地址不动）：写进去的是合并后的整节（地址原样带上）', async () => {
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        langfuse: { endpoint: 'http://100.66.1.1:3000', proxyUrl: '' }
      }
    })
    const bridge = installKyclawBridge()
    render(<TracingSettings />)
    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启'))

    fireEvent.change(screen.getByTestId('langfuse-proxy'), {
      target: { value: 'http://127.0.0.1:7890' }
    })
    fireEvent.click(screen.getByTestId('langfuse-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        langfuse: { endpoint: 'http://100.66.1.1:3000', proxyUrl: 'http://127.0.0.1:7890' }
      })
    )
    expect(bridge.telemetry.setLangfuseKeys).not.toHaveBeenCalled()
  })

  it('只填一把密钥：直接拦下来（先判后写，地址/代理不动、密钥不写）', async () => {
    const bridge = renderTracing()
    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启'))

    fireEvent.change(screen.getByTestId('langfuse-endpoint'), {
      target: { value: 'https://cloud.langfuse.com' }
    })
    fireEvent.change(screen.getByTestId('langfuse-public-key'), { target: { value: 'pk-only' } })
    fireEvent.click(screen.getByTestId('langfuse-save'))

    await waitFor(() => expect(screen.getByTestId('langfuse-error')).toBeInTheDocument())
    expect(bridge.telemetry.setLangfuseKeys).not.toHaveBeenCalled()
    expect(bridge.update).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().settings.langfuse.endpoint).toBe(LANGFUSE_PRESET.endpoint)
  })

  it('落盘失败（settings:update 抛）：行内给原因，密钥也不写', async () => {
    const bridge = renderTracing()
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))
    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启'))

    fireEvent.change(screen.getByTestId('langfuse-endpoint'), {
      target: { value: 'https://cloud.langfuse.com' }
    })
    fireEvent.click(screen.getByTestId('langfuse-save'))

    await waitFor(() => expect(screen.getByTestId('langfuse-error')).toHaveTextContent('磁盘满了'))
    expect(bridge.telemetry.setLangfuseKeys).not.toHaveBeenCalled()
  })

  it('已配好密钥时给「清除密钥」入口；清完状态回到未开启、地址还在', async () => {
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        langfuse: { endpoint: 'https://cloud.langfuse.com', proxyUrl: '' }
      }
    })
    const bridge = installKyclawBridge()
    // 模拟"之前配过且本次运行已挂上"：状态里两把密钥都在
    bridge.telemetry.langfuseState.mockResolvedValue({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: true, needsReentry: false },
      secretKey: { hasKey: true, needsReentry: false },
      active: true
    })
    render(<TracingSettings />)

    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('已开启'))
    // 主进程清完回吐的是"密钥没了、本次运行仍开着"（active 是启动时的事实）
    bridge.telemetry.clearLangfuseKeys.mockResolvedValue({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: false, needsReentry: false },
      secretKey: { hasKey: false, needsReentry: false },
      active: true
    })
    fireEvent.click(screen.getByTestId('langfuse-clear-keys'))

    await waitFor(() => expect(bridge.telemetry.clearLangfuseKeys).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('langfuse-status')).toHaveTextContent(
        '本次运行已开启，重启应用后停止'
      )
    )
    expect(useSettingsStore.getState().settings.langfuse.endpoint).toBe(
      'https://cloud.langfuse.com'
    )
  })

  it('密钥解不开（换机）：给"重新录入"的提示', async () => {
    const bridge = renderTracing()
    bridge.telemetry.langfuseState.mockResolvedValue({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: false, needsReentry: true },
      secretKey: { hasKey: false, needsReentry: true },
      active: false
    })
    render(<TracingSettings />)

    await waitFor(() =>
      expect(screen.getByTestId('langfuse-reentry')).toHaveTextContent('请重新录入')
    )
  })

  it('文案零 emoji（雷点 v1 第 1 条）', async () => {
    renderTracing()
    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启'))

    const text = screen.getByTestId('tracing-settings').textContent ?? ''
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false)
  })
})
