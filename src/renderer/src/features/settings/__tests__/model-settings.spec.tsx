import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearKyclawBridge,
  installKyclawBridge,
  passingConnectionTest
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import type { ProviderKeyRevealResult } from '@shared/ipc'
import { defaultSettings, type AppSettings } from '@shared/settings'
import type { ProviderConfig } from '@shared/providers'
import { ModelSettings } from '../ModelSettings'

/**
 * 设置页「模型」组（T8，RTL；round 48 改成"折叠列表 + 新增弹窗"）：
 *   - 新增走右上角「新增」弹窗：渠道下拉（内置 / 自定义）→ 字段 → 添加即落盘；已添加的内置渠道置灰；
 *   - 新建成功 = 弹窗关闭 + 新行**自动展开**；失败留弹窗里报原因（不关窗）；
 *   - 已配置：默认折叠只显示名字 / 模型名 / 上下文 / 能力图标 / 默认徽章；点行展开编辑；
 *   - key 写入后不回显：保存后输入框清空、状态"已配置"、整页文本不含明文；
 *   - 半截配置在展开区行内报"配置不完整：缺 X"；解不开的密钥引导重录（Review Focus #5）；
 *   - 测试连接：先存后测，分项显示三步结论 + 验证范围（005）；
 *   - 保存反馈（012）：存完给"已保存"，但只要再动一下草稿就立刻收掉；保存期间又改草稿时
 *     新改动一个字都不丢、反馈也不谎报（见文件末尾那一组）。
 *   - API Key 显隐：默认掩码；本次有新输入时眼睛只临时揭示这次输入；本次无输入但已存密钥时，
 *     点眼睛才调 reveal 通道回显真实 key（用户复验口径）。收起折叠 / 切到另一条 provider /
 *     保存成功 / 取消关闭 / 新增弹窗关闭都立即复位并清掉本地明文（真 input.type / value 断言）。
 *     已存密钥（本次未输入）在掩码态显示固定圆点占位；眼睛按钮不抢输入框焦点
 *     （点完眼睛可直接键入，字符不会落在按钮上）。
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
    expect(input('provider-openai-key')).toHaveAttribute('type', 'password')
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

  it('009：输入框里的说明/示例占位去掉；字段靠标签仍可识别，渠道未选态保留', async () => {
    await mount(defaultSettings())

    fireEvent.click(screen.getByTestId('model-add'))
    // 渠道选择器的"未选"状态是必要的，保留
    expect(screen.getByTestId('model-add-channel')).toHaveTextContent('选一个渠道')

    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-preset-deepseek'))

    // 四个文本框（模型 ID / 地址 / 渠道名称 / key）都不再带 placeholder 说明或示例
    for (const testId of [
      'model-add-model',
      'model-add-base-url',
      'model-add-name',
      'model-add-key'
    ]) {
      expect(input(testId), testId).not.toHaveAttribute('placeholder')
    }
    // 字段仍可识别：注册与行内编辑同一套命名（模型 ID / Base URL / 渠道名称 / API Key）
    expect(input('model-add-model').closest('label')).toHaveTextContent('模型 ID')
    expect(input('model-add-base-url').closest('label')).toHaveTextContent('Base URL')
    expect(input('model-add-name').closest('label')).toHaveTextContent('渠道名称')
    expect(input('model-add-key')).toHaveAccessibleName('API Key')
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
    // 009：这一档的模型输入框同样不带占位说明（清单那行"没读到…手填"的说明是动态面，保留）
    expect(input('model-add-model')).not.toHaveAttribute('placeholder')

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
    // 真 input：走的是刚键入的草稿值，显示仍是默认掩码
    expect(input('model-add-key')).toHaveAttribute('type', 'password')
    expect(input('model-add-key').value).toBe(KEY)

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
    // 弹窗已关：密钥输入框不在 DOM 里；自动展开的新行是空值 + 默认掩码
    await waitFor(() => expect(screen.queryByTestId('model-add-key')).not.toBeInTheDocument())
    await waitFor(() => expect(input('provider-deepseek-key')).toBeInTheDocument())
    expect(input('provider-deepseek-key')).toHaveAttribute('type', 'password')
    expect(input('provider-deepseek-key').value).toBe('')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
  })

  it('API Key 默认掩码：眼睛按钮只临时揭示新输入，切回后提交照旧写密钥', async () => {
    const bridge = await mount(defaultSettings())

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-preset-deepseek'))

    const keyInput = input('model-add-key')
    expect(keyInput).toHaveAttribute('type', 'password')
    const toggle = screen.getByTestId('model-add-key-toggle')
    expect(toggle).toHaveAccessibleName('显示 API Key')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.change(keyInput, { target: { value: KEY } })
    // 填了值也不改默认掩码
    expect(keyInput).toHaveAttribute('type', 'password')

    // 眼睛只改这一次的显示，不改输入值
    fireEvent.click(toggle)
    expect(keyInput).toHaveAttribute('type', 'text')
    expect(keyInput.value).toBe(KEY)
    expect(toggle).toHaveAccessibleName('隐藏 API Key')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(toggle)
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(toggle).toHaveAccessibleName('显示 API Key')

    // 保存结果与全程掩码时一致：配置先落盘、密钥照旧交给主进程；关窗后原输入框移除，
    // 自动展开的新行是空值密码框（既不复读已存 key，也不留明文）
    fireEvent.click(screen.getByTestId('model-add-submit'))
    await waitFor(() => expect(bridge.setProviderKey).toHaveBeenCalledWith('deepseek', KEY))
    expect(bridge.update.mock.calls.at(-1)?.[0]).toMatchObject({
      providers: [{ id: 'deepseek' }]
    })
    await waitFor(() => expect(screen.queryByTestId('model-add-key')).not.toBeInTheDocument())
    await waitFor(() => expect(input('provider-deepseek-key')).toBeInTheDocument())
    expect(input('provider-deepseek-key')).toHaveAttribute('type', 'password')
    expect(input('provider-deepseek-key').value).toBe('')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
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

describe('模型组 · 用户反馈 009 返工（行内编辑去说明小字 + 精简布局）', () => {
  it('已有模型行内编辑：输入框不再带说明/示例占位，动态状态照留', async () => {
    await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    for (const testId of [
      'provider-deepseek-name',
      'provider-deepseek-model',
      'provider-deepseek-display-name',
      'provider-deepseek-context-window',
      'provider-deepseek-base-url',
      'provider-deepseek-key'
    ]) {
      expect(input(testId), testId).not.toHaveAttribute('placeholder')
    }

    // 动态面不是"输入说明小字"：密钥状态、上下文来源与实测/回退值都还在
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('未配置')
    )
    expect(screen.getByTestId('provider-deepseek-context-window-source')).toHaveTextContent('回退')
    expect(input('provider-deepseek-context-window').closest('label')).toHaveTextContent('128K')
  })

  it('命名统一：渠道名称 / 模型名称 / 模型 ID；模型名称与模型 ID 同一行', async () => {
    await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    expect(input('provider-deepseek-name').closest('label')).toHaveTextContent('渠道名称')
    expect(input('provider-deepseek-display-name').closest('label')).toHaveTextContent('模型名称')
    expect(input('provider-deepseek-model').closest('label')).toHaveTextContent('模型 ID')
    expect(input('provider-deepseek-context-window').closest('label')).toHaveTextContent(
      '上下文长度（tokens）'
    )
    expect(input('provider-deepseek-base-url').closest('label')).toHaveTextContent('Base URL')
    expect(input('provider-deepseek-key')).toHaveAccessibleName('API Key')

    // "同一行"：模型名称与模型 ID 是同一身份栅格（#identity）下的兄弟节点
    const identity = screen.getByTestId('provider-deepseek-identity')
    const displayNameLabel = input('provider-deepseek-display-name').closest('label')
    const modelLabel = input('provider-deepseek-model').closest('label')
    expect(identity).toContainElement(input('provider-deepseek-name'))
    expect(identity).toContainElement(displayNameLabel)
    expect(identity).toContainElement(modelLabel)
    expect(displayNameLabel?.parentElement).toBe(modelLabel?.parentElement)
  })
})

describe('模型组 · 密钥写方向与显式回显', () => {
  it('填 key 保存：只把 [id, key] 交给主进程；状态转"已配置"，输入框清空回掩码、已存 key 默认不回显', async () => {
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
    expect(input('provider-deepseek-key')).toHaveAttribute('type', 'password')
    expect(input('provider-deepseek-key').value).toBe('')
    // 保存后 = "已有密钥但本次未输入"：用固定圆点串占位，页面上仍然没有明文
    expect(input('provider-deepseek-key')).toHaveAttribute('placeholder', '••••••••••••')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
    // 012：保存按钮点完要有结果反馈
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-notice')).toHaveTextContent('已保存')
    )
  })

  it('已存密钥：点眼睛显式回显真实值，再点一次回掩码并清空本地明文', async () => {
    const bridge = installKyclawBridge(withProviders(DEEPSEEK))
    bridge.providerKeyStates.mockResolvedValue({
      deepseek: { hasKey: true, needsReentry: false }
    })
    bridge.revealProviderKey.mockResolvedValue({ ok: true, key: KEY })
    await useSettingsStore.getState().load()
    render(<ModelSettings />)
    expand('deepseek')

    // 已存密钥：状态读到"已配置"，但输入框仍是空的掩码框，页面上没有明文
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('已配置')
    )
    const keyInput = input('provider-deepseek-key')
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe('')
    // 已存密钥不读进任何 input（textContent 抓不到 input.value，用真实 display value 断言）
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
    // 已有密钥但本次未输入：掩码态用固定圆点串占位（纯视觉，不是真实密钥）
    expect(keyInput).toHaveAttribute('placeholder', '••••••••••••')

    const toggle = screen.getByTestId('provider-deepseek-key-toggle')
    expect(toggle).toHaveAccessibleName('显示 API Key')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    // 没点之前绝不回显
    expect(bridge.revealProviderKey).not.toHaveBeenCalled()

    // 用户显式点眼睛：只调一次 reveal，显示真实密钥（不是圆点/提示）
    fireEvent.click(toggle)
    await waitFor(() => expect(keyInput.value).toBe(KEY))
    expect(keyInput).toHaveAttribute('type', 'text')
    expect(keyInput).not.toHaveAttribute('placeholder')
    expect(bridge.revealProviderKey).toHaveBeenCalledTimes(1)
    expect(bridge.revealProviderKey).toHaveBeenCalledWith('deepseek')
    expect(toggle).toHaveAccessibleName('隐藏 API Key')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')

    // 再点一次：回掩码并清掉本地明文（state/DOM 都不留）
    fireEvent.click(toggle)
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe('')
    expect(keyInput).toHaveAttribute('placeholder', '••••••••••••')
    expect(toggle).toHaveAccessibleName('显示 API Key')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
    // 收起显示不会再打一次通道
    expect(bridge.revealProviderKey).toHaveBeenCalledTimes(1)

    // 保存语义不变：本次没有新输入时，不会把回显出来的 key 当成"新 key"再写一遍
    fireEvent.click(screen.getByTestId('provider-deepseek-save'))
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-notice')).toHaveTextContent('已保存')
    )
    expect(bridge.setProviderKey).not.toHaveBeenCalled()
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe('')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
  })

  it('显式回显：加载中给轻量状态，失败给人话且不显示任何密钥', async () => {
    const bridge = installKyclawBridge(withProviders(DEEPSEEK))
    bridge.providerKeyStates.mockResolvedValue({
      deepseek: { hasKey: true, needsReentry: false }
    })
    let finish!: (value: ProviderKeyRevealResult) => void
    bridge.revealProviderKey.mockImplementationOnce(
      () =>
        new Promise<ProviderKeyRevealResult>((resolve) => {
          finish = resolve
        })
    )
    await useSettingsStore.getState().load()
    render(<ModelSettings />)
    expand('deepseek')
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('已配置')
    )

    const keyInput = input('provider-deepseek-key')
    fireEvent.click(screen.getByTestId('provider-deepseek-key-toggle'))

    // 在途：明文态 + 一句轻量状态（此时还没有任何密钥被画出来）
    expect(await screen.findByTestId('provider-deepseek-key-reveal-status')).toHaveTextContent(
      '正在读取已存密钥'
    )
    expect(keyInput).toHaveAttribute('type', 'text')
    expect(keyInput.value).toBe('')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()

    finish({
      ok: false,
      reason: 'needs-reentry',
      message: '已存的密钥在这台机器上读不到，请重新录入'
    })
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-reveal-status')).toHaveTextContent(
        '重新录入'
      )
    )
    expect(keyInput).toHaveAttribute('type', 'text')
    expect(keyInput.value).toBe('')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
  })

  it('显式回显被 IPC 拒绝：错误人话化，不显示密钥', async () => {
    const bridge = installKyclawBridge(withProviders(DEEPSEEK))
    bridge.providerKeyStates.mockResolvedValue({
      deepseek: { hasKey: true, needsReentry: false }
    })
    bridge.revealProviderKey.mockRejectedValueOnce(
      new Error("Error invoking remote method 'settings:reveal-provider-key': Error: 读取失败")
    )
    await useSettingsStore.getState().load()
    render(<ModelSettings />)
    expand('deepseek')
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('已配置')
    )

    fireEvent.click(screen.getByTestId('provider-deepseek-key-toggle'))

    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-reveal-status')).toHaveTextContent(
        '读取失败'
      )
    )
    expect(screen.getByTestId('provider-deepseek-key-reveal-status')).not.toHaveTextContent(
      'Error invoking remote method'
    )
    expect(input('provider-deepseek-key').value).toBe('')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
  })

  it('未配置 / needsReentry：点眼睛不调用 reveal，保持掩码与现有状态文案', async () => {
    const bridge = installKyclawBridge(withProviders(DEEPSEEK))
    bridge.providerKeyStates.mockResolvedValue({
      deepseek: { hasKey: false, needsReentry: true }
    })
    await useSettingsStore.getState().load()
    render(<ModelSettings />)
    expand('deepseek')

    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('需要重新录入')
    )
    const keyInput = input('provider-deepseek-key')
    fireEvent.click(screen.getByTestId('provider-deepseek-key-toggle'))

    expect(bridge.revealProviderKey).not.toHaveBeenCalled()
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe('')
    expect(screen.queryByTestId('provider-deepseek-key-reveal-status')).not.toBeInTheDocument()
    expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('需要重新录入')
  })

  it('收起折叠：已回显的明文立即清除并回掩码；再展开不会自动重新拉取', async () => {
    const bridge = installKyclawBridge(withProviders(DEEPSEEK))
    bridge.providerKeyStates.mockResolvedValue({
      deepseek: { hasKey: true, needsReentry: false }
    })
    bridge.revealProviderKey.mockResolvedValue({ ok: true, key: KEY })
    await useSettingsStore.getState().load()
    render(<ModelSettings />)
    expand('deepseek')
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('已配置')
    )

    const keyInput = input('provider-deepseek-key')
    const toggle = screen.getByTestId('provider-deepseek-key-toggle')
    fireEvent.click(toggle)
    await waitFor(() => expect(keyInput.value).toBe(KEY))

    expand('deepseek') // 收起
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe('')
    expect(keyInput).toHaveAttribute('placeholder', '••••••••••••')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()

    expand('deepseek') // 再展开：仍是掩码；回显只在用户再次点击时发生
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe('')
    expect(bridge.revealProviderKey).toHaveBeenCalledTimes(1)
  })

  it('切到另一条 provider：前一行已回显的明文立即清除', async () => {
    const bridge = installKyclawBridge(withProviders(DEEPSEEK, OPENAI))
    bridge.providerKeyStates.mockResolvedValue({
      deepseek: { hasKey: true, needsReentry: false },
      openai: { hasKey: false, needsReentry: false }
    })
    bridge.revealProviderKey.mockResolvedValue({ ok: true, key: KEY })
    await useSettingsStore.getState().load()
    render(<ModelSettings />)
    expand('deepseek')
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('已配置')
    )

    const keyInput = input('provider-deepseek-key')
    fireEvent.click(screen.getByTestId('provider-deepseek-key-toggle'))
    await waitFor(() => expect(keyInput.value).toBe(KEY))

    expand('openai') // 切到另一条 provider（deepseek 仍展开）
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe('')
    expect(screen.getByTestId('provider-deepseek-key-toggle')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
    expect(input('provider-openai-key')).toHaveAttribute('type', 'password')
  })

  it('保存成功：已回显的明文立即清除并回掩码', async () => {
    const bridge = installKyclawBridge(withProviders(DEEPSEEK))
    bridge.providerKeyStates.mockResolvedValue({
      deepseek: { hasKey: true, needsReentry: false }
    })
    bridge.revealProviderKey.mockResolvedValue({ ok: true, key: KEY })
    await useSettingsStore.getState().load()
    render(<ModelSettings />)
    expand('deepseek')
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('已配置')
    )

    const keyInput = input('provider-deepseek-key')
    fireEvent.click(screen.getByTestId('provider-deepseek-key-toggle'))
    await waitFor(() => expect(keyInput.value).toBe(KEY))

    fireEvent.click(screen.getByTestId('provider-deepseek-save'))
    // 点保存就立即回掩码（不等落盘回来）
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-notice')).toHaveTextContent('已保存')
    )

    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe('')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
  })

  it('删除 provider（卸载行）：已回显的明文不再留在页面上', async () => {
    const bridge = installKyclawBridge(withProviders(DEEPSEEK))
    bridge.providerKeyStates.mockResolvedValue({
      deepseek: { hasKey: true, needsReentry: false }
    })
    bridge.revealProviderKey.mockResolvedValue({ ok: true, key: KEY })
    await useSettingsStore.getState().load()
    render(<ModelSettings />)
    expand('deepseek')
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('已配置')
    )

    fireEvent.click(screen.getByTestId('provider-deepseek-key-toggle'))
    await waitFor(() => expect(input('provider-deepseek-key').value).toBe(KEY))

    fireEvent.click(screen.getByTestId('provider-deepseek-remove'))
    await waitFor(() => expect(screen.queryByTestId('provider-deepseek')).not.toBeInTheDocument())
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
  })

  it('本次已有输入优先：眼睛只切显示，不调用 reveal', async () => {
    const bridge = installKyclawBridge(withProviders(DEEPSEEK))
    bridge.providerKeyStates.mockResolvedValue({
      deepseek: { hasKey: true, needsReentry: false }
    })
    await useSettingsStore.getState().load()
    render(<ModelSettings />)
    expand('deepseek')
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('已配置')
    )

    const keyInput = input('provider-deepseek-key')
    const typed = 'sk-new-draft-123'
    fireEvent.change(keyInput, { target: { value: typed } })
    fireEvent.click(screen.getByTestId('provider-deepseek-key-toggle'))

    expect(keyInput).toHaveAttribute('type', 'text')
    expect(keyInput.value).toBe(typed)
    expect(bridge.revealProviderKey).not.toHaveBeenCalled()

    // 再点回掩码：草稿还在（本次输入不属于"已存密钥"的临时回显）
    fireEvent.click(screen.getByTestId('provider-deepseek-key-toggle'))
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe(typed)
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
    // 状态没读到时不猜"已配置"：不给圆点占位
    expect(input('provider-deepseek-key')).not.toHaveAttribute('placeholder')
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
    // 读不到密钥 ≠ 已配置：不给圆点占位（不假装有一把可用的密钥）
    expect(input('provider-deepseek-key')).not.toHaveAttribute('placeholder')
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

/**
 * API Key 显隐的复位口径：本次有输入时眼睛只揭示**当前 draft**；本次无输入但已存密钥时，
 * 点眼睛才临时回显真实 key（用完即清）。收起折叠 / 切到另一条 provider / 保存成功 /
 * 取消关闭 / 新增弹窗关闭都要立即回到默认掩码，且不留明文。
 * 这里全部拿真实 `input.type` / `input.value` 断言（`textContent` 抓不到 input.value）。
 */
describe('模型组 · API Key 显隐复位（收起 / 切换 / 保存 / 关闭弹窗）', () => {
  it('眼睛按钮不抢焦点：点眼睛后直接键入仍落在输入框（真实键盘路径）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    const keyInput = input('provider-deepseek-key')
    const toggle = screen.getByTestId('provider-deepseek-key-toggle')
    // 模拟真实浏览器：点击按钮会先把焦点放到按钮上（jsdom 不会自动做，手工聚焦）
    toggle.focus()
    expect(toggle).toHaveFocus()

    // 真实点击顺序是 mousedown → mouseup → click；组件在 mousedown 里 preventDefault + 把焦点送回输入框
    fireEvent.mouseDown(toggle)
    fireEvent.click(toggle)
    expect(keyInput).toHaveFocus()
    // 未配置且本次没输入：没有可回显的内容，保持掩码（不进入空明文态），也不调用 reveal
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(bridge.revealProviderKey).not.toHaveBeenCalled()

    // 接着直接键入（不重新点输入框）：字符必须落进 draft/value，而不是落在按钮上
    fireEvent.change(keyInput, { target: { value: KEY } })
    expect(keyInput.value).toBe(KEY)
    expect(keyInput).toHaveAttribute('type', 'password')

    // 本次有输入后，眼睛才切换明文（显示的就是刚敲的值）
    fireEvent.click(toggle)
    expect(keyInput).toHaveAttribute('type', 'text')
    expect(keyInput.value).toBe(KEY)
  })

  it('收起编辑折叠：立即回到密码框；草稿保留，再展开仍是掩码', async () => {
    await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    const keyInput = input('provider-deepseek-key')
    const toggle = screen.getByTestId('provider-deepseek-key-toggle')
    expect(keyInput).toHaveAttribute('type', 'password')
    fireEvent.change(keyInput, { target: { value: KEY } })
    fireEvent.click(toggle)
    expect(keyInput).toHaveAttribute('type', 'text')
    expect(keyInput.value).toBe(KEY)
    // 无论鼠标（mousedown 已 preventDefault）还是键盘激活，焦点都留在输入框
    expect(keyInput).toHaveFocus()

    expand('deepseek') // 收起
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe(KEY)
    expect(toggle).toHaveAccessibleName('显示 API Key')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    expand('deepseek') // 再展开：仍是密码框（收起时已复位，不会把上次的明文展示带回来）
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe(KEY)
  })

  it('切到另一条 provider：前一行已揭示的 key 立即收回（两行都展开也一样）', async () => {
    await mount(withProviders(DEEPSEEK, OPENAI))
    expand('deepseek')

    const keyInput = input('provider-deepseek-key')
    fireEvent.change(keyInput, { target: { value: KEY } })
    fireEvent.click(screen.getByTestId('provider-deepseek-key-toggle'))
    expect(keyInput).toHaveAttribute('type', 'text')

    expand('openai') // 切到另一条 provider（deepseek 仍展开）
    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe(KEY)
    expect(screen.getByTestId('provider-deepseek-key-toggle')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(input('provider-openai-key')).toHaveAttribute('type', 'password')
  })

  it('保存成功：立即回到密码框并清空已提交的新 key（眼睛按钮也复位）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    const keyInput = input('provider-deepseek-key')
    const toggle = screen.getByTestId('provider-deepseek-key-toggle')
    fireEvent.change(keyInput, { target: { value: KEY } })
    fireEvent.click(toggle)
    expect(keyInput).toHaveAttribute('type', 'text')
    // 眼睛只改显示：不落盘、不写密钥
    expect(bridge.update).not.toHaveBeenCalled()
    expect(bridge.setProviderKey).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('provider-deepseek-save'))
    await waitFor(() => expect(bridge.setProviderKey).toHaveBeenCalledWith('deepseek', KEY))
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('已配置')
    )

    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe('')
    expect(toggle).toHaveAccessibleName('显示 API Key')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
  })

  it('保存成功（没写新 key）同样收回显隐，其他草稿一个字不丢', async () => {
    const bridge = installKyclawBridge(withProviders(DEEPSEEK))
    bridge.providerKeyStates.mockResolvedValue({
      deepseek: { hasKey: true, needsReentry: false }
    })
    bridge.revealProviderKey.mockResolvedValue({ ok: true, key: KEY })
    await useSettingsStore.getState().load()
    render(<ModelSettings />)
    expand('deepseek')
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-key-status')).toHaveTextContent('已配置')
    )

    const modelInput = input('provider-deepseek-model')
    const keyInput = input('provider-deepseek-key')
    fireEvent.change(modelInput, { target: { value: 'deepseek-v4-pro' } })
    fireEvent.click(screen.getByTestId('provider-deepseek-key-toggle'))
    await waitFor(() => expect(keyInput.value).toBe(KEY))

    fireEvent.click(screen.getByTestId('provider-deepseek-save'))
    await waitFor(() =>
      expect(bridge.update).toHaveBeenLastCalledWith({
        providers: [{ ...DEEPSEEK, model: 'deepseek-v4-pro' }]
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('provider-deepseek-notice')).toHaveTextContent('已保存')
    )

    expect(keyInput).toHaveAttribute('type', 'password')
    expect(keyInput.value).toBe('')
    expect(modelInput.value).toBe('deepseek-v4-pro')
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
  })

  it('新增弹窗：眼睛不抢焦点，点完眼睛直接键入仍进输入框', async () => {
    await mount(defaultSettings())

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-preset-deepseek'))

    const keyInput = input('model-add-key')
    const toggle = screen.getByTestId('model-add-key-toggle')
    toggle.focus()
    expect(toggle).toHaveFocus()

    fireEvent.mouseDown(toggle)
    fireEvent.click(toggle)
    expect(keyInput).toHaveFocus()
    // 弹窗里没有已存密钥、本次也没输入：保持掩码
    expect(keyInput).toHaveAttribute('type', 'password')

    fireEvent.change(keyInput, { target: { value: KEY } })
    expect(keyInput.value).toBe(KEY)
    expect(keyInput).toHaveAttribute('type', 'password')

    // 本次有输入后，眼睛才切换明文
    fireEvent.click(toggle)
    expect(keyInput).toHaveAttribute('type', 'text')
    expect(keyInput.value).toBe(KEY)
  })

  it('弹窗里换渠道：已揭示的 key 立即回到密码框，新渠道从空值开始', async () => {
    await mount(defaultSettings())

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-preset-deepseek'))
    fireEvent.change(input('model-add-key'), { target: { value: KEY } })
    fireEvent.click(screen.getByTestId('model-add-key-toggle'))
    expect(input('model-add-key')).toHaveAttribute('type', 'text')

    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-custom-openai-compatible'))

    const switched = input('model-add-key')
    expect(switched).toHaveAttribute('type', 'password')
    expect(switched.value).toBe('')
    expect(screen.getByTestId('model-add-key-toggle')).toHaveAttribute('aria-pressed', 'false')
  })

  it('取消关闭新增弹窗：再打开是密码框、空值、眼睛未按下', async () => {
    await mount(defaultSettings())

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-preset-deepseek'))
    const keyInput = input('model-add-key')
    fireEvent.change(keyInput, { target: { value: KEY } })
    fireEvent.click(screen.getByTestId('model-add-key-toggle'))
    expect(keyInput).toHaveAttribute('type', 'text')
    expect(keyInput.value).toBe(KEY)

    fireEvent.click(screen.getByTestId('model-add-cancel'))
    await waitFor(() => expect(screen.queryByTestId('model-add-key')).not.toBeInTheDocument())

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-preset-deepseek'))

    const reopened = input('model-add-key')
    expect(reopened).toHaveAttribute('type', 'password')
    expect(reopened.value).toBe('')
    expect(screen.getByTestId('model-add-key-toggle')).toHaveAttribute('aria-pressed', 'false')
  })

  it('新增成功关闭弹窗：原弹窗输入移除，新行展开是空值密码框', async () => {
    const bridge = await mount(defaultSettings())

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-add-channel-preset-deepseek'))
    fireEvent.change(input('model-add-key'), { target: { value: KEY } })
    fireEvent.click(screen.getByTestId('model-add-key-toggle'))
    expect(input('model-add-key')).toHaveAttribute('type', 'text')

    fireEvent.click(screen.getByTestId('model-add-submit'))

    await waitFor(() => expect(bridge.setProviderKey).toHaveBeenCalledWith('deepseek', KEY))
    await waitFor(() => expect(screen.queryByTestId('model-add-key')).not.toBeInTheDocument())
    await waitFor(() => expect(input('provider-deepseek-key')).toBeInTheDocument())
    expect(input('provider-deepseek-key')).toHaveAttribute('type', 'password')
    expect(input('provider-deepseek-key').value).toBe('')
    expect(screen.getByTestId('provider-deepseek-key-toggle')).toHaveAttribute(
      'aria-pressed',
      'false'
    )
    expect(screen.queryByDisplayValue(KEY)).not.toBeInTheDocument()
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
    // 004：模型名称归展示，**模型 ID（API 标识）原样**——发送/探测认的仍是后者
    expect(input('provider-deepseek-display-name').value).toBe('主力模型')
    expect(input('provider-deepseek-model').value).toBe('deepseek-flash')
    // 009 返工：输入说明小字已删，字段只靠标签识别；模型名称与模型 ID 同一组身份字段
    expect(screen.getByTestId('provider-deepseek-display-name').closest('label')).toHaveTextContent(
      '模型名称'
    )
    expect(
      screen.getByTestId('provider-deepseek-display-name').parentElement
    ).not.toHaveTextContent('不进任何请求')
    expect(screen.getByTestId('provider-deepseek-identity')).toContainElement(
      screen.getByTestId('provider-deepseek-display-name')
    )
    expect(screen.getByTestId('provider-deepseek-identity')).toContainElement(
      screen.getByTestId('provider-deepseek-model')
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
