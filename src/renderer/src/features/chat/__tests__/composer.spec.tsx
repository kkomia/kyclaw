import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@renderer/features/chat/Composer'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'
import { tick } from '@renderer/components/ui/__tests__/tick'

/**
 * 输入卡（UI 返工 R1）：UI 参考 §4.6 的实测数值（宽 768 / 圆角 24 / 发送钮 36）+
 * 实况页结构（单行输入 + 一行工具条，输入区自适应、封顶后内部滚动），以及键盘/按钮行为。
 * 组件只把 onSend / onStop 抛给上层——队列与截断重发在 ChatPage（chat-flow.spec）。
 *
 * round 7（用户实拍 #10）：工具条补齐 ＋菜单（添加文件/引用技能/引用插件/引用上下文）、
 * 权限 chip（ask|full 两档，full 先确认）、模型 chip（T8 已配置 provider），
 * 附件最小可用（文本 ≤16KB → chip → 内容内联进消息文本）。
 */
function setup(props: Partial<Parameters<typeof Composer>[0]> = {}): {
  onSend: ReturnType<typeof vi.fn>
  onStop: ReturnType<typeof vi.fn>
} {
  const onSend = vi.fn()
  const onStop = vi.fn()
  render(<Composer onSend={onSend} onStop={onStop} {...props} />)
  return { onSend, onStop }
}

function type(text: string): void {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
}

describe('输入卡结构与尺寸（UI 参考 §4.6 + 实况页 a84af355）', () => {
  it('max 768 / 圆角 24 / 输入区自适应（48–170）/ 工具条 48 / 发送钮 36', () => {
    setup()

    expect(screen.getByTestId('composer')).toHaveClass(
      'max-w-(--chat-input-max-width)',
      'rounded-input'
    )
    expect(screen.getByTestId('composer-input')).toHaveClass(
      'field-sizing-content',
      'min-h-(--composer-input-min-height)',
      'max-h-(--composer-input-max-height)',
      'overflow-y-auto'
    )
    expect(screen.getByTestId('composer-footer')).toHaveClass('h-(--composer-toolbar-height)')
    expect(screen.getByTestId('composer-send')).toHaveClass('size-9')
  })

  it('焦点指示由卡片给（跟圆角），输入框自己不再画方框（雷点 6）', () => {
    setup()

    // 输入框本身没有圆角：它自己画的 inset 环会压在卡片圆角上（深色下就是那个白色直角框）
    expect(screen.getByTestId('composer')).toHaveClass('focus-ring-container')
    expect(screen.getByTestId('composer-input')).toHaveClass('focus-visible:shadow-none')
  })

  it('默认单行紧凑：没有横幅带、也没有键盘提示小字（雷点 2：不靠小字补设计）', () => {
    setup()

    expect(screen.queryByTestId('composer-banner')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer')).not.toHaveTextContent('Enter')
    expect(screen.getByTestId('composer-input')).toHaveAttribute('rows', '1')
  })

  it('空输入时发送钮禁用，有内容才可点', () => {
    const { onSend } = setup()

    const send = screen.getByTestId('composer-send')
    expect(send).toBeDisabled()
    fireEvent.click(send)
    expect(onSend).not.toHaveBeenCalled()

    type('有内容了')
    expect(send).toBeEnabled()
  })
})

describe('输入卡键盘行为', () => {
  it('Enter 发送并清空输入（首尾空白去掉）', () => {
    const { onSend } = setup()
    type('  你好  ')

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('你好')
    expect(screen.getByTestId('composer-input')).toHaveValue('')
  })

  it('Shift+Enter 只换行，不发送', () => {
    const { onSend } = setup()
    type('第一行')

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', shiftKey: true })

    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveValue('第一行')
  })

  it('输入法合成中的回车不算发送（中文选词不误发）', () => {
    const { onSend } = setup()
    type('你好')

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', isComposing: true })

    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveValue('你好')
  })

  it('纯空白不发送', () => {
    const { onSend } = setup()
    type('   ')

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('输入卡流式态', () => {
  it('流式中：发送钮变停止钮，点击走 onStop', () => {
    const { onStop, onSend } = setup({ busy: true })

    expect(screen.queryByTestId('composer-send')).not.toBeInTheDocument()
    const stop = screen.getByTestId('composer-stop')
    expect(stop).toHaveClass('size-9')

    fireEvent.click(stop)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('流式中敲字回车：照样交给上层（由上层排队），输入框清空', () => {
    const { onSend } = setup({ busy: true })
    type('接着问一句')

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('接着问一句')
    expect(screen.getByTestId('composer-input')).toHaveValue('')
  })

  it('排队条数为 0 时不显示排队提示，有排队时显示条数', () => {
    const { unmount } = render(<Composer onSend={vi.fn()} onStop={vi.fn()} />)
    expect(screen.queryByTestId('composer-queue')).not.toBeInTheDocument()
    unmount()

    render(<Composer busy queuedCount={2} onSend={vi.fn()} onStop={vi.fn()} />)
    expect(screen.getByTestId('composer-queue')).toHaveTextContent('已排队 2 条')
  })
})

describe('round 7 · ＋菜单与引用', () => {
  afterEach(() => {
    clearKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  it('工具条左端是 ＋ 按钮（hover 灰底 = 图10）；菜单四项齐全', () => {
    setup()

    const plus = screen.getByTestId('composer-plus')
    expect(plus).toHaveClass('hover:bg-hover')
    fireEvent.keyDown(plus, { key: 'ArrowDown' })

    expect(screen.getByTestId('composer-add-file')).toBeInTheDocument()
    expect(screen.getByTestId('composer-ref-skills')).toBeInTheDocument()
    expect(screen.getByTestId('composer-ref-plugins')).toBeInTheDocument()
    expect(screen.getByTestId('composer-ref-context')).toBeInTheDocument()
  })

  it('引用技能：子菜单 = 内置技能清单；选一条 → 引用 chip（可移除）', async () => {
    setup()
    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })

    const skills = screen.getByTestId('composer-ref-skills')
    skills.focus()
    fireEvent.keyDown(skills, { key: 'ArrowRight' })
    await tick()

    fireEvent.click(await screen.findByTestId('composer-ref-skill-读取文件'))
    expect(screen.getByTestId('composer-reference-读取文件')).toHaveTextContent('技能：读取文件')

    fireEvent.click(screen.getByLabelText('移除引用 读取文件'))
    expect(screen.queryByTestId('composer-reference-读取文件')).not.toBeInTheDocument()
  })

  it('引用插件：没有已启用的插件时给一条禁用项（不假装有）', async () => {
    setup()
    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })

    const plugins = screen.getByTestId('composer-ref-plugins')
    plugins.focus()
    fireEvent.keyDown(plugins, { key: 'ArrowRight' })
    await tick()

    expect(screen.getByRole('menuitem', { name: '没有已启用的插件' })).toHaveAttribute(
      'data-disabled'
    )
  })

  it('引用上下文：判不出工作区时禁用；有工作区时给「上下文：目录名」chip', async () => {
    const initial = {
      ...defaultSettings(),
      workspaces: [{ path: 'D:\\kyclaw\\工作区-默认', mode: 'ask' as const }]
    }
    installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    const { onSend } = setup({ threadId: 't1' })
    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })

    fireEvent.click(screen.getByTestId('composer-ref-context'))
    expect(screen.getByTestId('composer-reference-工作区-默认')).toHaveTextContent(
      '上下文：工作区-默认'
    )

    type('总结一下')
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('总结一下\n\n【引用】上下文：工作区-默认')
  })

  it('引用上下文：没有工作区时菜单项禁用（点了没有用的事不给做）', () => {
    setup()
    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })

    expect(screen.getByTestId('composer-ref-context')).toHaveAttribute('data-disabled')
  })
})

describe('round 7 · 添加文件（最小可用：文本 ≤16KB，内容随消息发出）', () => {
  it('选文本文件 → 附件 chip（名字 + 大小）；发送时内容内联进消息文本', async () => {
    const { onSend } = setup()

    const file = new File(['hello 附件'], 'note.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [file] } })

    const chip = await screen.findByTestId('composer-attachment-note.txt')
    expect(chip).toHaveTextContent('note.txt')
    expect(chip).toHaveTextContent('B')

    type('看这个文件')
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('看这个文件\n\n【附件】note.txt\n```\nhello 附件\n```')
    // 发送后 chip 清空
    expect(screen.queryByTestId('composer-attachment-note.txt')).not.toBeInTheDocument()
  })

  it('只有附件没有正文也能发（内容就是附件块）', async () => {
    const { onSend } = setup()
    const file = new File(['只发文件'], 'only.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [file] } })
    await screen.findByTestId('composer-attachment-only.txt')

    fireEvent.click(screen.getByTestId('composer-send'))
    expect(onSend).toHaveBeenCalledWith('【附件】only.txt\n```\n只发文件\n```')
  })

  it('非文本 / 超大明确提示不收（不假装附加成功）', async () => {
    setup()

    const image = new File(['x'], 'photo.png', { type: 'image/png' })
    const big = new File([new Uint8Array(17 * 1024)], 'big.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [image, big] }
    })

    await waitFor(() =>
      expect(screen.getByTestId('composer-notice')).toHaveTextContent(
        '未附加：photo.png（不是文本文件）、big.txt（超过 16KB）'
      )
    )
    expect(screen.queryByTestId('composer-attachment-photo.png')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-attachment-big.txt')).not.toBeInTheDocument()
  })

  it('附件 chip 可以移除', async () => {
    setup()
    const file = new File(['内容'], 'note.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [file] } })
    await screen.findByTestId('composer-attachment-note.txt')

    fireEvent.click(screen.getByLabelText('移除 note.txt'))
    expect(screen.queryByTestId('composer-attachment-note.txt')).not.toBeInTheDocument()
  })
})

describe('round 7 · 权限 chip（ask|full 两档，full 先确认）', () => {
  let bridge: KyclawBridgeStubs

  beforeEach(() => {
    const initial = {
      ...defaultSettings(),
      workspaces: [{ path: 'D:\\ws', mode: 'ask' as const }]
    }
    bridge = installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
  })

  afterEach(() => {
    clearKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  it('默认显示「每次询问」；切「完全访问」先弹确认框，确认后才走 set-mode 通道', async () => {
    setup({ threadId: 't1' })

    const chip = screen.getByTestId('composer-permission')
    expect(chip).toHaveTextContent('每次询问')

    fireEvent.keyDown(chip, { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('composer-permission-full'))

    // 确认框（与设置页同一套语义）——没确认之前不落盘
    expect(screen.getByText('开启完全访问？')).toBeInTheDocument()
    expect(bridge.workspace.setMode).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('composer-full-confirm'))
    await waitFor(() => expect(bridge.workspace.setMode).toHaveBeenCalledWith('D:\\ws', 'full'))
    await waitFor(() =>
      expect(screen.getByTestId('composer-permission')).toHaveTextContent('完全访问')
    )
  })

  it('取消确认：不落盘、chip 保持原档', async () => {
    setup({ threadId: 't1' })
    fireEvent.keyDown(screen.getByTestId('composer-permission'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('composer-permission-full'))
    fireEvent.click(screen.getByTestId('composer-full-cancel'))

    expect(bridge.workspace.setMode).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-permission')).toHaveTextContent('每次询问')
  })

  it('收紧方向（回「每次询问」）直接切，不需要确认框', async () => {
    const full = {
      ...defaultSettings(),
      workspaces: [{ path: 'D:\\ws', mode: 'full' as const }]
    }
    bridge = installKyclawBridge(full)
    useSettingsStore.setState({ settings: full, loaded: true })
    setup({ threadId: 't1' })

    expect(screen.getByTestId('composer-permission')).toHaveTextContent('完全访问')
    fireEvent.keyDown(screen.getByTestId('composer-permission'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('composer-permission-ask'))

    expect(screen.queryByText('开启完全访问？')).not.toBeInTheDocument()
    await waitFor(() => expect(bridge.workspace.setMode).toHaveBeenCalledWith('D:\\ws', 'ask'))
  })

  it('切换失败：行内给原因，不静默', async () => {
    bridge.workspace.setMode.mockRejectedValueOnce(new Error('这个文件夹不在授权列表里'))
    setup({ threadId: 't1' })
    fireEvent.keyDown(screen.getByTestId('composer-permission'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('composer-permission-full'))
    fireEvent.click(screen.getByTestId('composer-full-confirm'))

    await waitFor(() =>
      expect(screen.getByTestId('composer-notice')).toHaveTextContent('这个文件夹不在授权列表里')
    )
  })

  it('判不出会话工作区（多处并列）时不渲染权限入口', () => {
    const ambiguous = {
      ...defaultSettings(),
      workspaces: [
        { path: 'D:\\a', mode: 'ask' as const },
        { path: 'E:\\b', mode: 'ask' as const }
      ]
    }
    installKyclawBridge(ambiguous)
    useSettingsStore.setState({ settings: ambiguous, loaded: true })
    setup({ threadId: 't1' })

    expect(screen.queryByTestId('composer-permission')).not.toBeInTheDocument()
  })
})

describe('round 7 · 模型 chip（T8 已配置 provider，含 isDefault）', () => {
  let bridge: KyclawBridgeStubs

  const PROVIDERS = [
    {
      id: 'deepseek',
      type: 'openai-compatible' as const,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      isDefault: true
    },
    {
      id: 'other',
      type: 'openai-compatible' as const,
      baseUrl: 'https://example.com',
      model: '',
      isDefault: false
    }
  ]

  beforeEach(() => {
    const initial = { ...defaultSettings(), providers: PROVIDERS }
    bridge = installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
  })

  afterEach(() => {
    clearKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  it('没有配 provider 时不渲染（设置页才是配置入口）', () => {
    useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
    setup()

    expect(screen.queryByTestId('composer-model')).not.toBeInTheDocument()
  })

  it('chip 显示默认 provider 的模型名；菜单选中项跟着 isDefault', () => {
    setup()

    expect(screen.getByTestId('composer-model')).toHaveTextContent('deepseek-chat')
    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })

    expect(screen.getByTestId('composer-model-deepseek')).toHaveAttribute('aria-current', 'page')
    // 没填 model 的 provider 用 id 显示
    expect(screen.getByTestId('composer-model-other')).toHaveTextContent('other')
  })

  it('round 8：默认不带圆角框线（无 border）；hover / 展开才铺灰底', () => {
    setup()

    const trigger = screen.getByTestId('composer-model')
    expect(trigger).not.toHaveClass('border-hairline')
    expect(trigger.className).not.toContain('border')
    expect(trigger).toHaveClass('hover:bg-hover', 'hover:text-ink')
    expect(trigger.className).toContain('data-[state=open]:bg-hover')
    // 文字按钮形态：与 ＋ 按钮同高（h-8），不是 Chip 的药丸（不占 chip 高度 token）
    expect(trigger).toHaveClass('h-8')
    expect(trigger).not.toHaveClass('h-(--chip-height)')
  })

  it('切换默认模型：走 saveProviders 落盘，chip 跟着换', async () => {
    setup()
    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('composer-model-other'))

    await waitFor(() => expect(screen.getByTestId('composer-model')).toHaveTextContent('other'))
    expect(bridge.update).toHaveBeenCalledWith({
      providers: [
        expect.objectContaining({ id: 'deepseek', isDefault: false }),
        expect.objectContaining({ id: 'other', isDefault: true })
      ]
    })
  })
})
