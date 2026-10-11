import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@renderer/features/chat/Composer'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type AppSettings } from '@shared/settings'
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

/**
 * 发送载荷里的正文（模块 2 起 onSend 收 `{ text, files }`：图片要随消息真发，
 * 不能只交一个字符串了）。返回值 = 第 n 次发送的正文。
 */
function sentText(onSend: ReturnType<typeof vi.fn>, call = 0): string {
  const payload = onSend.mock.calls[call]?.[0] as { text?: string } | undefined
  return payload?.text ?? ''
}

/** 发送载荷里随消息真发的文件（image 之外的类型本轮不发） */
function sentFiles(onSend: ReturnType<typeof vi.fn>, call = 0): unknown[] {
  const payload = onSend.mock.calls[call]?.[0] as { files?: unknown[] } | undefined
  return payload?.files ?? []
}

/** 一个设置里有默认 provider（模型名可指定）的环境——图片收/拒要看它 */
function settingsWithProvider(model: string, extra: Partial<AppSettings> = {}): AppSettings {
  return {
    ...defaultSettings(),
    providers: [
      { id: 'p1', type: 'openai-compatible', model, isDefault: true, baseUrl: 'http://x/v1' }
    ],
    ...extra
  }
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

  it('发送钮禁用态（round 17）：图标用 Labels-Tertiary 一档（干净可辨、不显得可用）', () => {
    setup()

    const send = screen.getByTestId('composer-send')
    expect(send).toBeDisabled()
    expect(send).toHaveClass('bg-(--fill-disabled)', 'text-(--text-tertiary)')
    // 线宽 2.4：20px 渲染时正好 device 2px（2.4 × 20/24），像素网格上不发虚
    expect(send.querySelector('svg')?.getAttribute('stroke-width')).toBe('2.4')

    // 可用态完全另一档（墨色底 + 反白箭头），与禁用不混淆
    type('有内容了')
    expect(send).toBeEnabled()
    expect(send).toHaveClass('bg-(--button-primary-bg)', 'text-(--button-primary-fg)')
  })

  it('引用覆盖层（round 21）：同排版 / aria-hidden / pointer-events-none；在 textarea 之上且滚动同步；关掉拼写波浪线', () => {
    setup()

    const mirror = screen.getByTestId('composer-mirror')
    expect(mirror).toHaveAttribute('aria-hidden', 'true')
    expect(mirror).toHaveClass('pointer-events-none', 'text-transparent', 'absolute', 'z-20')
    const layer = mirror.firstElementChild
    expect(layer).toHaveClass('px-4', 'py-3', 'text-b1', 'whitespace-pre-wrap', 'break-words')
    // 覆盖层在 textarea 之上（chip 要盖住底层字形）；textarea 本体仍在文档流里可交互
    expect(screen.getByTestId('composer-input')).toHaveClass('relative', 'z-10')
    // 图1 的红波浪：输入框关掉原生拼写检查
    expect(screen.getByTestId('composer-input')).toHaveAttribute('spellcheck', 'false')

    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    input.scrollTop = 24
    fireEvent.scroll(input)
    expect(mirror.scrollTop).toBe(24)
  })

  it('chip 的 ×：删除该段标记（按原文精确移除），光标落回段起点、焦点留在输入框', () => {
    setup()
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    type('看看【引用】技能：整理笔记 这个')
    expect(screen.getByTestId('composer-ref-chip')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('composer-ref-remove'))

    // 原文里整段（含【引用】前缀）被移除；chip 随之消失
    expect(input).toHaveValue('看看 这个')
    expect(screen.queryByTestId('composer-ref-chip')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(2)
  })

  it('多段标记各是一个 chip：删其中一个不动另一个（精确到段）', () => {
    setup()
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    type('用【引用】技能：A 整理【引用】上下文：工作区 B')
    const chips = screen.getAllByTestId('composer-ref-chip')
    expect(chips).toHaveLength(2)
    expect(chips.map((chip) => chip.textContent)).toEqual(['技能：A', '上下文：工作区'])

    fireEvent.click(screen.getAllByTestId('composer-ref-remove')[0] as HTMLElement)
    expect(input).toHaveValue('用 整理【引用】上下文：工作区 B')
    expect(screen.getAllByTestId('composer-ref-chip')).toHaveLength(1)
  })
})

describe('输入卡键盘行为', () => {
  it('Enter 发送并清空输入（首尾空白去掉）', () => {
    const { onSend } = setup()
    type('  你好  ')

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(sentText(onSend)).toBe('你好')
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

    expect(sentText(onSend)).toBe('接着问一句')
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

    // round 21：覆盖层把标记画成图3 风格 chip（图标 + 文本；【引用】前缀不进可见层）
    const chip = screen.getByTestId('composer-ref-chip')
    expect(chip).toHaveTextContent('技能：整理笔记')
    expect(chip).not.toHaveTextContent('【引用】')
    expect(chip.querySelector('svg')).not.toBeNull()
    // chip 的盒宽由隐形原文占位撑出（与 textarea 里的原文逐字对齐，后面的字不挪位）
    const box = chip.parentElement
    expect(box?.firstElementChild).toHaveClass('invisible', 'whitespace-pre')
    expect(box?.firstElementChild).toHaveTextContent('【引用】技能：整理笔记')
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
    expect(sentText(onSend)).toBe('总结一下【引用】上下文：工作区-默认')
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

    expect(sentText(onSend)).toBe('看这个文件\n\n【附件】note.txt\n```\nhello 附件\n```')
    // 发送后 chip 清空
    expect(screen.queryByTestId('composer-attachment-note.txt')).not.toBeInTheDocument()
  })

  it('只有附件没有正文也能发（内容就是附件块）', async () => {
    const { onSend } = setup()
    const file = new File(['只发文件'], 'only.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [file] } })
    await screen.findByTestId('composer-attachment-only.txt')

    fireEvent.click(screen.getByTestId('composer-send'))
    expect(sentText(onSend)).toBe('【附件】only.txt\n```\n只发文件\n```')
  })

  it('非文本 / 超大明确提示不收（不假装附加成功）', async () => {
    setup()

    const binary = new File(['x'], 'archive.zip', { type: 'application/zip' })
    const big = new File([new Uint8Array(17 * 1024)], 'big.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [binary, big] }
    })

    await waitFor(() =>
      expect(screen.getByTestId('composer-notice')).toHaveTextContent(
        '未附加：archive.zip（不是文本文件）、big.txt（超过 16KB）'
      )
    )
    expect(screen.queryByTestId('composer-attachment-archive.zip')).not.toBeInTheDocument()
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

describe('round 18 · 模型浮窗两截 / 思考强度 / 对话长度 / 上下文环', () => {
  let bridge: KyclawBridgeStubs

  const V4 = {
    id: 'deepseek',
    type: 'openai-compatible' as const,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    isDefault: true
  }

  beforeEach(() => {
    const initial = { ...defaultSettings(), providers: [V4] }
    bridge = installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
  })

  afterEach(() => {
    clearKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  /** 打开模型菜单并展开某个二级浮层 */
  async function openSubmenu(testId: string): Promise<void> {
    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    const trigger = screen.getByTestId(testId)
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    await tick()
  }

  it('两截：上=模型列表；分隔线后是「思考强度 / 对话长度」，右侧显示当前档', () => {
    setup()

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    expect(screen.getByTestId('composer-model-deepseek')).toBeInTheDocument()
    expect(screen.getByTestId('model-efforts')).toHaveTextContent('思考强度')
    expect(screen.getByTestId('model-efforts')).toHaveTextContent('默认')
    expect(screen.getByTestId('model-context')).toHaveTextContent('对话长度')
    expect(screen.getByTestId('model-context')).toHaveTextContent('100%')
  })

  it('思考强度：按注册表动态给挡位（v4-pro 四档）；选「高」→ 落 settings.modelPrefs', async () => {
    setup()
    await openSubmenu('model-efforts')

    expect(screen.getByTestId('model-effort-default')).toHaveTextContent('默认')
    expect(screen.getByTestId('model-effort-low')).toHaveTextContent('低')
    expect(screen.getByTestId('model-effort-high')).toHaveTextContent('高')
    expect(screen.getByTestId('model-effort-max')).toHaveTextContent('最高')
    expect(screen.getByTestId('model-effort-default')).toHaveAttribute('aria-current', 'page')

    fireEvent.click(screen.getByTestId('model-effort-high'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        modelPrefs: { 'deepseek/deepseek-v4-pro': { thinkingEffort: 'high' } }
      })
    )
  })

  it('对话长度：滑块 10–100，拖动只改草稿、松手（pointerUp）才落盘；显示百分比与换算', async () => {
    setup()
    await openSubmenu('model-context')

    const range = screen.getByTestId('model-context-range')
    expect(range).toHaveAttribute('min', '10')
    expect(range).toHaveAttribute('max', '100')
    expect(screen.getByTestId('model-context-slider')).toHaveTextContent('≈ 1M / 1M')

    fireEvent.change(range, { target: { value: '40' } })
    expect(screen.getByTestId('model-context-pct')).toHaveTextContent('40%')
    expect(screen.getByTestId('model-context-slider')).toHaveTextContent('≈ 400K / 1M')
    expect(bridge.update).not.toHaveBeenCalled() // 拖动中不落盘

    fireEvent.pointerUp(range)
    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        modelPrefs: { 'deepseek/deepseek-v4-pro': { contextPct: 40 } }
      })
    )
  })

  it('上下文环与 hover 明细：已用 %、~已用/~总量、分解近似、缓存命中率、阈值（超了转警示）', async () => {
    // 500K / 500K（阈值 50% × 1M）= 100%，超过阈值 → 警示
    useSettingsStore.setState({
      settings: {
        ...defaultSettings(),
        providers: [V4],
        modelPrefs: { 'deepseek/deepseek-v4-pro': { contextPct: 50 } }
      },
      loaded: true
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          threadId: 't1',
          lastInput: 500_000,
          lastCachedInput: 375_000,
          baselineInput: 100_000,
          todayInput: 1_000_000,
          todayCachedInput: 750_000
        })
      }))
    )
    setup({ threadId: 't1' })

    const ring = await screen.findByTestId('context-ring')
    await waitFor(() => expect(ring.querySelector('svg')).toHaveAttribute('data-warning', 'true'))

    fireEvent.focus(ring)
    const card = await screen.findByTestId('context-card')
    expect(card).toHaveTextContent('上下文已用 100%')
    expect(card).toHaveTextContent('~500K / 500K')
    expect(card).toHaveTextContent('系统提示词 / 工具定义')
    expect(card).toHaveTextContent('~100K')
    expect(card).toHaveTextContent('对话消息')
    expect(card).toHaveTextContent('~400K')
    expect(card).toHaveTextContent('最近一轮 75%')
    expect(card).toHaveTextContent('今日 75%')
    expect(card).toHaveTextContent('阈值 50%（已超过）')
  })

  /** 会话上下文的取数回包（口径同上面的 hover 卡测试：500K 已用 / 100K 基线 / 75% 缓存） */
  function contextResponse(): unknown {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        threadId: 't1',
        lastInput: 500_000,
        lastCachedInput: 375_000,
        baselineInput: 100_000,
        todayInput: 1_000_000,
        todayCachedInput: 750_000
      })
    }
  }

  /** 阈值收到 50%（500K / 1M 就顶到阈值）+ 已有上下文数据的会话 */
  function mountHalfWindow(): void {
    // 设置要落进桥里（不是只改 store）：打开弹层会触发一次 probeModels，回包会带着设置回来
    const initial: AppSettings = {
      ...defaultSettings(),
      providers: [V4],
      modelPrefs: { 'deepseek/deepseek-v4-pro': { contextPct: 50 } }
    }
    installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => contextResponse())
    )
    setup({ threadId: 't1' })
  }

  it('round 41：点开弹层就能看全上下文（占用 / 分解 / 缓存 / 阈值）', async () => {
    mountHalfWindow()
    await screen.findByTestId('context-ring')

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })

    const card = screen.getByTestId('model-context-card')
    await waitFor(() => expect(card).toHaveTextContent('上下文已用 100%'))
    expect(card).toHaveTextContent('~500K / 500K')
    expect(card).toHaveTextContent('系统提示词 / 工具定义')
    expect(card).toHaveTextContent('~100K')
    expect(card).toHaveTextContent('对话消息')
    expect(card).toHaveTextContent('~400K')
    expect(card).toHaveTextContent('最近一轮 75%')
    expect(card).toHaveTextContent('今日 75%')
    expect(card).toHaveTextContent('阈值 50%（已超过）')
    // 超了阈值：进度条与上下文环同一档警示色
    expect(card.querySelector('div[style]')).toHaveClass('bg-warning')
  })

  it('round 41：数据还没到 → 弹层里给加载态，不闪一个假的 0%', async () => {
    // 闸门：端点地址那一步是异步的，fetch 可能晚于本函数的同步段才被调用——放行要能被"追认"
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate
        return contextResponse()
      })
    )
    setup({ threadId: 't1' })

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    const card = screen.getByTestId('model-context-card')
    expect(screen.getByTestId('context-loading')).toBeInTheDocument()
    expect(card).not.toHaveTextContent('上下文已用')

    release()
    await waitFor(() => expect(card).toHaveTextContent('上下文已用 50%'))
    expect(screen.queryByTestId('context-loading')).not.toBeInTheDocument()
    expect(card).toHaveTextContent('阈值 100%')
    expect(card).not.toHaveTextContent('（已超过）')
  })

  it('round 41：hover 卡与弹层区块是同源一份（文案逐字一致）', async () => {
    mountHalfWindow()
    const ring = await screen.findByTestId('context-ring')
    await waitFor(() => expect(ring.querySelector('svg')).toHaveAttribute('data-warning', 'true'))

    fireEvent.focus(ring)
    const hoverText = (await screen.findByTestId('context-card')).textContent

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    await waitFor(() =>
      expect(screen.getByTestId('model-context-card').textContent).toBe(hoverText)
    )
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

describe('round 19 · / 命令分区（压缩上下文）与压缩 notice', () => {
  it('键入 /：命令分区在首；回车选中 → onCompact（不插引用标记、触发段清掉、浮窗收起）', () => {
    const onCompact = vi.fn()
    setup({ onCompact })
    const input = typeAt('/')

    expect(screen.getByText('命令')).toBeInTheDocument()
    expect(screen.getByTestId('suggest-command:compact')).toHaveTextContent('压缩上下文')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCompact).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue('')
    expect(screen.getByTestId('composer-suggest')).not.toHaveAttribute('data-open')
  })

  it('压缩中：行显示「压缩中…」并禁用（回车无动作）', () => {
    const onCompact = vi.fn()
    setup({ onCompact, compactBusy: true })
    const input = typeAt('/')

    const row = screen.getByTestId('suggest-command:compact')
    expect(row).toHaveTextContent('压缩中…')
    expect(row).toBeDisabled()

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCompact).not.toHaveBeenCalled()
  })

  it('外部 notice（压缩结果）由上层给：照常显示', () => {
    setup({ externalNotice: { tone: 'success', text: '已压缩历史上下文（保留最近 10 条）' } })
    expect(screen.getByTestId('composer-notice')).toHaveTextContent('已压缩历史上下文')
  })
})

describe('round 22 · probed 实测优先（菜单值来自真实元数据）', () => {
  const FLASH = {
    id: 'deepseek',
    type: 'openai-compatible' as const,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    isDefault: true
  }

  /** 实测样本（主控在官方端点上抓到的形状）：1M / low|high|max / 默认 high */
  function probedNow(): AppSettings['probedModels'] {
    return {
      'deepseek:deepseek-flash': {
        contextWindow: 1_048_576,
        maxOutputTokens: 393_216,
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
        fetchedAt: new Date().toISOString()
      }
    }
  }

  function mountChip(
    probedModels: AppSettings['probedModels']
  ): ReturnType<typeof installKyclawBridge> {
    const initial = { ...defaultSettings(), providers: [FLASH], probedModels }
    const bridge = installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    setup()
    return bridge
  }

  async function openSubmenu(testId: string): Promise<void> {
    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    const trigger = screen.getByTestId(testId)
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    await tick()
  }

  afterEach(() => {
    clearKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  it('滑块与换算用实测 1M——注册表按名字猜的 128K 被盖过（用户点名的纠错）', async () => {
    // 先确认注册表口径确实是 128K（对照），再证明 probed 盖过它
    mountChip({})
    await openSubmenu('model-context')
    expect(screen.getByTestId('model-context-slider')).toHaveTextContent('≈ 128K / 128K')

    cleanup()
    mountChip(probedNow())
    await openSubmenu('model-context')
    expect(screen.getByTestId('model-context-slider')).toHaveTextContent('≈ 1M / 1M')
  })

  it('思考挡位用实测 supported_levels，初始档 = default_level（high 选中）', async () => {
    mountChip(probedNow())
    await openSubmenu('model-efforts')

    expect(screen.getByTestId('model-effort-default')).toHaveTextContent('默认')
    expect(screen.getByTestId('model-effort-low')).toHaveTextContent('低')
    expect(screen.getByTestId('model-effort-high')).toHaveTextContent('高')
    expect(screen.getByTestId('model-effort-max')).toHaveTextContent('最高')
    // 没存过偏好 + 端点 default_level=high → 初始档就是 high（显示与透传同值）
    expect(screen.getByTestId('model-effort-high')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('model-efforts')).toHaveTextContent('高')
  })

  it('菜单打开且实测缓存缺失 → 后台触发一次探测（不挡菜单）', async () => {
    const bridge = mountChip({})

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })

    await waitFor(() => expect(bridge.probeModels).toHaveBeenCalledWith('deepseek'))
  })

  it('缓存新鲜（24h 内）→ 打开菜单不重复探测', async () => {
    const bridge = mountChip(probedNow())

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })

    await tick()
    expect(bridge.probeModels).not.toHaveBeenCalled()
  })
})

describe('模块 2 · 图片与 PDF（视觉模型区分）', () => {
  /** 装一个"有默认 provider"的环境：模型名 + 用户覆盖决定视觉能力 */
  function mount(
    model: string,
    capabilities: AppSettings['modelCapabilities'] = {}
  ): { onSend: ReturnType<typeof vi.fn>; bridge: KyclawBridgeStubs } {
    const initial: AppSettings = { ...settingsWithProvider(model), modelCapabilities: capabilities }
    const bridge = installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    const { onSend } = setup()
    return { onSend, bridge }
  }

  function pick(files: File[]): void {
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files } })
  }

  afterEach(() => {
    clearKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  it('vision=false（注册表：deepseek 全系没有视觉）→ 图片人话拒收，不假装收下', async () => {
    mount('deepseek-chat')

    pick([new File(['x'], 'shot.png', { type: 'image/png' })])

    await waitFor(() =>
      expect(screen.getByTestId('composer-notice')).toHaveTextContent(
        '当前模型不支持看图：可在设置 → 模型里标记视觉模型，或把图片内容用文字描述'
      )
    )
    expect(screen.queryByTestId('composer-attachment-shot.png')).not.toBeInTheDocument()
  })

  it('vision=true（用户覆盖）→ 收下并给缩略图；发送时图片随消息真发（file part）', async () => {
    const { onSend } = mount('deepseek-chat', { 'deepseek-chat': { vision: true } })

    pick([new File(['png-bytes'], 'shot.png', { type: 'image/png' })])

    await screen.findByTestId('composer-attachment-shot.png')
    expect(screen.getByTestId('composer-attachment-thumb-shot.png')).toBeInTheDocument()

    type('这是什么')
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(sentText(onSend)).toBe('这是什么')
    const files = sentFiles(onSend) as Array<{ mediaType: string; url: string; filename?: string }>
    expect(files).toHaveLength(1)
    expect(files[0].mediaType).toBe('image/png')
    expect(files[0].filename).toBe('shot.png')
    expect(files[0].url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('PDF（所有模型统一）：抽取文本内联进正文，chip 上印页数；不随消息发文件', async () => {
    const { onSend, bridge } = mount('deepseek-chat')
    bridge.attachments.extractPdf.mockResolvedValue({
      ok: true,
      pages: 3,
      truncated: false,
      text: '【第 1 页】\n内容'
    })

    pick([new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' })])

    const chip = await screen.findByTestId('composer-attachment-doc.pdf')
    expect(chip).toHaveTextContent('3 页')

    fireEvent.click(screen.getByTestId('composer-send'))
    expect(sentText(onSend)).toBe('【附件】doc.pdf\n```\n【第 1 页】\n内容\n```')
    expect(sentFiles(onSend)).toHaveLength(0)
  })

  it('PDF 触到上限（truncated）：chip 上如实标「已截断」', async () => {
    const { bridge } = mount('deepseek-chat')
    bridge.attachments.extractPdf.mockResolvedValue({
      ok: true,
      pages: 240,
      truncated: true,
      text: '【第 1 页】\n内容'
    })

    pick([new File(['%PDF-1.4'], 'big.pdf', { type: 'application/pdf' })])

    const chip = await screen.findByTestId('composer-attachment-big.pdf')
    expect(chip).toHaveTextContent('240 页（已截断）')
  })

  it('扫描件 PDF（无文字层）→ 人话拒收', async () => {
    const { bridge } = mount('deepseek-chat')
    bridge.attachments.extractPdf.mockResolvedValue({
      ok: false,
      message: '这个 PDF 没有文字层（可能是扫描件），读不到文字内容'
    })

    pick([new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' })])

    await waitFor(() =>
      expect(screen.getByTestId('composer-notice')).toHaveTextContent('没有文字层')
    )
    expect(screen.queryByTestId('composer-attachment-scan.pdf')).not.toBeInTheDocument()
  })

  it('拖拽入卡与 ＋ 上传是同一条路（拖一个文本文件进去照样成 chip）', async () => {
    const { onSend } = mount('deepseek-chat')

    fireEvent.dragOver(screen.getByTestId('composer'))
    expect(screen.getByTestId('composer')).toHaveAttribute('data-dragging', 'true')

    fireEvent.drop(screen.getByTestId('composer'), {
      dataTransfer: { files: [new File(['拖进来的'], 'drop.txt', { type: 'text/plain' })] }
    })

    expect(screen.getByTestId('composer')).not.toHaveAttribute('data-dragging', 'true')
    await screen.findByTestId('composer-attachment-drop.txt')
    fireEvent.click(screen.getByTestId('composer-send'))
    expect(sentText(onSend)).toBe('【附件】drop.txt\n```\n拖进来的\n```')
  })

  it('模型菜单：视觉模型带「看图」小标记；没有视觉的不带', async () => {
    mount('deepseek-chat', { 'deepseek-chat': { vision: true } })
    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    await waitFor(() => expect(screen.getByTestId('composer-model-p1')).toHaveTextContent('看图'))

    cleanup()
    mount('deepseek-chat')
    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    expect(screen.getByTestId('composer-model-p1')).not.toHaveTextContent('看图')
  })
})
