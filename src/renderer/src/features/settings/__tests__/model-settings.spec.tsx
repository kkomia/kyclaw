import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearKyclawBridge,
  installKyclawBridge,
  passingConnectionTest
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type AppSettings } from '@shared/settings'
import type { ProviderConfig } from '@shared/providers'
import { ModelSettings } from '../ModelSettings'

/**
 * 设置页「模型」组（T8，RTL；round 48 改成"折叠列表 + 新增弹窗"）：
 *   - 新增走右上角「新增」弹窗：渠道下拉（内置 / 自定义）→ 字段 → 添加即落盘；已添加的内置渠道置灰；
 *   - 新建成功 = 弹窗关闭 + 新行**自动展开**；失败留弹窗里报原因（不关窗）；
 *   - 已配置：默认折叠只显示名字 / 模型名 / 上下文 / 能力图标 / 默认徽章；点行展开编辑；
 *   - key 只写不回显：保存后输入框清空、状态"已配置"、整页文本不含明文；
 *   - 半截配置在展开区行内报"配置不完整：缺 X"；解不开的密钥引导重录（Review Focus #5）；
 *   - 测试连接：先存后测，分项显示三步结论 + 验证范围（005）；
 *   - 保存反馈（012）：存完给"已保存"，但只要再动一下草稿就立刻收掉；保存期间又改草稿时
 *     新改动一个字都不丢、反馈也不谎报（见文件末尾那一组）。
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

/** 折叠行头（`aria-expanded` 就在它身上；点整行 = 展开/收起） */
function row(id: string): HTMLElement {
  return screen.getByTestId(`provider-${id}`).querySelector('button') as HTMLElement
}

/** 点开某一行（编辑控件都在展开区里；折叠时不进 DOM —— 与 TraceFold 的"开过一次才常驻"口径一致） */
function expand(id: string): void {
  fireEvent.click(row(id))
}

/** 走新弹窗加一条渠道：开窗 → 渠道下拉 → （可选）字段 → 添加 */
function addViaDialog(
  channelTestId: string,
  fields: { model?: string; baseUrl?: string; key?: string } = {}
): void {
  fireEvent.click(screen.getByTestId('model-add'))
  fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
  fireEvent.click(screen.getByTestId(channelTestId))
  if (fields.model !== undefined) {
    fireEvent.change(screen.getByTestId('model-add-model'), { target: { value: fields.model } })
  }
  if (fields.baseUrl !== undefined) {
    fireEvent.change(screen.getByTestId('model-add-base-url'), {
      target: { value: fields.baseUrl }
    })
  }
  if (fields.key !== undefined) {
    fireEvent.change(screen.getByTestId('model-add-key'), { target: { value: fields.key } })
  }
  fireEvent.click(screen.getByTestId('model-add-submit'))
}

beforeEach(() => {
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

describe('模型组 · 折叠行（默认全折叠）', () => {
  it('只显示最基本的信息：名字 + 模型名 + 上下文 + 默认徽章；编辑控件不进 DOM', async () => {
    await mount(withProviders(DEEPSEEK, OPENAI))

    const line = row('deepseek')
    expect(line).toHaveTextContent('DeepSeek')
    expect(line).toHaveTextContent('deepseek-flash')
    expect(line).toHaveTextContent('128K')
    expect(line).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('provider-deepseek-default-badge')).toHaveTextContent('默认')
    // 没点开之前不占位：模型/Base URL/API Key 与保存/测试/删除都不进 DOM
    expect(screen.queryByTestId('provider-deepseek-model')).not.toBeInTheDocument()
    expect(screen.queryByTestId('provider-deepseek-base-url')).not.toBeInTheDocument()
    expect(screen.queryByTestId('provider-deepseek-key')).not.toBeInTheDocument()
    expect(screen.queryByTestId('provider-deepseek-save')).not.toBeInTheDocument()
    expect(screen.queryByTestId('provider-deepseek-test')).not.toBeInTheDocument()
    expect(screen.queryByTestId('provider-deepseek-remove')).not.toBeInTheDocument()
    expect(screen.queryByTestId('provider-deepseek-key-status')).not.toBeInTheDocument()
  })

  it('点行展开：编辑能力原样都在（模型/BaseURL/Key/保存/测试/设为默认/删除/密钥状态）', async () => {
    await mount(withProviders(DEEPSEEK, OPENAI))

    expand('openai')

    expect(row('openai')).toHaveAttribute('aria-expanded', 'true')
    expect(input('provider-openai-model').value).toBe('gpt-4o-mini')
    expect(input('provider-openai-base-url').value).toBe('https://api.openai.com/v1')
    expect(input('provider-openai-key').value).toBe('')
    expect(screen.getByTestId('provider-openai-save')).toBeInTheDocument()
    expect(screen.getByTestId('provider-openai-test')).toBeInTheDocument()
    expect(screen.getByTestId('provider-openai-remove')).toBeInTheDocument()
    expect(screen.getByTestId('provider-openai-key-status')).toBeInTheDocument()
    // 已经是默认的那条不再有「设为默认」（既有口径）；不是默认的那条才有
    expect(screen.getByTestId('provider-openai-set-default')).toBeInTheDocument()
    expect(screen.queryByTestId('provider-deepseek-set-default')).not.toBeInTheDocument()
    // 展开一条不影响另一条：默认那条还折着
    expect(row('deepseek')).toHaveAttribute('aria-expanded', 'false')
  })

  it('上下文与能力图标取实测（probed 优先）：1M 且能看图时两个标记都在', async () => {
    await mount({
      ...withProviders(DEEPSEEK),
      probedModels: {
        'deepseek:deepseek-flash': {
          contextWindow: 1_048_576,
          vision: true,
          fetchedAt: '2026-10-11T00:00:00.000Z'
        }
      }
    })

    expect(row('deepseek')).toHaveTextContent('1M')
    expect(screen.getByTestId('provider-deepseek-vision')).toHaveAccessibleName('看图')
  })

  it('探测结论是没有视觉能力：折叠行不摆那个图标', async () => {
    await mount({
      ...withProviders(DEEPSEEK),
      probedModels: { 'deepseek:deepseek-flash': { vision: false } }
    })

    expect(screen.queryByTestId('provider-deepseek-vision')).not.toBeInTheDocument()
  })

  it('再点一次收起：折叠态回到 false（内容留在 DOM 里跑过渡，不硬切）', async () => {
    await mount(withProviders(DEEPSEEK))

    expand('deepseek')
    expect(screen.getByTestId('provider-deepseek-save')).toBeInTheDocument()
    expect(
      screen.getByTestId('provider-deepseek').querySelector('[data-testid="trace-fold"]')
    ).toHaveAttribute('data-open', 'true')

    expand('deepseek')
    expect(row('deepseek')).toHaveAttribute('aria-expanded', 'false')
    // 开过一次之后内容常驻（TraceFold 的过渡要对象），折叠态由容器的 data-open 驱动
    expect(
      screen.getByTestId('provider-deepseek').querySelector('[data-testid="trace-fold"]')
    ).toHaveAttribute('data-open', 'false')
  })
})

describe('模型组 · 新增弹窗', () => {
  it('空态指向新入口；页面上不再有渠道 chips，只有右上角「新增」', async () => {
    await mount(defaultSettings())

    expect(screen.getByTestId('model-empty')).toHaveTextContent('点右上角「新增」')
    expect(screen.getByTestId('model-add')).toBeInTheDocument()
    // round 48（用户口径）：动作在组标题行、**卡外**的右端 —— 不塞进圆角卡里
    expect(screen.getByTestId('settings-group-model')).toContainElement(
      screen.getByTestId('model-add')
    )
    expect(screen.getByTestId('model-add').closest('.rounded-panel')).toBeNull()
    expect(screen.queryByTestId('provider-presets')).not.toBeInTheDocument()
    for (const preset of ['deepseek', 'moonshot', 'openai', 'anthropic']) {
      expect(screen.queryByTestId(`add-preset-${preset}`), preset).not.toBeInTheDocument()
    }
    expect(screen.queryByTestId('add-custom-openai-compatible')).not.toBeInTheDocument()
    expect(screen.queryByTestId('add-custom-anthropic')).not.toBeInTheDocument()
    // 没点之前弹窗不在 DOM 里
    expect(screen.queryByTestId('model-add-channel')).not.toBeInTheDocument()
  })

  it('选内置渠道：预设名预填、Base URL 可改，添加后落盘 + 关窗 + 新行自动展开', async () => {
    const bridge = await mount(defaultSettings())

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-preset-deepseek'))
    expect(input('model-add-model').value).toBe('deepseek-flash')
    expect(input('model-add-base-url').value).toBe('https://api.deepseek.com')

    fireEvent.click(screen.getByTestId('model-add-submit'))

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
    // 关窗
    await waitFor(() => expect(screen.queryByTestId('model-add-channel')).not.toBeInTheDocument())
    // 新行在、且已经展开（编辑控件可见），信息也对得上
    expect(row('deepseek')).toHaveAttribute('aria-expanded', 'true')
    expect(input('provider-deepseek-model').value).toBe('deepseek-flash')
    expect(screen.getByTestId('provider-deepseek-default-badge')).toHaveTextContent('默认')
  })

  it('自定义：id 递增、字段从空开始，填完才落一条能用的', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-custom-openai-compatible'))
    expect(input('model-add-model').value).toBe('')
    expect(input('model-add-base-url').value).toBe('')

    fireEvent.change(screen.getByTestId('model-add-model'), { target: { value: 'my-model' } })
    fireEvent.change(screen.getByTestId('model-add-base-url'), {
      target: { value: 'https://gateway.example.com/v1' }
    })
    fireEvent.click(screen.getByTestId('model-add-submit'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenLastCalledWith({
        providers: [
          DEEPSEEK,
          {
            id: 'custom-1',
            type: 'openai-compatible',
            baseUrl: 'https://gateway.example.com/v1',
            model: 'my-model',
            isDefault: false
          }
        ]
      })
    )
  })

  it('缺模型名 / 缺 Base URL：弹窗里报（人话），不落盘、不关窗', async () => {
    const bridge = await mount(defaultSettings())

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-custom-openai-compatible'))
    fireEvent.click(screen.getByTestId('model-add-submit'))

    expect(await screen.findByTestId('model-add-error')).toHaveTextContent(
      '配置不完整：缺模型名；缺 Base URL'
    )
    expect(bridge.update).not.toHaveBeenCalled()
    expect(screen.getByTestId('model-add-channel')).toBeInTheDocument()
  })

  it('001：已添加的内置渠道不再置灰——选中它就是"给这条端点加模型"（不新建、不再要 key）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    bridge.listProviderModels.mockResolvedValue([
      { id: 'deepseek-flash', contextWindow: 1_048_576 },
      { id: 'deepseek-v4-pro' }
    ])

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    expect(screen.getByTestId('model-add-channel-preset-deepseek')).not.toHaveAttribute(
      'data-disabled'
    )
    expect(screen.getByTestId('model-add-channel-preset-deepseek')).toHaveTextContent('加模型')
    fireEvent.click(screen.getByTestId('model-add-channel-preset-deepseek'))

    // 进"给端点加模型"这一档：一句话说明，且不再问 Base URL / API Key
    expect(await screen.findByTestId('model-add-append-hint')).toHaveTextContent('DeepSeek')
    expect(screen.queryByTestId('model-add-key')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-add-base-url')).not.toBeInTheDocument()

    // 007：端点上读到的模型列出来供选（带实测上下文长度），选中即填进"模型"
    await waitFor(() => expect(bridge.listProviderModels).toHaveBeenCalledWith('deepseek'))
    fireEvent.keyDown(screen.getByTestId('model-add-available'), { key: 'ArrowDown' })
    expect(screen.getByTestId('model-add-available-deepseek-v4-pro')).not.toHaveTextContent('128K')
    expect(screen.getByTestId('model-add-available-deepseek-flash')).toHaveTextContent('1M')
    fireEvent.click(screen.getByTestId('model-add-available-deepseek-v4-pro'))
    expect(input('model-add-model').value).toBe('deepseek-v4-pro')

    fireEvent.click(screen.getByTestId('model-add-submit'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenLastCalledWith({
        providers: [
          { ...DEEPSEEK, model: 'deepseek-v4-pro', models: ['deepseek-flash', 'deepseek-v4-pro'] }
        ]
      })
    )
    expect(bridge.setProviderKey).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().settings.providers).toHaveLength(1)
  })

  it('001：自定义里填了一条已存在的 baseUrl（尾斜杠不算差别）→ 同样走"往这条端点加模型"', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    bridge.listProviderModels.mockResolvedValue([{ id: 'deepseek-v4-pro' }])

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-custom-openai-compatible'))
    fireEvent.change(screen.getByTestId('model-add-base-url'), {
      target: { value: 'https://api.deepseek.com/' }
    })

    expect(await screen.findByTestId('model-add-append-hint')).toHaveTextContent('DeepSeek')
    expect(screen.queryByTestId('model-add-key')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('model-add-model'), { target: { value: '第三个模型' } })
    fireEvent.click(screen.getByTestId('model-add-submit'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenLastCalledWith({
        providers: [{ ...DEEPSEEK, model: '第三个模型', models: ['deepseek-flash', '第三个模型'] }]
      })
    )
  })

  it('007：读不到这条端点的清单（端点没有 /models）→ 一行提示，手填照样能加（不是硬错）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    bridge.listProviderModels.mockRejectedValue(new Error('模型清单请求失败（404）'))

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-preset-deepseek'))

    expect(await screen.findByTestId('model-add-available-empty')).toHaveTextContent('手填')
    expect(screen.queryByTestId('model-add-error')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('model-add-model'), { target: { value: '手填的模型' } })
    fireEvent.click(screen.getByTestId('model-add-submit'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenLastCalledWith({
        providers: [{ ...DEEPSEEK, model: '手填的模型', models: ['deepseek-flash', '手填的模型'] }]
      })
    )
  })

  it('007（补齐）：新渠道填好地址后「发现模型」——用刚填的入参问一次，选中即填进模型栏', async () => {
    const bridge = await mount(defaultSettings())
    bridge.discoverProviderModels.mockResolvedValueOnce({
      ok: true,
      models: [{ id: 'qwen3-max', contextWindow: 262_144 }, { id: 'qwen3-coder' }]
    })

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-custom-openai-compatible'))

    // 地址没填之前按钮是灰的（不让用户点了才吃一个必败的请求）；密钥**不是**必要条件，见下一个用例
    expect(screen.getByTestId('model-add-discover')).toBeDisabled()

    fireEvent.change(screen.getByTestId('model-add-base-url'), {
      target: { value: 'https://dashscope.example.com/v1' }
    })
    fireEvent.change(screen.getByTestId('model-add-key'), { target: { value: KEY } })
    expect(screen.getByTestId('model-add-discover')).not.toBeDisabled()

    fireEvent.click(screen.getByTestId('model-add-discover'))

    await waitFor(() =>
      expect(bridge.discoverProviderModels).toHaveBeenCalledWith({
        type: 'openai-compatible',
        baseUrl: 'https://dashscope.example.com/v1',
        apiKey: KEY
      })
    )
    // 密钥只在这一次调用里过桥：既没落盘、也没写进密钥存储
    expect(bridge.update).not.toHaveBeenCalled()
    expect(bridge.setProviderKey).not.toHaveBeenCalled()
    expect(document.body.textContent ?? '').not.toContain(KEY)

    fireEvent.keyDown(screen.getByTestId('model-add-discovered'), { key: 'ArrowDown' })
    expect(screen.getByTestId('model-add-discovered-qwen3-max')).toHaveTextContent('262K')
    fireEvent.click(screen.getByTestId('model-add-discovered-qwen3-coder'))
    expect(input('model-add-model').value).toBe('qwen3-coder')
  })

  it('007（补齐）：只填地址（LM Studio 那类本机服务不要密钥）也能发现——不替服务一刀切', async () => {
    const bridge = await mount(defaultSettings())
    bridge.discoverProviderModels.mockResolvedValueOnce({
      ok: true,
      models: [{ id: 'local-model' }]
    })

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-custom-openai-compatible'))
    fireEvent.change(screen.getByTestId('model-add-base-url'), {
      target: { value: 'http://127.0.0.1:1234/v1' }
    })

    // 没填密钥也**不是**灰的：本机服务压根不要密钥，能不能用由端点自己回
    expect(screen.getByTestId('model-add-discover')).not.toBeDisabled()
    expect(screen.getByTestId('model-add-discover-hint')).toHaveTextContent('本机服务不用密钥')

    fireEvent.click(screen.getByTestId('model-add-discover'))

    await waitFor(() =>
      expect(bridge.discoverProviderModels).toHaveBeenCalledWith({
        type: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: ''
      })
    )
    fireEvent.keyDown(screen.getByTestId('model-add-discovered'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-discovered-local-model'))
    expect(input('model-add-model').value).toBe('local-model')
  })

  it('007（补齐）：发现失败给原因（不是硬错）：手填照样能加，密钥照旧走保存那条路', async () => {
    const bridge = await mount(defaultSettings())
    bridge.discoverProviderModels.mockResolvedValueOnce({
      ok: false,
      message: '认证失败（401）：换一把能访问这个端点的 API Key 再试'
    })

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-custom-openai-compatible'))
    fireEvent.change(screen.getByTestId('model-add-base-url'), {
      target: { value: 'https://a.example.com/v1' }
    })
    fireEvent.change(screen.getByTestId('model-add-key'), { target: { value: KEY } })
    fireEvent.click(screen.getByTestId('model-add-discover'))

    expect(await screen.findByTestId('model-add-discover-error')).toHaveTextContent(
      '认证失败（401）'
    )
    expect(screen.queryByTestId('model-add-discover-empty')).not.toBeInTheDocument()

    fireEvent.change(screen.getByTestId('model-add-model'), { target: { value: '手填的模型' } })
    fireEvent.click(screen.getByTestId('model-add-submit'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenLastCalledWith({
        providers: [expect.objectContaining({ type: 'openai-compatible', model: '手填的模型' })]
      })
    )
    await waitFor(() => expect(bridge.setProviderKey).toHaveBeenCalledWith('custom-1', KEY))
  })

  it('007（补齐）：读到了但端点没给模型 → 说"手填"，与"读不到（给原因）"是两句不同的话', async () => {
    const bridge = await mount(defaultSettings())
    bridge.discoverProviderModels.mockResolvedValueOnce({ ok: true, models: [] })

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-custom-openai-compatible'))
    fireEvent.change(screen.getByTestId('model-add-base-url'), {
      target: { value: 'https://b.example.com/v1' }
    })
    fireEvent.change(screen.getByTestId('model-add-key'), { target: { value: KEY } })
    fireEvent.click(screen.getByTestId('model-add-discover'))

    expect(await screen.findByTestId('model-add-discover-empty')).toHaveTextContent('手填')
    expect(screen.queryByTestId('model-add-discover-error')).not.toBeInTheDocument()
  })

  it('007（补齐）：改地址 / 改密钥会把上一次的清单作废（免得挑到别的端点上的模型名）', async () => {
    const bridge = await mount(defaultSettings())
    bridge.discoverProviderModels.mockResolvedValueOnce({
      ok: true,
      models: [{ id: 'from-first-endpoint' }]
    })

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-custom-openai-compatible'))
    fireEvent.change(screen.getByTestId('model-add-base-url'), {
      target: { value: 'https://one.example.com/v1' }
    })
    fireEvent.change(screen.getByTestId('model-add-key'), { target: { value: KEY } })
    fireEvent.click(screen.getByTestId('model-add-discover'))
    expect(await screen.findByTestId('model-add-discovered')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('model-add-base-url'), {
      target: { value: 'https://two.example.com/v1' }
    })
    expect(screen.queryByTestId('model-add-discovered')).not.toBeInTheDocument()
    expect(screen.getByTestId('model-add-discover-hint')).toBeInTheDocument()
  })

  it('填了 Key：先落配置再写密钥，最后补一发能力探测（同展开行保存的口径）', async () => {
    const bridge = await mount(defaultSettings())

    addViaDialog('model-add-channel-preset-deepseek', { key: KEY })

    await waitFor(() => expect(bridge.setProviderKey).toHaveBeenCalledWith('deepseek', KEY))
    expect(bridge.update.mock.calls.at(-1)?.[0]).toMatchObject({
      providers: [{ id: 'deepseek' }]
    })
    expect(bridge.update.mock.invocationCallOrder.at(-1)).toBeLessThan(
      bridge.setProviderKey.mock.invocationCallOrder[0]
    )
    await waitFor(() => expect(bridge.probeModels).toHaveBeenCalledWith('deepseek'))
    // 明文不落在页面上（弹窗已关，输入框也不留）
    expect(document.body.textContent ?? '').not.toContain(KEY)
  })

  it('落盘失败：留在弹窗里报原因，不关窗', async () => {
    const bridge = await mount(defaultSettings())
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))

    addViaDialog('model-add-channel-preset-deepseek')

    expect(await screen.findByTestId('model-add-error')).toHaveTextContent('磁盘满了')
    expect(screen.getByTestId('model-add-channel')).toBeInTheDocument()
  })

  it('写密钥失败：同样留在弹窗里（配置那一趟已经落了，错误如实报）', async () => {
    const bridge = await mount(defaultSettings())
    bridge.setProviderKey.mockRejectedValueOnce(new Error('系统安全存储不可用'))

    addViaDialog('model-add-channel-preset-deepseek', { key: KEY })

    expect(await screen.findByTestId('model-add-error')).toHaveTextContent('系统安全存储不可用')
    expect(screen.getByTestId('model-add-channel')).toBeInTheDocument()
  })
})

describe('模型组 · 密钥只写不回显', () => {
  it('填 key 保存：只把 [id, key] 交给主进程；状态转"已配置"，输入框清空，整页不含明文', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')
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
    // 012：保存按钮点完要有结果反馈
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-notice')).toHaveTextContent('已保存')
    )
  })

  it('配置与 key 一起保存：先落配置再写 key（顺序不能反）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

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
    expand('deepseek')

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
    expand('deepseek')

    expect(await screen.findByTestId('provider-deepseek-reentry')).toHaveTextContent('重新录入')
    expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('需要重新录入')
    // 官方云主机（deepseek 预置）没有密钥仍是缺项（原口径）；别的地址不会报这一条
    expect(screen.getByTestId('provider-deepseek-problems')).toHaveTextContent(
      '配置不完整：缺 API 密钥'
    )
  })

  it('保存失败：行内报错（不假装已保存）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    bridge.setProviderKey.mockRejectedValueOnce(new Error('系统安全存储不可用'))
    expand('deepseek')

    fireEvent.change(screen.getByTestId('provider-deepseek-key'), { target: { value: KEY } })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    expect(await screen.findByTestId('provider-deepseek-error')).toHaveTextContent(
      '系统安全存储不可用'
    )
    expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('未配置')
  })
})

describe('模型组 · 半截配置的行内提示', () => {
  it('缺模型名 / 缺 Base URL 点名（openai 兼容渠道不把"没有密钥"算缺项）', async () => {
    await mount(
      withProviders({ id: 'custom-1', type: 'openai-compatible', model: '', isDefault: true })
    )
    expand('custom-1')

    // 等密钥状态读完，缺项才齐（读到之前不报任何缺项）
    await waitFor(() =>
      expect(screen.getByTestId('provider-custom-1-key-status')).toHaveTextContent('未配置')
    )
    expect(screen.getByTestId('provider-custom-1-problems')).toHaveTextContent(
      '配置不完整：缺模型名；配置不完整：缺 Base URL'
    )
    // 打包态实报的修正：没有密钥不再被当成"配置不完整"（本机服务那类本来就不要密钥）
    expect(screen.getByTestId('provider-custom-1-problems')).not.toHaveTextContent('缺 API 密钥')
  })

  it('anthropic 缺密钥仍然点名（官方 SDK 的 x-api-key 必填）', async () => {
    await mount(
      withProviders({
        id: 'anthropic',
        type: 'anthropic',
        model: 'claude-sonnet-4-5',
        isDefault: true
      })
    )
    expand('anthropic')

    await waitFor(() =>
      expect(screen.getByTestId('provider-anthropic-problems')).toHaveTextContent(
        '配置不完整：缺 API 密钥'
      )
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
    expand('anthropic')

    // 等"已配置"先上屏（密钥状态读完），这时才谈得上"配齐了"
    await waitFor(() =>
      expect(screen.getByTestId('provider-anthropic-key-status')).toHaveTextContent('已配置')
    )

    expect(screen.queryByTestId('provider-anthropic-problems')).not.toBeInTheDocument()
    expect(screen.queryByTestId('provider-anthropic-base-url')).not.toBeInTheDocument()
  })
})

describe('模型组 · 设为默认与删除', () => {
  it('设为默认：默认标记只挪到点的那条上', async () => {
    const bridge = await mount(withProviders(DEEPSEEK, OPENAI))
    expand('openai')

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

  it('删除：走 settings:remove-provider，行消失', async () => {
    const bridge = await mount(withProviders(DEEPSEEK, OPENAI))
    expand('openai')

    fireEvent.click(screen.getByTestId('provider-openai-remove'))

    await waitFor(() => expect(bridge.removeProvider).toHaveBeenCalledWith('openai'))
    await waitFor(() => expect(screen.queryByTestId('provider-openai')).not.toBeInTheDocument())
    expect(screen.getByTestId('provider-deepseek')).toBeInTheDocument()
  })
})

describe('模型组 · 测试连接', () => {
  it('成功：显示延迟 + 三步结论 + 验证范围声明（005）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    await waitFor(() => expect(bridge.testProvider).toHaveBeenCalledWith('deepseek'))
    expect(await screen.findByTestId('provider-deepseek-test-result')).toHaveTextContent(
      '连接正常，延迟 128 ms'
    )
    // 分项：每一步一行，带状态与那句 detail
    expect(screen.getByTestId('provider-deepseek-test-step-connectivity')).toHaveTextContent(
      '连通：通过'
    )
    expect(screen.getByTestId('provider-deepseek-test-step-streaming')).toHaveTextContent(
      '流式对话：通过'
    )
    expect(screen.getByTestId('provider-deepseek-test-step-tools')).toHaveTextContent(
      '流式工具：通过'
    )
    // 005：验证范围必须写在结果旁边（不能只给一个"成功"）
    expect(screen.getByTestId('provider-deepseek-test-scope')).toHaveTextContent('验证范围')
    expect(screen.getByTestId('provider-deepseek-test-scope')).toHaveTextContent('第一轮对话')
    // 三步全过时不该有那句额外的 message（大字自己就说清了）
    expect(screen.queryByTestId('provider-deepseek-test-message')).not.toBeInTheDocument()
    expect(screen.getByTestId('provider-deepseek-test-step-tools')).toHaveTextContent(
      '流式工具：通过'
    )
  })

  it('005：工具那一步没过时，大字里就说出来 + 那句 message 原样显示（不许读成整体通过）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')
    bridge.testProvider.mockResolvedValueOnce(
      passingConnectionTest({
        steps: [
          {
            id: 'connectivity',
            status: 'passed',
            latencyMs: 20,
            detail: '端点返回了一条可解析的响应'
          },
          { id: 'streaming', status: 'passed', latencyMs: 30, detail: '流式拿到 4 个字符的正文' },
          {
            id: 'tools',
            status: 'failed',
            latencyMs: 12,
            detail: '模型调了 kyclaw_probe，但这次调用不合法（探针参数不合法）'
          }
        ],
        message:
          '工具那一步没通过（模型调了 kyclaw_probe，但这次调用不合法（探针参数不合法））——本应用每一轮对话都带工具表，这个模型的真实可用性以第一轮对话为准。'
      })
    )

    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    const box = await screen.findByTestId('provider-deepseek-test-result')
    expect(box).toHaveTextContent('连接与流式正常，但工具调用没有通过')
    expect(box).not.toHaveTextContent('连接正常，延迟')
    expect(screen.getByTestId('provider-deepseek-test-message')).toHaveTextContent(
      '工具那一步没通过'
    )
    expect(screen.getByTestId('provider-deepseek-test-step-tools')).toHaveTextContent(
      '流式工具：失败'
    )
  })

  it('round 22：成功之后顺带触发一次模型元数据探测（真实上下文/挡位；后台、静默）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

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
    expand('deepseek')
    bridge.testProvider.mockResolvedValueOnce(
      passingConnectionTest({
        ok: false,
        message: '认证失败（401）',
        steps: [
          { id: 'connectivity', status: 'failed', detail: '认证失败（401）' },
          { id: 'streaming', status: 'skipped', detail: '上一步没有通过，这一步没有跑' },
          { id: 'tools', status: 'skipped', detail: '上一步没有通过，这一步没有跑' }
        ]
      })
    )

    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    await screen.findByTestId('provider-deepseek-test-result')
    expect(bridge.probeModels).not.toHaveBeenCalled()
  })

  it('005：只有"未验证"时不当成功——大字说"没能确认可用"，也不触发能力探测', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')
    bridge.testProvider.mockResolvedValueOnce(
      passingConnectionTest({
        ok: false,
        message: '流里只有思考内容（200 个字符）、没有正文——不能据此认定能正常对话',
        steps: [
          {
            id: 'connectivity',
            status: 'passed',
            latencyMs: 30,
            detail: '端点返回了一条可解析的响应'
          },
          {
            id: 'streaming',
            status: 'unverified',
            latencyMs: 900,
            detail: '流里只有思考内容（200 个字符）、没有正文——不能据此认定能正常对话'
          },
          { id: 'tools', status: 'skipped', detail: '上一步没有通过，这一步没有跑' }
        ]
      })
    )

    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    const headline = await screen.findByTestId('provider-deepseek-test-result')
    expect(headline).toHaveTextContent('没能确认可用')
    expect(headline).not.toHaveTextContent('连接正常')
    expect(screen.getByTestId('provider-deepseek-test-step-streaming')).toHaveTextContent(
      '流式对话：未验证'
    )
    expect(bridge.probeModels).not.toHaveBeenCalled()
  })

  it('失败：原样显示主进程翻译的错误文案', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')
    bridge.testProvider.mockResolvedValueOnce(
      passingConnectionTest({
        ok: false,
        message: '认证失败（401）：API Key 无效或没有该模型的权限',
        steps: [
          {
            id: 'connectivity',
            status: 'failed',
            latencyMs: 12,
            detail: '认证失败（401）：API Key 无效或没有该模型的权限'
          },
          { id: 'streaming', status: 'skipped', detail: '上一步没有通过，这一步没有跑' },
          { id: 'tools', status: 'skipped', detail: '上一步没有通过，这一步没有跑' }
        ]
      })
    )

    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    expect(await screen.findByTestId('provider-deepseek-test-result')).toHaveTextContent(
      '认证失败（401）'
    )
    expect(screen.getByTestId('provider-deepseek-test-step-connectivity')).toHaveTextContent(
      '连通：失败'
    )
  })

  it('有未保存的改动时：先保存再测（测的就是聊天接下来要走的那条路）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

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
    expand('deepseek')
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))

    fireEvent.change(screen.getByTestId('provider-deepseek-model'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    expect(await screen.findByTestId('provider-deepseek-error')).toHaveTextContent('磁盘满了')
    expect(bridge.testProvider).not.toHaveBeenCalled()
  })
})

describe('模块 2 / round 48 · 能力探测（手动「支持看图」开关已删）', () => {
  it('页面上不再有开关：能力只由探测标注（composer 的收/拒、菜单标记同源）', async () => {
    await mount(withProviders(DEEPSEEK))

    expect(screen.queryByTestId('model-vision')).not.toBeInTheDocument()
    expect(screen.queryByTestId('model-vision-switch')).not.toBeInTheDocument()
  })

  it('写完密钥补一发探测：注册模型（填 key → 保存）就自动标注能力', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    fireEvent.change(screen.getByTestId('provider-deepseek-key'), { target: { value: KEY } })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    await waitFor(() => expect(bridge.setProviderKey).toHaveBeenCalledWith('deepseek', KEY))
    // settings:update 那一趟当时还没有 key（渲染端先存配置再写 key），所以这里必须再补一发
    await waitFor(() => expect(bridge.probeModels).toHaveBeenCalledWith('deepseek'))
  })

  it('没填新密钥时就那一趟（settings:update 自己会探），不重复发', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    fireEvent.change(screen.getByTestId('provider-deepseek-model'), {
      target: { value: 'deepseek-v4-pro' }
    })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        providers: [{ ...DEEPSEEK, model: 'deepseek-v4-pro' }]
      })
    )
    expect(bridge.setProviderKey).not.toHaveBeenCalled()
    expect(bridge.probeModels).not.toHaveBeenCalled()
  })
})

describe('模型组 · 用户反馈 002/003/004/006（渠道名 / 手动上下文 / 显示名 / 来源标注）', () => {
  /** 官方端点实测到的形状：1M + 能看图 */
  const PROBED = { contextWindow: 1_048_576, vision: true, fetchedAt: '2026-10-11T00:00:00.000Z' }

  it('006：上下文旁标出**来源**——注册表/默认是"回退"，实测是"实测"', async () => {
    await mount(withProviders(DEEPSEEK))
    expect(screen.getByTestId('provider-deepseek-context')).toHaveTextContent('128K')
    expect(screen.getByTestId('provider-deepseek-context-source')).toHaveTextContent('回退')

    cleanup()
    await mount({
      ...withProviders(DEEPSEEK),
      probedModels: { 'deepseek:deepseek-flash': PROBED }
    })
    expect(screen.getByTestId('provider-deepseek-context')).toHaveTextContent('1M')
    expect(screen.getByTestId('provider-deepseek-context-source')).toHaveTextContent('实测')
  })

  it('002/004：折叠行显示渠道名 + 模型展示名；展示名不进模型名那一栏', async () => {
    await mount({
      ...withProviders({ ...DEEPSEEK, name: '公司网关' }),
      modelOverrides: { 'deepseek:deepseek-flash': { displayName: '主力模型' } }
    })

    const line = row('deepseek')
    expect(line).toHaveTextContent('公司网关')
    expect(line).toHaveTextContent('主力模型')

    expand('deepseek')
    // 004：展示名归展示名，**模型名（API 标识）原样**——发送/探测认的仍是后者
    expect(input('provider-deepseek-display-name').value).toBe('主力模型')
    expect(input('provider-deepseek-model').value).toBe('deepseek-flash')
    expect(screen.getByTestId('provider-deepseek-display-name').parentElement).toHaveTextContent(
      '不进任何请求、密钥或探测'
    )
  })

  it('003/004：手填上下文长度与展示名 → 落 settings.modelOverrides（独立一张表）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    fireEvent.change(screen.getByTestId('provider-deepseek-context-window'), {
      target: { value: '900000' }
    })
    fireEvent.change(screen.getByTestId('provider-deepseek-display-name'), {
      target: { value: '主力模型' }
    })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenLastCalledWith({
        modelOverrides: {
          'deepseek:deepseek-flash': { contextWindow: 900_000, displayName: '主力模型' }
        }
      })
    )
    // 手动值立刻生效（取值链 override → probed → 注册表 → 默认），来源标成"手动"
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-context')).toHaveTextContent('900K')
    )
    expect(screen.getByTestId('provider-deepseek-context-source')).toHaveTextContent('手动')
    // 只写两张表里该写的那一张：探测表不动
    expect(bridge.update.mock.calls.at(-1)?.[0]).not.toHaveProperty('probedModels')
  })

  it('003：手动值可以「恢复探测值」——清掉手动值，落盘回到实测', async () => {
    const bridge = await mount({
      ...withProviders(DEEPSEEK),
      probedModels: { 'deepseek:deepseek-flash': PROBED },
      modelOverrides: { 'deepseek:deepseek-flash': { contextWindow: 900_000 } }
    })
    expand('deepseek')

    expect(input('provider-deepseek-context-window').value).toBe('900000')
    expect(screen.getByTestId('provider-deepseek-context-window-source')).toHaveTextContent('手动')

    fireEvent.click(screen.getByTestId('provider-deepseek-reset-context'))
    expect(input('provider-deepseek-context-window').value).toBe('')
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    await waitFor(() => expect(bridge.update).toHaveBeenLastCalledWith({ modelOverrides: {} }))
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-context')).toHaveTextContent('1M')
    )
    expect(screen.getByTestId('provider-deepseek-context-source')).toHaveTextContent('实测')
  })

  it('003：上下文长度填了非正整数 → 保存拦下来报人话，一个字节都不落盘', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    fireEvent.change(screen.getByTestId('provider-deepseek-context-window'), {
      target: { value: '十二万' }
    })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    expect(await screen.findByTestId('provider-deepseek-error')).toHaveTextContent(
      '上下文长度要填正整数（tokens）'
    )
    expect(bridge.update).not.toHaveBeenCalled()
    expect(bridge.setProviderKey).not.toHaveBeenCalled()
  })

  it('003：把实测值原样填一遍不写成手动值（不该顺手把实测冻住）', async () => {
    const bridge = await mount({
      ...withProviders(DEEPSEEK),
      probedModels: { 'deepseek:deepseek-flash': PROBED }
    })
    expand('deepseek')

    fireEvent.change(screen.getByTestId('provider-deepseek-context-window'), {
      target: { value: '1048576' }
    })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ providers: [DEEPSEEK] }))
    // 覆盖表没变 → 连写都不写（保存只落真正改过的东西）
    expect(bridge.update.mock.calls.some((call) => 'modelOverrides' in (call[0] as object))).toBe(
      false
    )
    expect(screen.getByTestId('provider-deepseek-context-source')).toHaveTextContent('实测')
  })

  it('002：展开行改名称 → 写进 provider.name，折叠行跟着换', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')
    expect(input('provider-deepseek-name').value).toBe('')

    fireEvent.change(screen.getByTestId('provider-deepseek-name'), {
      target: { value: '公司网关' }
    })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        providers: [{ ...DEEPSEEK, name: '公司网关' }]
      })
    )
    await waitFor(() => expect(row('deepseek')).toHaveTextContent('公司网关'))
  })

  it('001：这条端点注册了多个模型时，展开区把清单列出来（模型名那一栏仍是 API 标识）', async () => {
    await mount(
      withProviders({
        ...DEEPSEEK,
        model: 'deepseek-v4-pro',
        models: ['deepseek-flash', 'deepseek-v4-pro']
      })
    )
    expect(row('deepseek')).toHaveTextContent('deepseek-v4-pro')

    expand('deepseek')
    expect(screen.getByTestId('provider-deepseek-registered-models')).toHaveTextContent(
      'deepseek-flash、deepseek-v4-pro'
    )
    expect(input('provider-deepseek-model').value).toBe('deepseek-v4-pro')
  })

  it('001 闭环 · 选择：清单里点另一个模型 → 填进「模型」栏，保存即切过去（清单不动）', async () => {
    const bridge = await mount(
      withProviders({
        ...DEEPSEEK,
        model: 'deepseek-v4-pro',
        models: ['deepseek-flash', 'deepseek-v4-pro']
      })
    )
    expand('deepseek')

    fireEvent.keyDown(screen.getByTestId('provider-deepseek-registered-menu'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('provider-deepseek-use-model-deepseek-flash'))
    expect(input('provider-deepseek-model').value).toBe('deepseek-flash')

    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        providers: [
          {
            ...DEEPSEEK,
            model: 'deepseek-flash',
            models: ['deepseek-flash', 'deepseek-v4-pro']
          }
        ]
      })
    )
  })

  it('001 闭环 · 移除：把多余的（比如改错的名字）从清单摘掉，保存落盘；当前选中的那个不给摘', async () => {
    const bridge = await mount(
      withProviders({
        ...DEEPSEEK,
        model: 'deepseek-v4-pro',
        models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-typo']
      })
    )
    expand('deepseek')

    fireEvent.keyDown(screen.getByTestId('provider-deepseek-registered-menu'), { key: 'ArrowDown' })
    // 当前选中的那个没有"移除"项（registeredModelsOf 本来就会把它补回来，摘了也是白摘）
    expect(
      screen.queryByTestId('provider-deepseek-drop-model-deepseek-v4-pro')
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('provider-deepseek-drop-model-deepseek-typo'))

    expect(screen.getByTestId('provider-deepseek-registered-models')).toHaveTextContent(
      'deepseek-flash、deepseek-v4-pro'
    )

    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        providers: [
          {
            ...DEEPSEEK,
            model: 'deepseek-v4-pro',
            models: ['deepseek-flash', 'deepseek-v4-pro']
          }
        ]
      })
    )
  })

  it('001：清单没动过时保存不写 models 字段（老配置保持原样，不被塞一个多余键）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    fireEvent.change(screen.getByTestId('provider-deepseek-name'), {
      target: { value: '公司网关' }
    })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        providers: [{ ...DEEPSEEK, name: '公司网关' }]
      })
    )
    const patch = bridge.update.mock.calls.at(-1)?.[0] as { providers: ProviderConfig[] }
    expect('models' in patch.providers[0]).toBe(false)
  })
})

describe('模型组 · 用户反馈 012（保存反馈 + 草稿竞态）', () => {
  it('保存后有"已保存"；再动任意一处草稿都会立刻收掉（含 001 的「从清单移除」）', async () => {
    await mount(
      withProviders({
        ...DEEPSEEK,
        model: 'deepseek-v4-pro',
        models: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-typo']
      })
    )
    expand('deepseek')

    /** 存一次并等"已保存"出现（后面每一轮都靠它把状态拉回"刚存过"） */
    const saveAndSeeNotice = async (): Promise<void> => {
      fireEvent.click(screen.getByTestId('provider-deepseek-save'))
      expect(await screen.findByTestId('provider-deepseek-notice')).toHaveTextContent('已保存')
    }

    await saveAndSeeNotice()

    // 逐项验：名称 / 模型 / 显示名 / 上下文 / Base URL / 密钥——改了就不该还挂着"已保存"
    const edits: ReadonlyArray<[string, string]> = [
      ['provider-deepseek-name', '公司网关'],
      ['provider-deepseek-model', 'deepseek-flash'],
      ['provider-deepseek-display-name', '主力模型'],
      ['provider-deepseek-context-window', '900000'],
      ['provider-deepseek-base-url', 'https://api.deepseek.com/v2'],
      ['provider-deepseek-key', 'sk-typed-later-012-SECRET']
    ]
    for (const [testId, value] of edits) {
      fireEvent.change(screen.getByTestId(testId), { target: { value } })
      expect(screen.queryByTestId('provider-deepseek-notice'), testId).not.toBeInTheDocument()
      await saveAndSeeNotice()
    }

    // 001 的「从清单移除」也是改草稿：同样收掉反馈
    fireEvent.keyDown(screen.getByTestId('provider-deepseek-registered-menu'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('provider-deepseek-drop-model-deepseek-typo'))
    expect(screen.queryByTestId('provider-deepseek-notice')).not.toBeInTheDocument()
  })

  it('保存失败时不会留下"已保存"（只报错）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))
    expand('deepseek')

    fireEvent.change(screen.getByTestId('provider-deepseek-name'), {
      target: { value: '公司网关' }
    })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    expect(await screen.findByTestId('provider-deepseek-error')).toHaveTextContent('磁盘满了')
    expect(screen.queryByTestId('provider-deepseek-notice')).not.toBeInTheDocument()
  })

  it('保存期间又改草稿：新草稿一个字都不丢，反馈也不谎报"已保存"', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    // 把这一趟保存卡在路上，模拟"落盘慢/主进程卡住时用户接着改"
    let release!: () => void
    const gated = new Promise<void>((resolve) => {
      release = resolve
    })
    const realUpdate = bridge.update.getMockImplementation()
    bridge.update.mockImplementationOnce(async (patch) => {
      await gated
      return realUpdate!(patch)
    })

    fireEvent.change(screen.getByTestId('provider-deepseek-name'), {
      target: { value: '公司网关' }
    })
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))

    // 保存还没回来，用户接着把模型改了
    fireEvent.change(screen.getByTestId('provider-deepseek-model'), {
      target: { value: 'deepseek-v4-pro' }
    })
    expect(input('provider-deepseek-model').value).toBe('deepseek-v4-pro')

    release()

    // 反馈如实：这一趟存的是旧内容，且**不许**用落盘值把用户刚敲的模型盖回去
    expect(await screen.findByTestId('provider-deepseek-notice')).toHaveTextContent('改动还没保存')
    expect(input('provider-deepseek-model').value).toBe('deepseek-v4-pro')
    // 这一趟只落了点击那一刻的草稿（名字改了、模型还是旧的）
    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        providers: [{ ...DEEPSEEK, name: '公司网关' }]
      })
    )

    // 再点一次保存：期间改的内容**真的**落盘（没有丢）
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))
    await waitFor(() =>
      expect(bridge.update).toHaveBeenLastCalledWith({
        providers: [{ ...DEEPSEEK, name: '公司网关', model: 'deepseek-v4-pro' }]
      })
    )
    expect(await screen.findByTestId('provider-deepseek-notice')).toHaveTextContent('已保存')
  })

  it('保存期间又改草稿：这一趟不接着测连接（测的会是旧配置，结论会误导）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    let release!: () => void
    const gated = new Promise<void>((resolve) => {
      release = resolve
    })
    const realUpdate = bridge.update.getMockImplementation()
    bridge.update.mockImplementationOnce(async (patch) => {
      await gated
      return realUpdate!(patch)
    })

    fireEvent.change(screen.getByTestId('provider-deepseek-name'), {
      target: { value: '公司网关' }
    })
    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    fireEvent.change(screen.getByTestId('provider-deepseek-model'), {
      target: { value: 'deepseek-v4-pro' }
    })
    release()

    await screen.findByTestId('provider-deepseek-notice')
    expect(bridge.testProvider).not.toHaveBeenCalled()
    expect(screen.queryByTestId('provider-deepseek-test-result')).not.toBeInTheDocument()
  })
})
