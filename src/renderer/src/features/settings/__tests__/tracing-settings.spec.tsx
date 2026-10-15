import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import {
  DEFAULT_SETTINGS,
  defaultSettings,
  LANGFUSE_PRESET,
  type AppSettings
} from '@shared/settings'
import { langfuseStatusText } from '../status-text'
import { TracingSettings } from '../TracingSettings'

/**
 * 设置页「追踪」组（T17）：地址落 settings.json、公私钥走 telemetry 通道（只进不出）、
 * 状态行说的是"当前会话有没有真挂上"（配置改动要重启应用才生效）。
 *
 * 用户口径 010：配置项默认收在「配置」后面的展开区里 —— 下面要摸输入框的用例先点开它
 * （`renderTracing()` 默认帮点，专门验收起的用例传 false）。
 */
function renderTracing(expand = true): ReturnType<typeof installKyclawBridge> {
  const bridge = installKyclawBridge()
  render(<TracingSettings />)
  if (expand) fireEvent.click(screen.getByTestId('langfuse-config-toggle'))
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
    expect(langfuseStatusText(null, true)).toBe('正在读取…')
    expect(langfuseStatusText(state({ active: true }), true)).toBe('已开启')
    expect(langfuseStatusText(state(), true)).toBe('已配置，重启应用后开启')
    expect(
      langfuseStatusText(state({ publicKey: { hasKey: false, needsReentry: false } }), true)
    ).toBe('未开启（缺地址或密钥）')
    expect(langfuseStatusText(state({ endpoint: '  ' }), true)).toBe('未开启（缺地址或密钥）')
    expect(
      langfuseStatusText(
        state({ endpoint: '', publicKey: { hasKey: false, needsReentry: false }, active: true }),
        true
      )
    ).toBe('本次运行已开启，重启应用后停止')
  })

  it('round 86（010）：开关关着就说"已关闭"；本次运行还挂着导出时补一句"重启后停止"', () => {
    // 关掉那一刻：本次运行的 exporter 是启动时建的，还挂着（不编造"已经停了"）
    expect(langfuseStatusText(state({ active: true }), false)).toBe('已关闭，重启应用后停止')
    expect(langfuseStatusText(state(), false)).toBe('已关闭')
    // 开关优先于"配齐没配齐"：三项都还在也照样是已关闭
    expect(langfuseStatusText(state({ active: false }), false)).toBe('已关闭')
    // 状态还没读到时仍然是"正在读取"（开关一动不影响这一句）
    expect(langfuseStatusText(null, false)).toBe('正在读取…')
  })
})

describe('「追踪」组', () => {
  it('010：默认收起，只露状态与「配置」入口；点开才见地址/代理/密钥', async () => {
    renderTracing(false)

    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启'))
    expect(screen.getByTestId('langfuse-config-toggle')).toHaveTextContent('配置')
    expect(screen.getByTestId('langfuse-config-toggle')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('langfuse-endpoint')).not.toBeInTheDocument()
    expect(screen.queryByTestId('langfuse-proxy')).not.toBeInTheDocument()
    expect(screen.queryByTestId('langfuse-public-key')).not.toBeInTheDocument()
    expect(screen.queryByTestId('langfuse-secret-key')).not.toBeInTheDocument()
    expect(screen.queryByTestId('langfuse-save')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('langfuse-config-toggle'))

    expect(screen.getByTestId('langfuse-config-toggle')).toHaveTextContent('收起')
    expect(screen.getByTestId('langfuse-config-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('langfuse-endpoint')).toBeInTheDocument()
    expect(screen.getByTestId('langfuse-save')).toBeInTheDocument()

    // 再点一次收起：配置项回到隐藏（状态行始终在）
    fireEvent.click(screen.getByTestId('langfuse-config-toggle'))
    expect(screen.queryByTestId('langfuse-endpoint')).not.toBeInTheDocument()
    expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启')
  })

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
        langfuse: { enabled: true, endpoint: 'http://100.66.1.1:3000', proxyUrl: '127.0.0.1:7890' }
      })
    )
    expect(bridge.telemetry.setLangfuseKeys).toHaveBeenCalledWith('pk-test', 'sk-test')

    // 密钥草稿清空（不回显），状态行跟着落盘结果走
    await waitFor(() =>
      expect(screen.getByTestId('langfuse-status')).toHaveTextContent('已配置，重启应用后开启')
    )
    // 012：保存要有结果反馈
    await waitFor(() => expect(screen.getByTestId('langfuse-notice')).toHaveTextContent('已保存'))
    expect(screen.getByTestId('langfuse-public-key')).toHaveValue('')
    expect(screen.getByTestId('langfuse-secret-key')).toHaveValue('')
    expect(screen.getByTestId('langfuse-proxy')).toHaveValue('127.0.0.1:7890')
  })

  it('只改代理（地址不动）：写进去的是合并后的整节（地址原样带上）', async () => {
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        langfuse: { enabled: true, endpoint: 'http://100.66.1.1:3000', proxyUrl: '' }
      }
    })
    const bridge = installKyclawBridge()
    render(<TracingSettings />)
    fireEvent.click(screen.getByTestId('langfuse-config-toggle'))
    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启'))

    fireEvent.change(screen.getByTestId('langfuse-proxy'), {
      target: { value: 'http://127.0.0.1:7890' }
    })
    fireEvent.click(screen.getByTestId('langfuse-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        langfuse: {
          enabled: true,
          endpoint: 'http://100.66.1.1:3000',
          proxyUrl: 'http://127.0.0.1:7890'
        }
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
        langfuse: { enabled: true, endpoint: 'https://cloud.langfuse.com', proxyUrl: '' }
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
    fireEvent.click(screen.getByTestId('langfuse-config-toggle'))

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
    // 012：清除密钥也要有结果反馈（清完按钮自己也跟着消失）
    await waitFor(() =>
      expect(screen.getByTestId('langfuse-notice')).toHaveTextContent('密钥已清除')
    )
    expect(screen.queryByTestId('langfuse-clear-keys')).not.toBeInTheDocument()
    expect(useSettingsStore.getState().settings.langfuse.endpoint).toBe(
      'https://cloud.langfuse.com'
    )
  })

  it('密钥解不开（换机）：收起时也给"重新录入"的提示', async () => {
    const bridge = installKyclawBridge()
    bridge.telemetry.langfuseState.mockResolvedValue({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: false, needsReentry: true },
      secretKey: { hasKey: false, needsReentry: true },
      active: false
    })
    render(<TracingSettings />)

    // 要用户动手的事不收进配置区：不展开就看得见
    await waitFor(() =>
      expect(screen.getByTestId('langfuse-reentry')).toHaveTextContent('请重新录入')
    )
    expect(screen.getByTestId('langfuse-config-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  it('文案零 emoji（雷点 v1 第 1 条）', async () => {
    renderTracing()
    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启'))

    const text = screen.getByTestId('tracing-settings').textContent ?? ''
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false)
  })
})

/**
 * round 86（用户口径 010）：**显式开关**。旧口径是"地址留空 = 关闭"这种隐式语义，
 * 现在这个栏目有一枚真的开/关：关掉 = 一律不发（主进程 readLangfuseConfig 也认这一位），
 * 状态行如实说"已关闭"。开关就地落盘（与「记忆」栏同一手法），不等那颗「保存」。
 */
describe('「追踪」组的显式开关（round 86）', () => {
  it('开关在、默认是开（老设置没显式关过 = 开着）；收起时也看得见，不在折叠区里', async () => {
    renderTracing(false)

    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启'))
    const toggle = screen.getByTestId('langfuse-enabled')
    expect(toggle).toHaveAttribute('role', 'switch')
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('langfuse-config-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  it('关掉：就地写 enabled:false（整节带上），状态行说"已关闭"；地址与密钥一项不动', async () => {
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        langfuse: { enabled: true, endpoint: 'https://cloud.langfuse.com', proxyUrl: '' }
      }
    })
    const bridge = installKyclawBridge()
    bridge.telemetry.langfuseState.mockResolvedValue({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: true, needsReentry: false },
      secretKey: { hasKey: true, needsReentry: false },
      active: true
    })
    render(<TracingSettings />)

    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('已开启'))
    fireEvent.click(screen.getByTestId('langfuse-enabled'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        langfuse: { enabled: false, endpoint: 'https://cloud.langfuse.com', proxyUrl: '' }
      })
    )
    // 本次运行的 exporter 是启动时建的：如实说"重启应用后停止"，不假装已经停了
    await waitFor(() =>
      expect(screen.getByTestId('langfuse-status')).toHaveTextContent('已关闭，重启应用后停止')
    )
    expect(screen.getByTestId('langfuse-enabled')).toHaveAttribute('aria-checked', 'false')
    expect(bridge.telemetry.clearLangfuseKeys).not.toHaveBeenCalled()
    expect(bridge.telemetry.setLangfuseKeys).not.toHaveBeenCalled()
  })

  it('再打开：写 enabled:true，状态回到"已开启"（开关是双向的，不是单向关闭）', async () => {
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        langfuse: { enabled: false, endpoint: 'https://cloud.langfuse.com', proxyUrl: '' }
      }
    })
    const bridge = installKyclawBridge()
    bridge.telemetry.langfuseState.mockResolvedValue({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: true, needsReentry: false },
      secretKey: { hasKey: true, needsReentry: false },
      active: true
    })
    render(<TracingSettings />)

    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('已关闭'))
    fireEvent.click(screen.getByTestId('langfuse-enabled'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        langfuse: { enabled: true, endpoint: 'https://cloud.langfuse.com', proxyUrl: '' }
      })
    )
    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('已开启'))
  })

  it('落盘失败（settings:update 抛）：行内给原因，开关不跟着撒谎（状态行仍是已开启）', async () => {
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        langfuse: { enabled: true, endpoint: 'https://cloud.langfuse.com', proxyUrl: '' }
      }
    })
    const bridge = installKyclawBridge()
    bridge.telemetry.langfuseState.mockResolvedValue({
      endpoint: 'https://cloud.langfuse.com',
      publicKey: { hasKey: true, needsReentry: false },
      secretKey: { hasKey: true, needsReentry: false },
      active: true
    })
    bridge.update.mockRejectedValueOnce(new Error('磁盘满了'))
    render(<TracingSettings />)

    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('已开启'))
    fireEvent.click(screen.getByTestId('langfuse-enabled'))

    await waitFor(() => expect(screen.getByTestId('langfuse-error')).toHaveTextContent('磁盘满了'))
    expect(screen.getByTestId('langfuse-enabled')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('langfuse-status')).toHaveTextContent('已开启')
  })

  it('配置项仍在折叠区里（开关没把上一轮 010 的折叠破坏掉）', async () => {
    renderTracing(false)

    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toBeInTheDocument())
    expect(screen.getByTestId('langfuse-enabled')).toBeInTheDocument()
    expect(screen.queryByTestId('langfuse-endpoint')).not.toBeInTheDocument()
    expect(screen.queryByTestId('langfuse-proxy')).not.toBeInTheDocument()
    expect(screen.queryByTestId('langfuse-public-key')).not.toBeInTheDocument()
    expect(screen.queryByTestId('langfuse-secret-key')).not.toBeInTheDocument()
    expect(screen.queryByTestId('langfuse-save')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('langfuse-config-toggle'))
    expect(screen.getByTestId('langfuse-endpoint')).toBeInTheDocument()
    expect(screen.getByTestId('langfuse-proxy')).toBeInTheDocument()
    expect(screen.getByTestId('langfuse-save')).toBeInTheDocument()
  })
})

/**
 * 012（用户口径）：保存成功之后又改了输入，「已保存」要立刻消失 —— 那句话描述的是**落盘的那一份**，
 * 眼前这份新内容还没写下去（关掉页面就丢）。
 * 010 收口：就地写入（开关）一次只写一条，连点两下不并发发两次 settings:update。
 */
describe('「追踪」组的保存反馈与就地写入串行（012 / 010）', () => {
  it('012：保存成功后改地址 → 「已保存」立刻消失（不显示假成功）', async () => {
    const bridge = renderTracing()
    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启'))

    fireEvent.change(screen.getByTestId('langfuse-endpoint'), {
      target: { value: 'https://cloud.langfuse.com' }
    })
    fireEvent.click(screen.getByTestId('langfuse-save'))
    await waitFor(() => expect(bridge.update).toHaveBeenCalled())
    expect(await screen.findByTestId('langfuse-notice')).toHaveTextContent('已保存')

    fireEvent.change(screen.getByTestId('langfuse-endpoint'), {
      target: { value: 'https://cloud.langfuse.com/2' }
    })
    expect(screen.queryByTestId('langfuse-notice')).not.toBeInTheDocument()
    expect(screen.getByTestId('langfuse-endpoint')).toHaveValue('https://cloud.langfuse.com/2')
  })

  it('010：落盘挂着不回来时开关按下即锁住，第二下不再发一次 settings:update', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockImplementationOnce(() => new Promise<AppSettings>(() => {}))
    render(<TracingSettings />)
    await waitFor(() => expect(screen.getByTestId('langfuse-status')).toHaveTextContent('未开启'))

    const toggle = screen.getByTestId('langfuse-enabled')
    fireEvent.click(toggle)

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        langfuse: expect.objectContaining({ enabled: false })
      })
    )
    // 写入期间：开关与「保存」都锁着（这一段里再点也不该再写一条）
    expect(toggle).toBeDisabled()
    fireEvent.click(toggle)
    expect(bridge.update).toHaveBeenCalledTimes(1)
  })
})
