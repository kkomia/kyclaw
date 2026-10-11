import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { RecallStatus } from '@shared/memory'
import { defaultSettings } from '@shared/settings'
import { RecallSettings, RecallStatusLine } from '../RecallSettings'
import { recallStatusText } from '../status-text'

/**
 * 设置页「记忆」栏的语义召回组（round 28 模块 3）：开关 + 嵌入服务三项（baseURL/model/key）。
 * 前两项落 settings.json（settings:update），key 走 memory 通道（只进不出）；
 * 状态行说的是"本次运行有没有真挂上 embedder"（改配置要重启应用才生效）。
 *
 * 页面一挂载会去 agent 服务读一次 `/api/memory/recall`：这里把 fetch 换成固定回包
 * （状态行的四种口径在下面单测，组件层只验证"接上了、显示了"）。
 */
function stubRecallFetch(status: RecallStatus): {
  paths: string[]
} {
  const paths: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      paths.push(new URL(String(input)).pathname)
      return new Response(JSON.stringify({ recall: status }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
  )
  return { paths }
}

const OFF: RecallStatus = {
  state: 'off',
  active: false,
  enabled: false,
  source: 'remote',
  detail: '语义召回未开启'
}

beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('状态文案（纯函数）', () => {
  it('设置值与运行事实不一致时由设置值说话', () => {
    expect(recallStatusText(null, true)).toBe('正在读取…')
    expect(recallStatusText(OFF, false)).toBe('未开启')
    expect(recallStatusText({ ...OFF, state: 'active', active: true, enabled: true }, false)).toBe(
      '本次运行已开启，重启应用后停止'
    )
    expect(
      recallStatusText(
        {
          state: 'unavailable',
          active: false,
          enabled: true,
          source: 'remote',
          detail: '嵌入服务配置不完整：缺服务地址（这次运行没有召回）'
        },
        true
      )
    ).toContain('缺服务地址')
  })
})

describe('「记忆」栏的语义召回组', () => {
  it('默认：开关是开的（缺省开）、三项空着，状态行显示服务端那句话', async () => {
    const fetchStub = stubRecallFetch({
      state: 'unavailable',
      active: false,
      enabled: true,
      source: 'remote',
      detail: '嵌入服务配置不完整：缺服务地址、缺模型名、缺 API Key（这次运行没有召回）'
    })
    installKyclawBridge()
    render(<RecallSettings />)

    expect(screen.getByTestId('recall-enabled')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('recall-base-url')).toHaveValue('')
    expect(await screen.findByTestId('recall-settings-status')).toHaveTextContent('缺服务地址')
    // 状态是问 agent 服务要的现读值（不是设置的期望值）
    await waitFor(() => expect(fetchStub.paths).toContain('/api/memory/recall'))
  })

  it('关掉开关：落盘 enabled=false（其余字段保持原值）', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    render(<RecallSettings />)

    fireEvent.click(screen.getByTestId('recall-enabled'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        semanticRecall: { enabled: false, source: 'remote', baseUrl: '', model: '' }
      })
    )
  })

  it('填服务地址/模型 + 密钥保存：设置落 settings.json、密钥走记忆通道（回包不带明文）', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    render(<RecallSettings />)

    fireEvent.change(screen.getByTestId('recall-base-url'), {
      target: { value: ' https://api.example.com/v1 ' }
    })
    fireEvent.change(screen.getByTestId('recall-model'), {
      target: { value: ' text-embedding-3-small ' }
    })
    fireEvent.change(screen.getByTestId('recall-api-key'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByTestId('recall-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        semanticRecall: {
          enabled: true,
          source: 'remote',
          baseUrl: 'https://api.example.com/v1',
          model: 'text-embedding-3-small'
        }
      })
    )
    await waitFor(() => expect(bridge.memory.setEmbeddingKey).toHaveBeenCalledWith('sk-test'))
    // 密钥草稿保存后清空（永远不回显）
    expect(screen.getByTestId('recall-api-key')).toHaveValue('')
  })

  it('已存过密钥：占位提示"要换就填新的"，清除密钥走记忆通道', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    bridge.memory.embeddingKeyState.mockResolvedValue({ hasKey: true, needsReentry: false })
    render(<RecallSettings />)

    const keyInput = await screen.findByTestId('recall-api-key')
    await waitFor(() => expect(keyInput).toHaveAttribute('placeholder', '已保存；要换就填新的'))

    fireEvent.click(screen.getByTestId('recall-clear-key'))
    await waitFor(() => expect(bridge.memory.clearEmbeddingKey).toHaveBeenCalled())
  })
})

describe('记忆页的状态行', () => {
  it('显示开关状态与服务端 detail（本次运行开没开）', async () => {
    stubRecallFetch({
      state: 'active',
      active: true,
      enabled: true,
      source: 'remote',
      detail: '已开启（嵌入服务：text-embedding-3-small）'
    })
    installKyclawBridge()
    render(<RecallStatusLine />)

    expect(await screen.findByTestId('recall-status')).toHaveTextContent('已开启（嵌入服务')
  })
})
