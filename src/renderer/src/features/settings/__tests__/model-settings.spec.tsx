import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
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

  it('已添加的内置渠道在下拉里置灰（同一条只能加一次）', async () => {
    await mount(withProviders(DEEPSEEK))

    fireEvent.click(screen.getByTestId('model-add'))
    fireEvent.keyDown(screen.getByTestId('model-add-channel'), { key: 'ArrowDown' })

    expect(screen.getByTestId('model-add-channel-preset-deepseek')).toHaveAttribute('data-disabled')
    expect(screen.getByTestId('model-add-channel-preset-openai')).not.toHaveAttribute(
      'data-disabled'
    )
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
  it('缺模型名 / 缺 Base URL / 缺 key 全部点名（展开区里）', async () => {
    await mount(
      withProviders({ id: 'custom-1', type: 'openai-compatible', model: '', isDefault: true })
    )
    expand('custom-1')

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
  it('成功：显示延迟（主进程发的那条最小请求）', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')

    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    await waitFor(() => expect(bridge.testProvider).toHaveBeenCalledWith('deepseek'))
    expect(await screen.findByTestId('provider-deepseek-test-result')).toHaveTextContent(
      '连接正常，延迟 128 ms'
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
    bridge.testProvider.mockResolvedValueOnce({ ok: false, message: '认证失败（401）' })

    fireEvent.click(screen.getByTestId('provider-deepseek-test'))

    await screen.findByTestId('provider-deepseek-test-result')
    expect(bridge.probeModels).not.toHaveBeenCalled()
  })

  it('失败：原样显示主进程翻译的错误文案', async () => {
    const bridge = await mount(withProviders(DEEPSEEK))
    expand('deepseek')
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
