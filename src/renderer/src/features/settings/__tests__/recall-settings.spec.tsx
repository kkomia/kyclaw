import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { RecallStatus } from '@shared/memory'
import { defaultSettings, SEMANTIC_RECALL_PRESET, type AppSettings } from '@shared/settings'
import { RecallSettings, RecallStatusLine } from '../RecallSettings'
import { recallStatusText } from '../status-text'

/**
 * 设置页「记忆」栏的语义召回组（round 28 模块 3；本轮设置页重组）：
 *
 *   - **常显** = 开关（标签就叫「语义召回」）+ 本次运行的真实状态 + 一句"只管历史检索"的说明；
 *   - **次级（「配置」，默认收起）** = 嵌入来源 / 服务地址 / 模型 / 密钥 / 「本地模型」组 / 保存。
 *
 * 两条硬口径钉在这里：
 *   1. **收起配置也要关得掉**——开关是就地落盘（不进草稿、不等那颗被收起来的「保存」），
 *      失败与结果都在收起时看得见（错误行与回执行都不收进展开区）；
 *   2. **折叠不丢草稿**——草稿在组件的 state 里，收起只是把次级区卸下来。
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

/** 「配置」按钮：次级配置区的展开 / 收起（默认收起） */
function toggleConfig(): void {
  fireEvent.click(screen.getByTestId('recall-config-toggle'))
}

/** 关闭语义召回时那次就地落盘的完整形状（其余字段保持原值） */
function recallPatch(patch: Partial<AppSettings['semanticRecall']>): {
  semanticRecall: AppSettings['semanticRecall']
} {
  return { semanticRecall: { ...defaultSettings().semanticRecall, ...patch } }
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

describe('收起时只露开关、真实状态与一句说明', () => {
  it('默认：开关标「语义召回」且是开的，状态是问服务要的现读值，模型/地址/密钥/本地模型/保存都不在', async () => {
    const fetchStub = stubRecallFetch({
      state: 'unavailable',
      active: false,
      enabled: true,
      source: 'remote',
      detail: '嵌入服务配置不完整：缺 API Key（这次运行没有召回）'
    })
    installKyclawBridge()
    render(<RecallSettings />)

    // 开关的可见标签与可访问名都是「语义召回」（不叫"会话记忆"：它不是记忆的总开关）
    expect(screen.getByText('语义召回')).toBeInTheDocument()
    const toggle = screen.getByTestId('recall-enabled')
    expect(toggle).toHaveAttribute('aria-label', '语义召回')
    expect(toggle).toHaveAttribute('aria-checked', 'true')

    // 状态是问 agent 服务要的现读值（不是设置的期望值）
    await waitFor(() =>
      expect(screen.getByTestId('recall-settings-status')).toHaveTextContent('缺 API Key')
    )
    await waitFor(() => expect(fetchStub.paths).toContain('/api/memory/recall'))

    // 一句说明说清它管什么：只管历史检索，不关闭也不清除会话记忆
    const note = screen.getByTestId('recall-scope-note')
    expect(note).toHaveTextContent('只影响历史检索')
    expect(note).toHaveTextContent('不会关闭或清除当前会话的记忆')

    // 「配置」默认收起：次级那几件一件都不在文档里
    const config = screen.getByTestId('recall-config-toggle')
    expect(config).toHaveAttribute('aria-expanded', 'false')
    expect(config).toHaveTextContent('配置')
    expect(screen.queryByTestId('recall-base-url')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recall-model')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recall-api-key')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recall-key-link')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recall-save')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recall-source-remote')).not.toBeInTheDocument()
    expect(screen.queryByTestId('local-model-settings')).not.toBeInTheDocument()
  })

  it('收起时关掉开关照样落盘（不靠被收起来的「保存」），状态行按设置值说话', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    render(<RecallSettings />)

    // 收起着：那颗「保存」根本不在文档里 —— 关得掉不靠它
    expect(screen.queryByTestId('recall-save')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('recall-enabled'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith(recallPatch({ enabled: false, source: 'remote' }))
    )
    await waitFor(() =>
      expect(screen.getByTestId('recall-enabled')).toHaveAttribute('aria-checked', 'false')
    )
    // 本次运行还挂着召回（active），但设置值已经说"关" —— 由设置值说话，且收起时也看得见
    await waitFor(() =>
      expect(screen.getByTestId('recall-settings-status')).toHaveTextContent(
        '本次运行已开启，重启应用后停止'
      )
    )
    expect(screen.queryByTestId('recall-error')).not.toBeInTheDocument()
  })

  it('收起时落盘失败：错误行看得见，开关不假装已经关掉', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(
      new Error("Error invoking remote method 'settings:update': Error: 写设置失败")
    )
    render(<RecallSettings />)

    fireEvent.click(screen.getByTestId('recall-enabled'))

    // 反馈不收进展开区：收起时也看得见（剥掉 IPC 包装的人话）
    expect(await screen.findByTestId('recall-error')).toHaveTextContent('写设置失败')
    // 设置值没变 → 开关、状态行都不跟着撒谎
    expect(screen.getByTestId('recall-enabled')).toHaveAttribute('aria-checked', 'true')
  })

  it('密钥读不到（换机/迁移）：收起时也看得见这条要用户动手的提醒', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    installKyclawBridge().memory.embeddingKeyState.mockResolvedValue({
      hasKey: false,
      needsReentry: true
    })
    render(<RecallSettings />)

    expect(await screen.findByTestId('recall-reentry')).toHaveTextContent('请重新录入')
    expect(screen.queryByTestId('recall-api-key')).not.toBeInTheDocument()
  })
})

describe('配置区（「配置」展开后才动，默认收起）', () => {
  it('展开：地址与模型预置成 SiliconFlow 档、保存与来源都在；再点收起又收回去', () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    installKyclawBridge()
    render(<RecallSettings />)

    toggleConfig()
    const config = screen.getByTestId('recall-config-toggle')
    expect(config).toHaveAttribute('aria-expanded', 'true')
    expect(config).toHaveTextContent('收起')

    // 预置值来自 shared/settings 的 SEMANTIC_RECALL_PRESET（缺省即预置：不必手填这两项）
    expect(screen.getByTestId('recall-base-url')).toHaveValue(SEMANTIC_RECALL_PRESET.baseUrl)
    expect(screen.getByTestId('recall-model')).toHaveValue(SEMANTIC_RECALL_PRESET.model)
    expect(screen.getByTestId('recall-source-remote')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('recall-save')).toBeInTheDocument()
    // 生效时机那句也在次级里（装配只在启动时做一次，保存是"落盘"不是"当场换掉"）
    expect(screen.getByTestId('recall-restart-note')).toHaveTextContent('重启应用才生效')

    toggleConfig()
    expect(screen.getByTestId('recall-config-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('recall-base-url')).not.toBeInTheDocument()
  })

  it('折叠不丢草稿：改完收起、再展开值还在，保存写下去的就是它', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    render(<RecallSettings />)

    toggleConfig()
    fireEvent.change(screen.getByTestId('recall-base-url'), {
      target: { value: ' https://api.example.com/v1 ' }
    })
    fireEvent.change(screen.getByTestId('recall-model'), { target: { value: 'my-embed' } })
    fireEvent.change(screen.getByTestId('recall-api-key'), { target: { value: 'sk-test' } })

    toggleConfig()
    expect(screen.queryByTestId('recall-base-url')).not.toBeInTheDocument()
    toggleConfig()

    // 收起只是把次级区卸下来：草稿还在组件里（不丢、不回落盘值）
    expect(screen.getByTestId('recall-base-url')).toHaveValue(' https://api.example.com/v1 ')
    expect(screen.getByTestId('recall-model')).toHaveValue('my-embed')
    expect(screen.getByTestId('recall-api-key')).toHaveValue('sk-test')

    fireEvent.click(screen.getByTestId('recall-save'))
    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith(
        recallPatch({ baseUrl: 'https://api.example.com/v1', model: 'my-embed' })
      )
    )
    await waitFor(() => expect(bridge.memory.setEmbeddingKey).toHaveBeenCalledWith('sk-test'))
  })

  it('开关关着也能把服务配好：配置不跟着开关一起消失', async () => {
    stubRecallFetch({ ...OFF, enabled: false })
    const settings: AppSettings = {
      ...defaultSettings(),
      semanticRecall: { ...defaultSettings().semanticRecall, enabled: false }
    }
    installKyclawBridge(settings)
    useSettingsStore.setState({ settings, loaded: true })
    render(<RecallSettings />)

    expect(screen.getByTestId('recall-enabled')).toHaveAttribute('aria-checked', 'false')
    // 状态行问服务要现读值（关着 = 未开启），不等它的回包就先断言会读到"正在读取…"
    await waitFor(() =>
      expect(screen.getByTestId('recall-settings-status')).toHaveTextContent('未开启')
    )

    toggleConfig()
    expect(screen.getByTestId('recall-base-url')).toBeInTheDocument()
    expect(screen.getByTestId('recall-save')).toBeInTheDocument()
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

    toggleConfig()
    expect(screen.getByTestId('recall-base-url')).toHaveValue(SEMANTIC_RECALL_PRESET.baseUrl)
    expect(screen.getByTestId('recall-model')).toHaveValue(SEMANTIC_RECALL_PRESET.model)

    fireEvent.change(screen.getByTestId('recall-api-key'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByTestId('recall-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith(
        recallPatch({
          baseUrl: SEMANTIC_RECALL_PRESET.baseUrl,
          model: SEMANTIC_RECALL_PRESET.model
        })
      )
    )
    await waitFor(() => expect(bridge.memory.setEmbeddingKey).toHaveBeenCalledWith('sk-test'))
  })

  it('地址/模型可改成任意 OpenAI 兼容服务（保存的就是用户填的值）', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    render(<RecallSettings />)

    toggleConfig()
    const baseUrl = screen.getByTestId('recall-base-url')
    fireEvent.change(baseUrl, { target: { value: 'https://api.example.com/v1' } })
    expect(baseUrl).toHaveValue('https://api.example.com/v1')
    fireEvent.change(screen.getByTestId('recall-model'), { target: { value: 'my-embed' } })
    fireEvent.click(screen.getByTestId('recall-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith(
        recallPatch({ baseUrl: 'https://api.example.com/v1', model: 'my-embed' })
      )
    )
  })

  it('填服务地址/模型 + 密钥保存：设置落 settings.json、密钥走记忆通道（回包不带明文）', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    render(<RecallSettings />)

    toggleConfig()
    fireEvent.change(screen.getByTestId('recall-base-url'), {
      target: { value: ' https://api.example.com/v1 ' }
    })
    fireEvent.change(screen.getByTestId('recall-model'), {
      target: { value: ' text-embedding-3-small ' }
    })
    fireEvent.change(screen.getByTestId('recall-api-key'), { target: { value: 'sk-test' } })
    fireEvent.click(screen.getByTestId('recall-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith(
        recallPatch({ baseUrl: 'https://api.example.com/v1', model: 'text-embedding-3-small' })
      )
    )
    await waitFor(() => expect(bridge.memory.setEmbeddingKey).toHaveBeenCalledWith('sk-test'))
    // 密钥草稿保存后清空（永远不回显）
    expect(screen.getByTestId('recall-api-key')).toHaveValue('')
    // 012：保存要有结果反馈
    await waitFor(() => expect(screen.getByTestId('recall-notice')).toHaveTextContent('已保存'))
  })

  it('已存过密钥：占位提示"要换就填新的"，清除密钥走记忆通道', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    bridge.memory.embeddingKeyState.mockResolvedValue({ hasKey: true, needsReentry: false })
    render(<RecallSettings />)

    toggleConfig()
    const keyInput = await screen.findByTestId('recall-api-key')
    await waitFor(() => expect(keyInput).toHaveAttribute('placeholder', '已保存；要换就填新的'))

    fireEvent.click(screen.getByTestId('recall-clear-key'))
    await waitFor(() => expect(bridge.memory.clearEmbeddingKey).toHaveBeenCalled())
    // 012：清除密钥也要有结果反馈
    await waitFor(() => expect(screen.getByTestId('recall-notice')).toHaveTextContent('密钥已清除'))
  })

  it('「获取 API Key」是外部链接（新窗口交给壳层去开系统浏览器）', () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    installKyclawBridge()
    render(<RecallSettings />)

    toggleConfig()
    const link = screen.getByTestId('recall-key-link')
    expect(link).toHaveTextContent('获取 API Key')
    expect(link).toHaveAttribute('href', SEMANTIC_RECALL_PRESET.keyUrl)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
  })

  it('嵌入来源切到「本机引擎」：落盘 source，服务三项收起来，改由「本地模型」组接管', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    render(<RecallSettings />)

    toggleConfig()
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

    toggleConfig()
    expect(await screen.findByTestId('local-model-settings')).toBeInTheDocument()
    expect(screen.queryByTestId('recall-base-url')).not.toBeInTheDocument()
    expect(screen.queryByTestId('recall-api-key')).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('recall-settings-status')).toHaveTextContent(
        '还没有启用本机嵌入模型'
      )
    )
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

    expect(await screen.findByTestId('recall-status')).toHaveTextContent(
      '语义召回：已开启（嵌入服务'
    )
  })
})

/**
 * 012（用户口径）：保存成功后又改了输入，「已保存」要立刻消失 —— 那句话描述的是**落盘的那一份**。
 * 010 收口：就地写入（开关 / 嵌入来源）一次只写一条，连点两下不并发发两次 settings:update。
 */
describe('保存反馈与就地写入串行（012 / 010）', () => {
  it('012：保存成功后改服务地址 → 「已保存」立刻消失；收起配置也收不走这条回执', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    render(<RecallSettings />)

    toggleConfig()
    fireEvent.change(screen.getByTestId('recall-base-url'), {
      target: { value: 'https://api.example.com/v1' }
    })
    fireEvent.click(screen.getByTestId('recall-save'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalled())
    expect(await screen.findByTestId('recall-notice')).toHaveTextContent('已保存')

    // 回执行不收进展开区：收起配置后它还看得见（刚发生那件事的回执）
    toggleConfig()
    expect(screen.getByTestId('recall-notice')).toHaveTextContent('已保存')

    toggleConfig()
    fireEvent.change(screen.getByTestId('recall-base-url'), {
      target: { value: 'https://api.example.com/v2' }
    })
    expect(screen.queryByTestId('recall-notice')).not.toBeInTheDocument()
    expect(screen.getByTestId('recall-base-url')).toHaveValue('https://api.example.com/v2')
  })

  it('010：落盘挂着不回来时开关按下即锁住，第二下不再发一次 settings:update', async () => {
    stubRecallFetch({ ...OFF, enabled: true, state: 'active', active: true })
    const bridge = installKyclawBridge()
    bridge.update.mockImplementationOnce(() => new Promise<AppSettings>(() => {}))
    render(<RecallSettings />)

    const toggle = screen.getByTestId('recall-enabled')
    fireEvent.click(toggle)

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        semanticRecall: expect.objectContaining({ enabled: false })
      })
    )
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(bridge.update).toHaveBeenCalledTimes(1)
  })
})
