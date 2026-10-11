import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { RecallStatus } from '@shared/memory'
import { defaultSettings, SEMANTIC_RECALL_PRESET } from '@shared/settings'
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
  it('默认：开关是开的（缺省开）、地址与模型预置成 SiliconFlow 档，用户只需贴 key', async () => {
    const fetchStub = stubRecallFetch({
      state: 'unavailable',
      active: false,
      enabled: true,
      source: 'remote',
      detail: '嵌入服务配置不完整：缺 API Key（这次运行没有召回）'
    })
    installKyclawBridge()
    render(<RecallSettings />)

    expect(screen.getByTestId('recall-enabled')).toHaveAttribute('aria-checked', 'true')
    // 预置值来自 shared/settings 的 SEMANTIC_RECALL_PRESET（缺省即预置：不必手填这两项）
    expect(screen.getByTestId('recall-base-url')).toHaveValue(SEMANTIC_RECALL_PRESET.baseUrl)
    expect(screen.getByTestId('recall-model')).toHaveValue(SEMANTIC_RECALL_PRESET.model)
    expect(await screen.findByTestId('recall-settings-status')).toHaveTextContent('缺 API Key')
    // 状态是问 agent 服务要的现读值（不是设置的期望值）
    await waitFor(() => expect(fetchStub.paths).toContain('/api/memory/recall'))
  })

  it('「获取 API Key」是外部链接（新窗口交给壳层去开系统浏览器）', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    installKyclawBridge()
    render(<RecallSettings />)

    const link = screen.getByTestId('recall-key-link')
    expect(link).toHaveTextContent('获取 API Key')
    expect(link).toHaveAttribute('href', SEMANTIC_RECALL_PRESET.keyUrl)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  it('落盘还空着（没配过）时表单先按预置填：贴一把 key 保存，地址与模型一并落盘', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    // v2 早期落过盘的形状：enabled 开着但地址/模型是空串（本机 userData 现在就是这个）
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        semanticRecall: { enabled: true, source: 'remote', baseUrl: '', model: '', idleMinutes: 5 }
      },
      loaded: true
    })
    render(<RecallSettings />)

    expect(screen.getByTestId('recall-base-url')).toHaveValue(SEMANTIC_RECALL_PRESET.baseUrl)
    expect(screen.getByTestId('recall-model')).toHaveValue(SEMANTIC_RECALL_PRESET.model)

    fireEvent.change(screen.getByTestId('recall-api-key'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByTestId('recall-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        semanticRecall: {
          enabled: true,
          source: 'remote',
          baseUrl: SEMANTIC_RECALL_PRESET.baseUrl,
          model: SEMANTIC_RECALL_PRESET.model,
          idleMinutes: 5
        }
      })
    )
    await waitFor(() => expect(bridge.memory.setEmbeddingKey).toHaveBeenCalledWith('sk-test'))
  })

  it('地址/模型可改成任意 OpenAI 兼容服务（保存的就是用户填的值）', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    render(<RecallSettings />)

    const baseUrl = screen.getByTestId('recall-base-url')
    fireEvent.change(baseUrl, { target: { value: 'https://api.example.com/v1' } })
    expect(baseUrl).toHaveValue('https://api.example.com/v1')
    fireEvent.change(screen.getByTestId('recall-model'), { target: { value: 'my-embed' } })
    fireEvent.click(screen.getByTestId('recall-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        semanticRecall: {
          enabled: true,
          source: 'remote',
          baseUrl: 'https://api.example.com/v1',
          model: 'my-embed',
          idleMinutes: 5
        }
      })
    )
  })

  it('关掉开关：落盘 enabled=false（其余字段保持原值）', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    render(<RecallSettings />)

    fireEvent.click(screen.getByTestId('recall-enabled'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        semanticRecall: {
          enabled: false,
          source: 'remote',
          baseUrl: SEMANTIC_RECALL_PRESET.baseUrl,
          model: SEMANTIC_RECALL_PRESET.model,
          idleMinutes: 5
        }
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
          model: 'text-embedding-3-small',
          idleMinutes: 5
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

  it('嵌入来源切到「本机引擎」：落盘 source，服务三项收起来，改由「本地模型」组接管', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    render(<RecallSettings />)

    // 来源两档都在，缺省是「嵌入服务」
    expect(screen.getByTestId('recall-source-remote')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('recall-base-url')).toBeInTheDocument()
    expect(screen.queryByTestId('local-model-settings')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('recall-source-localEngine'))
    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith(
        expect.objectContaining({
          semanticRecall: expect.objectContaining({ source: 'localEngine' })
        })
      )
    )
  })

  it('来源已经是「本机引擎」时：不显示服务地址/模型/密钥，显示本地模型组', async () => {
    stubRecallFetch({
      state: 'unavailable',
      active: false,
      enabled: true,
      source: 'localEngine',
      detail: '还没有启用本机嵌入模型（这次运行没有召回）'
    })
    installKyclawBridge()
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        semanticRecall: { ...defaultSettings().semanticRecall, source: 'localEngine' }
      },
      loaded: true
    })
    render(<RecallSettings />)

    expect(await screen.findByTestId('local-model-settings')).toBeInTheDocument()
    expect(screen.queryByTestId('recall-base-url')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recall-api-key')).not.toBeInTheDocument()
    expect(screen.getByTestId('recall-settings-status')).toHaveTextContent('还没有启用本机嵌入模型')
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
