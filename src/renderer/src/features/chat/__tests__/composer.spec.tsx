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

/** 真实键盘的"在末尾输入"：改值 + 把光标放到末尾 + 派发 select（onSelect 会重算触发） */
function typeAt(value: string): HTMLTextAreaElement {
  const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value } })
  input.setSelectionRange(value.length, value.length)
  fireEvent.select(input)
  return input
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

  it('引用镜像层（round 14）：同排版 / aria-hidden / pointer-events-none；textarea 在上层且滚动同步', () => {
    setup()

    const mirror = screen.getByTestId('composer-mirror')
    expect(mirror).toHaveAttribute('aria-hidden', 'true')
    expect(mirror).toHaveClass('pointer-events-none', 'text-transparent')
    const layer = mirror.firstElementChild
    expect(layer).toHaveClass('px-4', 'py-3', 'text-b1', 'whitespace-pre-wrap', 'break-words')
    expect(screen.getByTestId('composer-input')).toHaveClass('relative', 'z-10')

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    input.scrollTop = 24
    fireEvent.scroll(input)
    expect(mirror.scrollTop).toBe(24)
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

  it('工具条左端是 ＋ 按钮（hover 灰底 = 图10；round 15 起是圆形）；菜单四项齐全', () => {
    setup()

    const plus = screen.getByTestId('composer-plus')
    expect(plus).toHaveClass('hover:bg-hover')
    expect(plus).toHaveClass('rounded-full')
    expect(plus).not.toHaveClass('rounded-control')
    fireEvent.keyDown(plus, { key: 'ArrowDown' })

    expect(screen.getByTestId('composer-add-file')).toBeInTheDocument()
    expect(screen.getByTestId('composer-ref-skills')).toBeInTheDocument()
    expect(screen.getByTestId('composer-ref-plugins')).toBeInTheDocument()
    expect(screen.getByTestId('composer-ref-context')).toBeInTheDocument()
  })

  it('hover 提示（round 15）：＋ =「上传文件和更多工具」；权限 chip = 动作文案', () => {
    const initial = {
      ...defaultSettings(),
      workspaces: [{ path: 'D:\\ws', mode: 'ask' as const }]
    }
    installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    setup({ threadId: 't1' })

    fireEvent.focus(screen.getByTestId('composer-plus'))
    expect(screen.getByText('上传文件和更多工具')).toBeInTheDocument()

    fireEvent.blur(screen.getByTestId('composer-plus'))
    fireEvent.focus(screen.getByTestId('composer-permission'))
    expect(screen.getByText('切换权限模式')).toBeInTheDocument()
  })

  it('引用技能：选一条 → **在光标处内联插入标记**（round 14），不顶上挂 chip', async () => {
    const bridge = installKyclawBridge()
    bridge.plugins.overview.mockResolvedValue({
      marketplaces: [],
      installed: [],
      installedSkills: [
        { dir: 'demo-p1-s1', name: '整理笔记', pluginId: 'demo-p1', pluginName: 'p1' }
      ]
    })
    setup()
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    type('先写一句 ')
    input.setSelectionRange(2, 2)

    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })
    const skills = screen.getByTestId('composer-ref-skills')
    skills.focus()
    fireEvent.keyDown(skills, { key: 'ArrowRight' })
    await tick()

    // 内置技能（读取文件…）不在菜单里；装进来的技能在
    expect(screen.queryByTestId('composer-ref-skill-读取文件')).not.toBeInTheDocument()
    fireEvent.click(await screen.findByTestId('composer-ref-skill-demo-p1-s1'))

    // 标记插在光标处（不是末尾、也不是顶上 chip）；光标落在标记（+尾随空格）后面，焦点留在输入框
    expect(input).toHaveValue('先写【引用】技能：整理笔记 一句 ')
    expect(input.selectionStart).toBe('先写【引用】技能：整理笔记 '.length)
    expect(document.activeElement).toBe(input)
    expect(screen.queryByTestId('composer-reference-整理笔记')).not.toBeInTheDocument()

    // 镜像层：标记处有一个 pill 底（textarea 的文字照常渲染在上层）
    expect(screen.getByTestId('composer-mirror-pill')).toHaveTextContent('技能：整理笔记')
  })

  it('引用技能：还没有安装技能时给一条禁用说明（也不列内置技能）', async () => {
    installKyclawBridge()
    setup()
    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })

    const skills = screen.getByTestId('composer-ref-skills')
    skills.focus()
    fireEvent.keyDown(skills, { key: 'ArrowRight' })
    await tick()

    expect(screen.getByRole('menuitem', { name: '还没有安装技能' })).toHaveAttribute(
      'data-disabled'
    )
    expect(screen.queryByTestId('composer-ref-skill-读取文件')).not.toBeInTheDocument()
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

  it('引用上下文：判不出工作区时禁用；有工作区时在光标处插入「上下文：目录名」标记并随正文发出', async () => {
    const initial = {
      ...defaultSettings(),
      workspaces: [{ path: 'D:\\kyclaw\\工作区-默认', mode: 'ask' as const }]
    }
    installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    const { onSend } = setup({ threadId: 't1' })

    type('总结一下')
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    input.setSelectionRange(4, 4)

    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('composer-ref-context'))

    // 内联插入在光标处：标记成为正文的一部分（不再是独立的一段「【引用】…」）
    expect(input).toHaveValue('总结一下【引用】上下文：工作区-默认 ')

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('总结一下【引用】上下文：工作区-默认')
  })

  it('引用上下文：没有工作区时菜单项禁用（点了没有用的事不给做）', () => {
    setup()
    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })

    expect(screen.getByTestId('composer-ref-context')).toHaveAttribute('data-disabled')
  })
})

describe('round 15 · @ 文件浮窗', () => {
  afterEach(() => {
    clearKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  function setupWithFiles(files: string[]): KyclawBridgeStubs {
    const bridge = installKyclawBridge()
    bridge.workspace.listFiles.mockResolvedValue({ files })
    setup({ threadId: 't1' })
    return bridge
  }

  it('键入 @：浮窗列出工作区文件（主行文件名 + 次要相对路径）；继续输入过滤', async () => {
    const bridge = setupWithFiles(['src/App.tsx', 'src/main.ts', 'README.md'])

    typeAt('@')
    expect(screen.getByTestId('composer-suggest')).toHaveAttribute('data-open', 'true')
    await screen.findByTestId('suggest-file:README.md')
    expect(bridge.workspace.listFiles).toHaveBeenCalledWith('t1')

    expect(screen.getByTestId('suggest-file:src/App.tsx')).toHaveTextContent('App.tsx')
    expect(screen.getByTestId('suggest-file:src/App.tsx')).toHaveTextContent('src/App.tsx')

    typeAt('@main')
    expect(screen.queryByTestId('suggest-file:README.md')).not.toBeInTheDocument()
    expect(screen.getByTestId('suggest-file:src/main.ts')).toBeInTheDocument()
  })

  it('↑/↓ 走条目；Enter 选中（插标记、光标落后面、关浮窗、不发送）', async () => {
    const bridge = installKyclawBridge()
    bridge.workspace.listFiles.mockResolvedValue({
      files: ['src/App.tsx', 'src/main.ts', 'README.md']
    })
    const { onSend } = setup({ threadId: 't1' })
    const input = typeAt('看 @re')

    // 过滤到 README.md 一条
    await screen.findByTestId('suggest-file:README.md')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('看 【引用】文件：README.md ')
    expect(input.selectionStart).toBe('看 【引用】文件：README.md '.length)
    expect(screen.getByTestId('composer-suggest')).not.toHaveAttribute('data-open')

    // ↑/↓：两条时下键切到第二条、上键回第一条
    typeAt('@src')
    await screen.findByTestId('suggest-file:src/App.tsx')
    expect(screen.getByTestId('suggest-file:src/App.tsx')).toHaveAttribute('data-active', 'true')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByTestId('suggest-file:src/main.ts')).toHaveAttribute('data-active', 'true')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(screen.getByTestId('suggest-file:src/App.tsx')).toHaveAttribute('data-active', 'true')
  })

  it('Esc 关浮窗（文本保留）；词中的 @（邮箱）不触发', async () => {
    setupWithFiles(['README.md'])
    const input = typeAt('@re')
    await screen.findByTestId('suggest-file:README.md')

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByTestId('composer-suggest')).not.toHaveAttribute('data-open')
    expect(input).toHaveValue('@re')

    typeAt('邮箱 a@b')
    expect(screen.getByTestId('composer-suggest')).not.toHaveAttribute('data-open')
  })

  it('取不到文件：浮窗里给人话（不炸页面）', async () => {
    const bridge = installKyclawBridge()
    bridge.workspace.listFiles.mockRejectedValue(new Error('这个会话的工作区不唯一'))
    setup({ threadId: 't1' })

    typeAt('@')
    expect(await screen.findByTestId('composer-suggest-notice')).toHaveTextContent('工作区不唯一')
  })
})

describe('round 15 · / 插件与技能浮窗', () => {
  afterEach(() => {
    clearKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  function setupSlash(): KyclawBridgeStubs {
    const bridge = installKyclawBridge()
    bridge.plugins.overview.mockResolvedValue({
      marketplaces: [],
      installed: [],
      installedSkills: [
        { dir: 'demo-p1-s1', name: '整理笔记', pluginId: 'demo-p1', pluginName: 'p1' }
      ]
    })
    const initial = {
      ...defaultSettings(),
      mcpServers: [
        {
          id: 'mcp-1',
          name: '知识库',
          transport: 'http' as const,
          url: 'http://127.0.0.1:8765/mcp',
          enabled: true,
          readOnlyTools: []
        }
      ]
    }
    useSettingsStore.setState({ settings: initial, loaded: true })
    setup()
    return bridge
  }

  it('键入 /：分区列出启用中的插件与已安装技能；过滤可只剩一组', async () => {
    setupSlash()
    const input = typeAt('/')

    expect(screen.getByTestId('composer-suggest')).toHaveAttribute('data-open', 'true')
    expect(await screen.findByTestId('suggest-plugin:mcp-1')).toHaveTextContent('知识库')
    expect(screen.getByTestId('suggest-skill:demo-p1-s1')).toHaveTextContent('整理笔记')
    expect(screen.getByText('插件')).toBeInTheDocument()
    expect(screen.getByText('技能')).toBeInTheDocument()

    typeAt('/笔记')
    expect(screen.queryByTestId('suggest-plugin:mcp-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('suggest-skill:demo-p1-s1')).toBeInTheDocument()
    expect(screen.queryByText('插件')).not.toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('【引用】技能：整理笔记 ')
  })

  it('选中插件行：插入「插件」标记；词组中的 /（路径）不触发', async () => {
    setupSlash()
    const input = typeAt('/知')
    await screen.findByTestId('suggest-plugin:mcp-1')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('【引用】插件：知识库 ')

    typeAt('src/main')
    expect(screen.getByTestId('composer-suggest')).not.toHaveAttribute('data-open')
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

  it('round 13：默认无描边（无 border）；hover / 展开只铺灰底；h-8 同 ＋ 按钮', () => {
    setup({ threadId: 't1' })

    const chip = screen.getByTestId('composer-permission')
    expect(chip).not.toHaveClass('border-hairline')
    expect(chip.className).not.toContain('border')
    expect(chip).toHaveClass('hover:bg-hover', 'hover:text-ink')
    expect(chip.className).toContain('data-[state=open]:bg-hover')
    expect(chip).toHaveClass('h-8')
    expect(chip).not.toHaveClass('h-(--chip-height)')
  })

  it('round 13：「完全访问」= 警示色 + ShieldAlert（不走带对勾的 ShieldCheck）', () => {
    const full = {
      ...defaultSettings(),
      workspaces: [{ path: 'D:\\ws', mode: 'full' as const }]
    }
    bridge = installKyclawBridge(full)
    useSettingsStore.setState({ settings: full, loaded: true })
    setup({ threadId: 't1' })

    const chip = screen.getByTestId('composer-permission')
    expect(chip).toHaveTextContent('完全访问')
    expect(chip).toHaveClass('text-warning')
    const icon = chip.querySelector('svg')
    expect(icon?.getAttribute('class')).toContain('lucide-shield-alert')
    expect(icon?.getAttribute('class')).not.toContain('shield-check')
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
