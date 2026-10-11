import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'
import { WEB_SEARCH_PRESET } from '@shared/search'
import { WebSearchSettings } from '../WebSearchSettings'

/**
 * 设置页「模型」栏的「联网搜索」组（round 45）：后端模式 + 服务商 + 两个地址 + 三个可选 Key。
 * 模式/服务商当场落盘（settings:update）；两个地址改完点「保存」；三个 Key 走 search 通道
 * （写方向见一次明文，读方向只有"有没有 / 要不要重录"）。
 * 预置口径同思考翻译：落盘为空时表单按预置填，保存写下去的就是表单里看到的。
 */
beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

function withSettings(patch: Partial<ReturnType<typeof defaultSettings>['webSearch']>): void {
  const base = defaultSettings()
  useSettingsStore.setState({
    settings: { ...base, webSearch: { ...base.webSearch, ...patch } },
    loaded: true
  })
}

describe('「联网搜索」组', () => {
  it('默认免费档：只有两个地址；服务商与 Key 输入都不出现', () => {
    installKyclawBridge()
    render(<WebSearchSettings />)

    expect(screen.getByTestId('web-search-mode-free')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('web-search-mode-custom')).toHaveAttribute('aria-pressed', 'false')
    for (const testId of [
      'web-search-provider-exa',
      'web-search-provider-tavily',
      'web-search-exa-key'
    ]) {
      expect(screen.queryByTestId(testId), testId).not.toBeInTheDocument()
    }
    expect(screen.getByTestId('web-search-reader-endpoint')).toBeInTheDocument()
    // Jina Key 与搜索档无关：免费档下也在（正文阅读配额）
    expect(screen.getByTestId('web-search-jina-key')).toBeInTheDocument()
  })

  it('落盘为空串（没配过）时两个地址先按预置填', () => {
    installKyclawBridge()
    withSettings({ exaEndpoint: '', readerEndpoint: '' })
    render(<WebSearchSettings />)

    expect(screen.getByTestId('web-search-exa-endpoint')).toHaveValue(WEB_SEARCH_PRESET.exaEndpoint)
    expect(screen.getByTestId('web-search-reader-endpoint')).toHaveValue(
      WEB_SEARCH_PRESET.readerEndpoint
    )
  })

  it('切到自定义 Key：出现服务商二选一与该服务商的 Key 输入；点 Tavily 换成它的输入', async () => {
    const bridge = installKyclawBridge()
    render(<WebSearchSettings />)

    fireEvent.click(screen.getByTestId('web-search-mode-custom'))
    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith(
        expect.objectContaining({ webSearch: expect.objectContaining({ mode: 'custom' }) })
      )
    )
    expect(screen.getByTestId('web-search-provider-exa')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('web-search-exa-key')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('web-search-provider-tavily'))
    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith(
        expect.objectContaining({ webSearch: expect.objectContaining({ provider: 'tavily' }) })
      )
    )
    expect(screen.getByTestId('web-search-tavily-key')).toBeInTheDocument()
  })

  it('保存：地址落盘（trim 后）+ 填了 Key 就走 search 通道；保存后 Key 草稿清空', async () => {
    const bridge = installKyclawBridge()
    withSettings({ mode: 'custom', provider: 'tavily' })
    render(<WebSearchSettings />)

    fireEvent.change(screen.getByTestId('web-search-reader-endpoint'), {
      target: { value: '  https://reader.example.com  ' }
    })
    fireEvent.change(screen.getByTestId('web-search-tavily-key'), {
      target: { value: 'tvly-1' }
    })
    fireEvent.change(screen.getByTestId('web-search-jina-key'), { target: { value: 'jina-1' } })
    fireEvent.click(screen.getByTestId('web-search-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        webSearch: {
          mode: 'custom',
          provider: 'tavily',
          exaEndpoint: WEB_SEARCH_PRESET.exaEndpoint,
          readerEndpoint: 'https://reader.example.com'
        }
      })
    )
    await waitFor(() => expect(bridge.search.setKey).toHaveBeenCalledWith('tavily', 'tvly-1'))
    expect(bridge.search.setKey).toHaveBeenCalledWith('jina', 'jina-1')
    // 保存后草稿清空（Key 永远不回显）
    await waitFor(() => expect(screen.getByTestId('web-search-tavily-key')).toHaveValue(''))
    expect(screen.getByTestId('web-search-jina-key')).toHaveValue('')
  })

  it('已存的 Key：显示"已配置"与「清除密钥」，点了走 search 通道并回到"未配置"', async () => {
    const bridge = installKyclawBridge()
    await bridge.search.setKey('exa', 'stored')
    withSettings({ mode: 'custom', provider: 'exa' })
    render(<WebSearchSettings />)

    await waitFor(() =>
      expect(screen.getByTestId('web-search-exa-key-status')).toHaveTextContent('已配置')
    )
    fireEvent.click(screen.getByTestId('web-search-exa-clear'))

    await waitFor(() => expect(bridge.search.clearKey).toHaveBeenCalledWith('exa'))
    await waitFor(() =>
      expect(screen.getByTestId('web-search-exa-key-status')).toHaveTextContent('未配置')
    )
  })

  it('通道不可用（window.kyclaw 缺失）：给一句交代，不静默', async () => {
    withSettings({ mode: 'custom', provider: 'exa' })
    render(<WebSearchSettings />)

    fireEvent.change(screen.getByTestId('web-search-exa-key'), { target: { value: 'k' } })
    fireEvent.click(screen.getByTestId('web-search-save'))

    await waitFor(() =>
      expect(screen.getByTestId('web-search-error')).toHaveTextContent(/通道不可用/)
    )
  })
})
