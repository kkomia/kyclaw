import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '@renderer/features/chat/Composer'
import { publishContextItem, publishDraft } from '@renderer/features/chat/composer-inbox'
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
  it('max 768 / 圆角 24 / 输入区自适应（56–170）/ 工具条 48 / 发送钮 36', () => {
    setup()

    expect(screen.getByTestId('composer')).toHaveClass(
      'max-w-(--chat-input-max-width)',
      'rounded-input',
      'border-surface-border',
      'font-sans',
      'shadow-(--shadow-composer)'
    )
    expect(screen.getByTestId('composer-input')).toHaveClass(
      'field-sizing-content',
      'min-h-(--composer-input-min-height)',
      'max-h-(--composer-input-max-height)',
      'overflow-y-auto'
    )
    expect(screen.getByTestId('composer-footer')).toHaveClass('h-(--composer-toolbar-height)')
    expect(screen.getByTestId('composer-send')).toHaveClass('size-8')
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

  it('发送钮禁用态（P1a / 章程 §9.2#6）：quaternary + opacity，可辨但不可点', () => {
    setup()

    const send = screen.getByTestId('composer-send')
    expect(send).toBeDisabled()
    expect(send).toHaveClass('bg-(--fill-disabled)', 'text-(--text-quaternary)', 'opacity-60')
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
    expect(stop).toHaveClass('size-8')

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

    // 菜单只列清单里的技能（round 64：内置技能也在这一份清单里，见下一条用例）
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

  it('引用技能：内置技能进菜单且不带「来自插件」这类错误归属（round 64）', async () => {
    const bridge = installKyclawBridge()
    bridge.plugins.overview.mockResolvedValue({
      marketplaces: [],
      installed: [],
      installedSkills: [
        { dir: 'pptx', name: 'pptx', pluginId: null, pluginName: null, source: 'builtin' },
        { dir: 'docx', name: 'docx', pluginId: null, pluginName: null, source: 'builtin' },
        { dir: 'demo-p1-s1', name: '整理笔记', pluginId: 'demo-p1', pluginName: 'p1' }
      ]
    })
    setup()
    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })

    const skills = screen.getByTestId('composer-ref-skills')
    skills.focus()
    fireEvent.keyDown(skills, { key: 'ArrowRight' })
    await tick()

    // 内置技能在菜单里，行上只有名字（归属与分组在插件页的「技能」面板里给）
    const builtin = await screen.findByTestId('composer-ref-skill-pptx')
    expect(builtin).toHaveTextContent('pptx')
    expect(builtin).not.toHaveTextContent('来自')
    expect(screen.getByTestId('composer-ref-skill-docx')).toHaveTextContent('docx')
    // 插件带来的技能同在这一份清单里；整个子菜单不出现任何归属文案
    expect(screen.getByTestId('composer-ref-skill-demo-p1-s1')).toHaveTextContent('整理笔记')
    expect(screen.queryByText(/来自/)).not.toBeInTheDocument()
  })

  it('引用技能：一条技能都没有时给一条禁用说明', async () => {
    installKyclawBridge()
    setup()
    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })

    const skills = screen.getByTestId('composer-ref-skills')
    skills.focus()
    fireEvent.keyDown(skills, { key: 'ArrowRight' })
    await tick()

    expect(screen.getByRole('menuitem', { name: '还没有可引用的技能' })).toHaveAttribute(
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

  it('round 81 · 模式分组在同一个 ＋ 菜单里：进入规划模式只在可进入时给，运行中禁用', () => {
    const onEnterPlan = vi.fn()
    const onToggleTasks = vi.fn()
    const initial = {
      ...defaultSettings(),
      workspaces: [{ path: 'D:\\ws', mode: 'ask' as const }]
    }
    installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    setup({
      threadId: 't1',
      mode: { plan: { onSelect: onEnterPlan }, tasks: { expanded: false, onSelect: onToggleTasks } }
    })
    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })

    // 权限 chip 仍在工具条上（模式搬迁不动权限档位）
    expect(screen.getByTestId('composer-permission')).toBeInTheDocument()
    expect(screen.getByTestId('composer-mode-plan')).toHaveTextContent('进入规划模式')
    // 任务清单那一条跟着当前展开状态给文案
    expect(screen.getByTestId('composer-mode-tasks')).toHaveTextContent('任务清单')
    fireEvent.click(screen.getByTestId('composer-mode-plan'))
    expect(onEnterPlan).toHaveBeenCalledTimes(1)
    expect(onToggleTasks).not.toHaveBeenCalled()
  })

  it('round 81 · 任务清单已展开时那条变成「收起任务清单」，点了回调出去', () => {
    const onToggleTasks = vi.fn()
    setup({
      threadId: 't1',
      mode: { plan: null, tasks: { expanded: true, onSelect: onToggleTasks } }
    })
    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })

    expect(screen.queryByTestId('composer-mode-plan')).not.toBeInTheDocument()
    const tasks = screen.getByTestId('composer-mode-tasks')
    expect(tasks).toHaveTextContent('收起任务清单')
    fireEvent.click(tasks)
    expect(onToggleTasks).toHaveBeenCalledTimes(1)
  })

  it('round 81 · 未就绪 / 正在运行：没有模式分组时不铺假入口，有的也只是禁用', () => {
    const { unmount } = render(<Composer onSend={vi.fn()} onStop={vi.fn()} />)
    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })
    expect(screen.queryByTestId('composer-mode-plan')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-mode-tasks')).not.toBeInTheDocument()
    unmount()
    cleanup()

    setup({
      threadId: 't1',
      mode: {
        plan: { disabled: true, onSelect: vi.fn() },
        tasks: { expanded: false, onSelect: vi.fn() }
      }
    })
    fireEvent.keyDown(screen.getByTestId('composer-plus'), { key: 'ArrowDown' })
    expect(screen.getByTestId('composer-mode-plan')).toHaveAttribute('data-disabled')
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
  it('无路径兜底（桥拿不到路径）：选文本文件 → 附件 chip（名字 + 大小）；内容内联进消息文本', async () => {
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

  it('无路径兜底时非文本 / 超大才明确提示不收（不假装附加成功）', async () => {
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

describe('round 53 · 非图片非 PDF 的附件走路径引用（路径优先，不读内容）', () => {
  afterEach(() => {
    clearKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  /** 装一个会话根 = D:\ws 的环境；`map` 给"文件名 → 绝对路径"（不在表里的回 ''，走无路径兜底） */
  function mountWithPaths(map: Record<string, string> = {}): ReturnType<typeof vi.fn> {
    const initial: AppSettings = {
      ...defaultSettings(),
      workspaces: [{ path: 'D:\\ws', mode: 'ask' }]
    }
    const bridge = installKyclawBridge(initial)
    bridge.files.pathForFile.mockImplementation((file: File) => map[file.name] ?? '')
    useSettingsStore.setState({ settings: initial, loaded: true })
    const { onSend } = setup({ threadId: 't1' })
    return onSend
  }

  function pick(file: File): void {
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [file] } })
  }

  it('根内：载荷 = 工作区相对路径（正斜杠，与文件树引用同口径），连内容都不读', async () => {
    const onSend = mountWithPaths({ 'note.txt': 'D:\\ws\\src\\note.txt' })

    pick(new File(['hello'], 'note.txt', { type: 'text/plain' }))

    const chip = await screen.findByTestId('composer-attachment-note.txt')
    expect(chip).toHaveTextContent('note.txt')
    // tooltip = 完整（绝对）路径
    expect(chip).toHaveAttribute('title', 'D:\\ws\\src\\note.txt')

    type('看这个文件')
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    expect(sentText(onSend)).toBe('看这个文件\n\n【附件】src/note.txt')
  })

  /* round 55：无项目会话的真根 = 默认工作区下的会话子目录（不是默认工作区本身） */
  it('无项目会话落在默认工作区下的子目录：子目录里的文件算**根内**（载荷发相对路径）', async () => {
    const initial: AppSettings = {
      ...defaultSettings(),
      workspaces: [{ path: 'D:\\ws', mode: 'ask' }],
      defaultWorkspace: 'D:\\ws'
    }
    const bridge = installKyclawBridge(initial)
    // 真根 = D:\ws\tasks\<threadId 前 8 位>（这里 threadId = t1）；拿 D:\ws 当基准会误判成"根外"
    bridge.files.pathForFile.mockImplementation(() => 'D:\\ws\\tasks\\t1\\note.txt')
    useSettingsStore.setState({ settings: initial, loaded: true })
    const { onSend } = setup({ threadId: 't1' })

    pick(new File(['hello'], 'note.txt', { type: 'text/plain' }))

    const chip = await screen.findByTestId('composer-attachment-note.txt')
    expect(chip).toHaveAttribute('title', 'D:\\ws\\tasks\\t1\\note.txt')
    fireEvent.click(screen.getByTestId('composer-send'))
    expect(sentText(onSend)).toBe('【附件】note.txt')
  })

  it('根外（比如 Downloads）：原样绝对路径；exe 照收，没有"文件太大"', async () => {
    const onSend = mountWithPaths({
      'mediacreationtool.exe': 'C:\\Users\\me\\Downloads\\mediacreationtool.exe'
    })

    pick(
      new File([new Uint8Array(10 * 1024 * 1024)], 'mediacreationtool.exe', {
        type: 'application/x-msdownload'
      })
    )

    const chip = await screen.findByTestId('composer-attachment-mediacreationtool.exe')
    expect(chip).toHaveTextContent('10.0 MB')
    expect(chip).toHaveAttribute('title', 'C:\\Users\\me\\Downloads\\mediacreationtool.exe')
    // 10MB 的 exe：一个 Notice 都不该有（旧口径会在这里回"超过 16KB"）
    expect(screen.queryByTestId('composer-notice')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('composer-send'))
    expect(sentText(onSend)).toBe('【附件】C:\\Users\\me\\Downloads\\mediacreationtool.exe')
    expect(sentText(onSend)).not.toContain('文件太大')
  })

  it('判不出会话根（没有工作区）：路径按绝对引用（不硬造相对路径）', async () => {
    const initial = defaultSettings()
    const bridge = installKyclawBridge(initial)
    bridge.files.pathForFile.mockImplementation(() => 'D:\\其它\\a.bin')
    useSettingsStore.setState({ settings: initial, loaded: true })
    const { onSend } = setup()

    pick(new File(['x'], 'a.bin', { type: 'application/octet-stream' }))
    await screen.findByTestId('composer-attachment-a.bin')

    fireEvent.click(screen.getByTestId('composer-send'))
    expect(sentText(onSend)).toBe('【附件】D:\\其它\\a.bin')
  })

  it('桥拿不到路径（回空）：兜底旧行为 —— 文本内联 / 大文件仍旧拒收', async () => {
    const onSend = mountWithPaths({}) // 什么都不映射 → 全部回空

    pick(new File(['内联的内容'], 'small.txt', { type: 'text/plain' }))
    const chip = await screen.findByTestId('composer-attachment-small.txt')
    expect(chip).toHaveAttribute('title', 'small.txt')

    // 等第一份收完再放第二份：两次并发跑的话 notice 谁后到说不准（一次 pickFiles 没这个竞态）
    pick(new File([new Uint8Array(17 * 1024)], 'big.txt', { type: 'text/plain' }))
    await waitFor(() =>
      expect(screen.getByTestId('composer-notice')).toHaveTextContent(
        '未附加：big.txt（超过 16KB）'
      )
    )
    expect(screen.queryByTestId('composer-attachment-big.txt')).not.toBeInTheDocument()

    // 小文本仍旧内联（旧行为逐字不变）
    fireEvent.click(screen.getByTestId('composer-send'))
    expect(sentText(onSend)).toBe('【附件】small.txt\n```\n内联的内容\n```')
  })

  it('拖拽与粘贴走同一条路：都变成路径引用', async () => {
    const onSend = mountWithPaths({ 'drop.bin': 'D:\\ws\\bin\\drop.bin' })

    fireEvent.drop(screen.getByTestId('composer'), {
      dataTransfer: {
        files: [new File(['拖进来的'], 'drop.bin', { type: 'application/octet-stream' })]
      }
    })

    await screen.findByTestId('composer-attachment-drop.bin')
    fireEvent.click(screen.getByTestId('composer-send'))
    expect(sentText(onSend)).toBe('【附件】bin/drop.bin')
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

  it('判不出会话工作区（多处并列）时入口照旧在：下拉里说明原因 + 一条去设置的真动作', () => {
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

    // 入口不消失（用户实报"聊天页面里 composer 的权限模式选择按钮不见了"）：还是同一枚 chip
    const chip = screen.getByTestId('composer-permission')
    expect(chip).toHaveTextContent('权限模式')
    expect(chip).toHaveClass('h-8')

    // 下拉里：一句为什么 + 一条去设置的实动作；**不摆**可点的档位（目标都没定下来，切了也不知道切谁）
    fireEvent.keyDown(chip, { key: 'ArrowDown' })
    expect(screen.getByTestId('composer-permission-reason')).toHaveTextContent(
      '会话的工作区还没定下来'
    )
    expect(screen.getByTestId('composer-workspace-settings')).toHaveTextContent('打开工作区设置')
    expect(screen.queryByTestId('composer-permission-ask')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-permission-full')).not.toBeInTheDocument()

    // 那一条是真动作：点了就去工作区设置（与旧链接同一个去处）
    fireEvent.click(screen.getByTestId('composer-workspace-settings'))
    expect(window.location.hash).toBe('#/settings/workspaces')
    window.location.hash = ''
  })

  it('一个工作区都没授权时：原因换成「还没有授权工作区」，入口照旧在', () => {
    installKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
    setup({ threadId: 't1' })

    const chip = screen.getByTestId('composer-permission')
    expect(chip).toHaveTextContent('权限模式')
    fireEvent.keyDown(chip, { key: 'ArrowDown' })
    expect(screen.getByTestId('composer-permission-reason')).toHaveTextContent('还没有授权工作区')
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

  it('round 42 二轮：环与模型名是**两个组件**（互不嵌套、不共用按钮）；点环开的是明细卡', () => {
    setup({ threadId: 't1' })

    const ringButton = screen.getByTestId('composer-context')
    const modelButton = screen.getByTestId('composer-model')
    expect(ringButton).not.toBe(modelButton)
    // 不互相嵌套：任一个都不是另一个的后代
    expect(ringButton.contains(modelButton)).toBe(false)
    expect(modelButton.contains(ringButton)).toBe(false)
    // 环自己的按钮里没有模型名（那是隔壁那个按钮的内容）
    expect(ringButton).not.toHaveTextContent('deepseek-v4-pro')

    fireEvent.keyDown(ringButton, { key: 'ArrowDown' })
    expect(screen.getByTestId('context-menu-card')).toBeInTheDocument()
    // 开的是环的明细卡，不是模型列表
    expect(screen.queryByTestId('composer-model-deepseek')).not.toBeInTheDocument()
  })

  it('round 42 二轮：模型弹层里没有上下文明细区块（拆干净了）', () => {
    setup({ threadId: 't1' })

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })

    expect(screen.getByTestId('composer-model-deepseek')).toBeInTheDocument()
    expect(screen.getByTestId('model-efforts')).toBeInTheDocument()
    expect(screen.getByTestId('model-context')).toBeInTheDocument()
    expect(screen.queryByTestId('context-menu-card')).not.toBeInTheDocument()
    expect(screen.queryByTestId('menu-custom-context-usage')).not.toBeInTheDocument()
    expect(screen.queryByText('上下文已用')).not.toBeInTheDocument()
  })

  it('round 42 二轮：点环就能看全上下文（占用 / 分解 / 缓存 / 阈值）', async () => {
    mountHalfWindow()
    await screen.findByTestId('context-ring')

    fireEvent.keyDown(screen.getByTestId('composer-context'), { key: 'ArrowDown' })

    const card = screen.getByTestId('context-menu-card')
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

  it('round 42 二轮：数据还没到 → 点开的卡里给加载态，不闪一个假的 0%', async () => {
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

    fireEvent.keyDown(screen.getByTestId('composer-context'), { key: 'ArrowDown' })
    const card = screen.getByTestId('context-menu-card')
    expect(screen.getByTestId('context-loading')).toBeInTheDocument()
    expect(card).not.toHaveTextContent('上下文已用')

    release()
    await waitFor(() => expect(card).toHaveTextContent('上下文已用 50%'))
    expect(screen.queryByTestId('context-loading')).not.toBeInTheDocument()
    expect(card).toHaveTextContent('阈值 100%')
    expect(card).not.toHaveTextContent('（已超过）')
  })

  it('round 42 二轮：hover 卡与点开的卡是同源一份（文案逐字一致）', async () => {
    mountHalfWindow()
    const ring = await screen.findByTestId('context-ring')
    await waitFor(() => expect(ring.querySelector('svg')).toHaveAttribute('data-warning', 'true'))

    fireEvent.focus(ring)
    const hoverText = (await screen.findByTestId('context-card')).textContent

    fireEvent.keyDown(screen.getByTestId('composer-context'), { key: 'ArrowDown' })
    await waitFor(() => expect(screen.getByTestId('context-menu-card').textContent).toBe(hoverText))
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
    // 上下文环的取数分母来自当前模型：没有模型就没有环（不然是一个没有意义的百分比）
    expect(screen.queryByTestId('composer-context')).not.toBeInTheDocument()
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

/**
 * round 85（用户实报 016 问题三：「/」菜单里没有"进入规划模式"）。
 *
 * 命令浮窗里多一条模式入口，选中走的是 ＋ 菜单那条**同一个实现**（Composer 的 `mode.plan.onSelect`
 * = ChatPage 的 enterPlan）；不传 mode（未就绪 / 已在规划里）时这条不出现。
 */
describe('round 85 · / 命令浮窗里的「进入规划模式」', () => {
  it('键入 /：默认高亮仍是「压缩上下文」（命令分区首条），模式入口排在它后面', () => {
    const onCompact = vi.fn()
    const onSelect = vi.fn()
    setup({ onCompact, mode: { plan: { onSelect }, tasks: null } })
    const input = typeAt('/')

    expect(screen.getByTestId('suggest-command:compact')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('suggest-command:plan')).toHaveTextContent('进入规划模式')

    // 习惯性打 `/` 再回车 = 压缩上下文（不是被切进规划模式）
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCompact).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
    expect(screen.getByTestId('composer-suggest')).not.toHaveAttribute('data-open')
  })

  it('下移到模式入口再回车 → mode.plan.onSelect（清掉触发词、浮窗收起）', () => {
    const onSelect = vi.fn()
    setup({ mode: { plan: { onSelect }, tasks: null } })
    const input = typeAt('/')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByTestId('suggest-command:plan')).toHaveAttribute('data-active', 'true')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue('')
    expect(screen.getByTestId('composer-suggest')).not.toHaveAttribute('data-open')
  })

  it('正在跑 / 等审批（plan.disabled）：行可见但禁用，停在它上面回车不触发', () => {
    const onSelect = vi.fn()
    setup({ mode: { plan: { onSelect, disabled: true }, tasks: null } })
    const input = typeAt('/')

    const row = screen.getByTestId('suggest-command:plan')
    expect(row).toBeDisabled()
    // 下移到这条禁用行：回车什么都不发生（触发词也留着）
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelect).not.toHaveBeenCalled()
    expect(input).toHaveValue('/')
    expect(screen.getByTestId('composer-suggest')).toHaveAttribute('data-open', 'true')
  })

  it('没有 mode（实例未就绪 / 已在规划里）：这条不出现，命令分区只有压缩', () => {
    setup()
    typeAt('/')

    expect(screen.queryByTestId('suggest-command:plan')).not.toBeInTheDocument()
    expect(screen.getByTestId('suggest-command:compact')).toBeInTheDocument()
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

  it('手动「刷新模型信息」：**不看 TTL**，缓存新鲜也再探一次（手动可重试）', async () => {
    const bridge = mountChip(probedNow())

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    await tick()
    // 自动那条路：缓存新鲜 → 不问
    expect(bridge.probeModels).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('model-refresh-meta'))

    await waitFor(() => expect(bridge.probeModels).toHaveBeenCalledWith('deepseek'))
    expect(bridge.probeModels).toHaveBeenCalledTimes(1)
  })

  it('手动刷新的反馈：拿到新时间戳 → "已刷新"', async () => {
    const bridge = mountChip(probedNow())
    bridge.probeModels.mockResolvedValueOnce({
      ...defaultSettings(),
      providers: [FLASH],
      probedModels: {
        'deepseek:deepseek-flash': {
          contextWindow: 1_048_576,
          fetchedAt: new Date(Date.now() + 60_000).toISOString()
        }
      }
    })

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-refresh-meta'))

    expect(await screen.findByTestId('composer-notice')).toHaveTextContent('模型信息已刷新')
  })

  it('手动刷新没问出新时间戳（端点不可达 / 没给元数据）→ 如实说"没能刷新"，不假装成功', async () => {
    const bridge = mountChip(probedNow())

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('model-refresh-meta'))

    // 默认 stub 回吐的设置里 fetchedAt 没变 = 这一趟什么也没问出来
    expect(await screen.findByTestId('composer-notice')).toHaveTextContent('没能刷新')
    expect(bridge.probeModels).toHaveBeenCalledWith('deepseek')
  })
})

describe('模块 2 · 图片与 PDF（视觉模型区分）', () => {
  /** 装一个"有默认 provider"的环境：模型名 + **探测结论**（round 48，没有手动开关）决定视觉能力 */
  function mount(
    model: string,
    vision = false
  ): { onSend: ReturnType<typeof vi.fn>; bridge: KyclawBridgeStubs } {
    const initial: AppSettings = {
      ...settingsWithProvider(model),
      probedModels: vision ? { [`p1:${model}`]: { vision: true } } : {}
    }
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
        '已自动检测：当前模型不支持看图'
      )
    )
    expect(screen.queryByTestId('composer-attachment-shot.png')).not.toBeInTheDocument()
  })

  it('vision=true（探测结论）→ 收下并给缩略图；发送时图片随消息真发（file part）', async () => {
    const { onSend } = mount('deepseek-chat', true)

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
    mount('deepseek-chat', true)
    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    await waitFor(() => expect(screen.getByTestId('composer-model-p1')).toHaveTextContent('看图'))

    cleanup()
    mount('deepseek-chat')
    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    expect(screen.getByTestId('composer-model-p1')).not.toHaveTextContent('看图')
  })
})

describe('round 42 · 添加到上下文（文件树 / 预览选中 → 附件条）', () => {
  let bridge: KyclawBridgeStubs

  /** 当前环境：一个能看图的模型（探测结论说了算；图片的收/拒要看它） */
  function mount(vision = true): ReturnType<typeof vi.fn> {
    const initial: AppSettings = {
      ...settingsWithProvider('deepseek-chat'),
      probedModels: vision ? { 'p1:deepseek-chat': { vision: true } } : {}
    }
    bridge = installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    const { onSend } = setup({ threadId: 't1' })
    return onSend
  }

  beforeEach(() => {
    bridge = installKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
  })

  afterEach(() => {
    clearKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  it('文件事件 → 附件 chip；发送时内容进【附件】围栏（走文本通道）', async () => {
    const onSend = mount()
    bridge.workbench.readFile.mockResolvedValue({
      kind: 'text',
      text: 'export const a = 1\n',
      size: 19,
      truncated: false
    })

    publishContextItem({
      source: 'file',
      threadId: 't1',
      relative: 'src/notes.txt',
      name: 'notes.txt'
    })

    const chip = await screen.findByTestId('composer-attachment-notes.txt')
    expect(chip).toHaveTextContent('19 B')
    expect(bridge.workbench.readFile).toHaveBeenCalledWith('t1', 'src/notes.txt')

    type('看这个')
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    // round 42 二轮：整文件也带**相对路径**（模型看得到"这是哪个文件"，不再只有裸文件名）
    expect(sentText(onSend)).toBe('看这个\n\n【附件】src/notes.txt\n```\nexport const a = 1\n```')
    expect(screen.queryByTestId('composer-attachment-notes.txt')).not.toBeInTheDocument()
  })

  it('摘选事件 → 引用卡（路径 + 行号 + 摘要 + 字数），不读文件', async () => {
    mount()

    publishContextItem({
      source: 'selection',
      threadId: 't1',
      relative: 'src/app.ts',
      name: 'app.ts 摘选',
      text: 'const a = 1',
      lines: { start: 3, end: 8 }
    })

    const card = await screen.findByTestId('composer-attachment-app.ts 摘选')
    expect(card).toHaveAttribute('data-quote', 'true')
    expect(card).toHaveTextContent('引用')
    expect(card).toHaveTextContent('src/app.ts')
    expect(screen.getByTestId('composer-quote-lines')).toHaveTextContent('第 3–8 行')
    expect(screen.getByTestId('composer-quote-summary')).toHaveTextContent('const a = 1')
    expect(screen.getByTestId('composer-quote-count')).toHaveTextContent('共 11 字')
    expect(bridge.workbench.readFile).not.toHaveBeenCalled()
    expect(bridge.workbench.readBytes).not.toHaveBeenCalled()

    // 可删除
    fireEvent.click(screen.getByLabelText('移除 app.ts 摘选'))
    expect(screen.queryByTestId('composer-attachment-app.ts 摘选')).not.toBeInTheDocument()
  })

  it('大段选择：卡上只铺截断摘要（注明总字数），**传出去的仍是完整内容**', async () => {
    const onSend = mount()
    const text = Array.from({ length: 1000 }, (_value, index) => `第${index}行内容`).join('\n')

    publishContextItem({
      source: 'selection',
      threadId: 't1',
      relative: 'src/app.ts',
      name: 'app.ts 摘选',
      text,
      lines: { start: 1, end: 1000 }
    })

    const card = await screen.findByTestId('composer-attachment-app.ts 摘选')
    const summary = screen.getByTestId('composer-quote-summary')
    // 卡上不铺原文：摘要只有 60 个码点 + 省略号
    expect([...summary.textContent!.replace(/…$/, '')].length).toBeLessThanOrEqual(60)
    expect(summary.textContent!.endsWith('…')).toBe(true)
    expect(screen.getByTestId('composer-quote-count')).toHaveTextContent(
      `共 ${[...text].length} 字`
    )
    expect(card.textContent).not.toContain('第999行内容')

    // 传出去的是整段（带路径 + 行号）
    fireEvent.click(screen.getByTestId('composer-send'))
    const sent = sentText(onSend)
    expect(sent.startsWith('【引用】文件：src/app.ts（第 1–1000 行）\n```\n')).toBe(true)
    expect(sent).toContain('第999行内容')
    expect(sent.endsWith('\n```')).toBe(true)
  })

  describe('0.1.3 / 013 返工 · 回复选段作为草稿附件', () => {
    const LONG = Array.from({ length: 80 }, (_value, index) => `第${index}行内容`).join('\n')

    function publishQuote(text = LONG, messageId = 'a1'): void {
      act(() => {
        publishDraft({ threadId: 't1', quote: { text, messageId } })
      })
    }

    it('长选区只进附件卡：输入框零占位、摘要截断、带摘要图标与「发送含原文」', () => {
      setup({ threadId: 't1' })
      publishQuote()

      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      expect(input.value).toBe('')
      expect(input).toHaveClass('min-h-(--composer-input-min-height)')

      const card = screen.getByTestId('composer-quote-card')
      expect(card).toHaveAttribute('data-quote', 'true')
      expect(card.querySelector('.lucide-text-quote')).not.toBeNull()
      expect(card).toHaveAttribute('title', 'AI 回复（消息 a1）')

      const summary = screen.getByTestId('composer-quote-summary')
      expect([...summary.textContent!.replace(/…$/, '')].length).toBeLessThanOrEqual(60)
      expect(summary.textContent!.endsWith('…')).toBe(true)
      expect(card.textContent).not.toContain('第79行内容')

      expect(screen.getByTestId('composer-quote-count')).toHaveTextContent(
        `共 ${[...LONG].length} 字`
      )
      expect(screen.getByTestId('composer-quote-send-mode')).toHaveTextContent('发送含原文')
      // 折叠态不铺原文：完整内容只在展开后的 textarea 里
      expect(screen.queryByTestId('composer-quote-original')).toBeNull()
    })

    it('展开查看 / 编辑原文：输入框仍为空；发送带编辑后的完整原文，不自动发送', () => {
      const { onSend } = setup({ threadId: 't1' })
      publishQuote()
      expect(onSend).not.toHaveBeenCalled()

      fireEvent.click(screen.getByTestId('composer-quote-toggle'))
      expect(screen.getByTestId('composer-quote-toggle')).toHaveAttribute('aria-expanded', 'true')
      const original = screen.getByTestId('composer-quote-original') as HTMLTextAreaElement
      expect(original.value).toBe(LONG)

      fireEvent.change(original, { target: { value: '编辑后的原文' } })
      expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('')
      expect(onSend).not.toHaveBeenCalled()

      fireEvent.click(screen.getByTestId('composer-send'))
      expect(onSend).toHaveBeenCalledTimes(1)
      expect(sentText(onSend)).toBe('【引用】回复：回复选段\n```\n编辑后的原文\n```')
      expect(screen.queryByTestId('composer-quote-card')).toBeNull()
    })

    it('移除：只删卡与载荷；输入框里的草稿一个字不动，也不发送', () => {
      const { onSend } = setup({ threadId: 't1' })
      type('我的批注')
      publishQuote()

      const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
      expect(input.value).toBe('我的批注')
      fireEvent.click(screen.getByLabelText('移除 回复选段'))

      expect(screen.queryByTestId('composer-quote-card')).toBeNull()
      expect(input.value).toBe('我的批注')
      expect(onSend).not.toHaveBeenCalled()
    })

    it('已有草稿 / 已有附件：连续引用按顺序追加，输入框不被覆盖', () => {
      const { onSend } = setup({ threadId: 't1' })
      type('我的批注')
      publishQuote('第一段', 'a1')
      publishQuote('第二段', 'a2')

      expect((screen.getByTestId('composer-input') as HTMLTextAreaElement).value).toBe('我的批注')
      expect(screen.getAllByTestId('composer-quote-card')).toHaveLength(2)

      fireEvent.click(screen.getByTestId('composer-send'))
      expect(sentText(onSend)).toBe(
        '我的批注\n\n【引用】回复：回复选段\n```\n第一段\n```\n\n【引用】回复：回复选段\n```\n第二段\n```'
      )
    })
  })

  it('摘选超上限：按字节截断并给人话；定位不到行号时**不写位置**（不瞎编）', async () => {
    mount()

    publishContextItem({
      source: 'selection',
      threadId: 't1',
      relative: 'src/app.ts',
      name: 'app.ts 摘选',
      text: '中'.repeat(20 * 1024)
    })

    await waitFor(() =>
      expect(screen.getByTestId('composer-notice')).toHaveTextContent('已截断：app.ts 摘选')
    )
    const card = screen.getByTestId('composer-attachment-app.ts 摘选')
    // 没有行号就不画那半截（位置是"算得出才有"的数据）
    expect(screen.queryByTestId('composer-quote-lines')).not.toBeInTheDocument()
    expect(card).toHaveTextContent('src/app.ts')
  })

  it('别的会话的事件、以及自己没有会话时：一律丢掉（不猜、不错挂）', async () => {
    mount()
    publishContextItem({ source: 'file', threadId: 'other', relative: 'a.txt', name: 'a.txt' })
    await tick()
    expect(screen.queryByTestId('composer-pending')).not.toBeInTheDocument()
    expect(bridge.workbench.readFile).not.toHaveBeenCalled()
  })

  it('没有会话（threadId 为空）：不订阅，事件静默丢弃', async () => {
    setup()
    publishContextItem({ source: 'file', threadId: 't1', relative: 'a.txt', name: 'a.txt' })
    await tick()
    expect(screen.queryByTestId('composer-pending')).not.toBeInTheDocument()
    expect(bridge.workbench.readFile).not.toHaveBeenCalled()
  })

  it('二进制 / 超限（round 53）：不再拒收 —— 退回**相对路径引用**（chip 照常进附件条）', async () => {
    const onSend = mount()
    bridge.workbench.readFile.mockResolvedValue({ kind: 'binary', size: 2048 })

    publishContextItem({ source: 'file', threadId: 't1', relative: 'logo.ico', name: 'logo.ico' })

    const chip = await screen.findByTestId('composer-attachment-logo.ico')
    expect(chip).toHaveTextContent('logo.ico')
    expect(chip).toHaveAttribute('title', 'logo.ico')
    expect(screen.queryByTestId('composer-notice')).not.toBeInTheDocument()

    // 载荷是路径引用：只有抬头一行（没有内容围栏，模型按路径自己读）
    fireEvent.click(screen.getByTestId('composer-send'))
    expect(sentText(onSend)).toBe('【附件】logo.ico')
  })

  it('图片：vision=true 收下（缩略图 + 随消息真发）；vision=false 人话拒收', async () => {
    const onSend = mount()
    bridge.workbench.readBytes.mockResolvedValue({
      kind: 'bytes',
      format: 'image-png',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      size: 4
    })

    publishContextItem({ source: 'file', threadId: 't1', relative: '图片.png', name: '图片.png' })

    await screen.findByTestId('composer-attachment-thumb-图片.png')
    fireEvent.click(screen.getByTestId('composer-send'))
    const files = sentFiles(onSend) as Array<{ mediaType: string; url: string; filename?: string }>
    expect(files[0].filename).toBe('图片.png')
    expect(files[0].url.startsWith('data:image/png;base64,')).toBe(true)

    cleanup()
    bridge.workbench.readBytes.mockClear()
    mount(false)
    publishContextItem({ source: 'file', threadId: 't1', relative: '图片.png', name: '图片.png' })

    await waitFor(() =>
      expect(screen.getByTestId('composer-notice')).toHaveTextContent(
        '未附加：图片.png（已自动检测：当前模型不支持看图'
      )
    )
    // 视觉不看，连字节都不去拉
    expect(bridge.workbench.readBytes).not.toHaveBeenCalled()
  })

  it('round 62：视觉结论中途回来（vision false → true）之后，事件照收且按最新结论判档', async () => {
    mount(false) // 当前模型的探测结论：不看图
    // 探测结论回来 → 设置更新（组件重渲染）。订阅**不该跟着重挂**：这条通道是同步派发、
    // 没有缓冲（见 composer-inbox），重挂窗口里发的事件两头都不在。
    await act(async () => {
      useSettingsStore.setState({
        settings: {
          ...settingsWithProvider('deepseek-chat'),
          probedModels: { 'p1:deepseek-chat': { vision: true } }
        }
      })
    })
    bridge.workbench.readBytes.mockResolvedValue({
      kind: 'bytes',
      format: 'image-png',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      size: 4
    })

    publishContextItem({ source: 'file', threadId: 't1', relative: '图片.png', name: '图片.png' })

    // 订阅还在（事件收下）且用的是**最新**结论（vision=true → 真去取字节、成缩略图）
    await screen.findByTestId('composer-attachment-thumb-图片.png')
    expect(bridge.workbench.readBytes).toHaveBeenCalledWith('t1', '图片.png')
    expect(screen.queryByTestId('composer-notice')).not.toBeInTheDocument()
  })

  it('PDF：走字节通道 + 主进程抽取，chip 上印页数', async () => {
    mount()
    bridge.workbench.readBytes.mockResolvedValue({
      kind: 'bytes',
      format: 'pdf',
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      size: 4
    })
    bridge.attachments.extractPdf.mockResolvedValue({
      ok: true,
      pages: 3,
      truncated: false,
      text: '【第 1 页】\n内容'
    })

    publishContextItem({ source: 'file', threadId: 't1', relative: '报告.pdf', name: '报告.pdf' })

    const chip = await screen.findByTestId('composer-attachment-报告.pdf')
    expect(chip).toHaveTextContent('3 页')
    expect(bridge.attachments.extractPdf).toHaveBeenCalled()
  })

  it('半路换会话：晚到的解析结果不挂到新会话的附件条上', async () => {
    let release: () => void = () => {}
    bridge.workbench.readFile.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ kind: 'text', text: '迟到的内容', size: 15, truncated: false })
      })
    )
    const props = { onSend: vi.fn(), onStop: vi.fn() }
    const view = render(<Composer threadId="t1" {...props} />)

    publishContextItem({ source: 'file', threadId: 't1', relative: 'a.txt', name: 'a.txt' })
    view.rerender(<Composer threadId="t2" {...props} />)
    release()
    await tick()

    expect(screen.queryByTestId('composer-pending')).not.toBeInTheDocument()
  })
})

/**
 * round 66 · 输入卡里**不嵌**「选择项目」（用户口径："放到对话框上面，不要嵌入到里面"）。
 * 卡片的结构回到纯输入件：附件行 → 输入区 → notice → 工具条（+ 卡片外的上下两行由对话页挂，
 * 见 welcome-hero.spec 的竖排顺序用例）。这里钉的是"没嵌进去"：
 *   - 卡片子树里没有 `composer-project` / `composer-project-row`；
 *   - 渲染 Composer 时（哪怕给了 threadId）也不会凭空多出这一枚 —— 它的宿主是对话页，不是卡片。
 */
describe('round 66 · 卡片里不嵌「选择项目」', () => {
  it('给了 threadId 也没有项目行 / 项目胶囊（宿主是对话页，不是卡片）', () => {
    setup({ threadId: 't1' })

    const composer = screen.getByTestId('composer')
    expect(within(composer).queryByTestId('composer-project')).toBeNull()
    expect(within(composer).queryByTestId('composer-project-row')).toBeNull()
    expect(screen.queryByTestId('composer-project')).toBeNull()
    expect(screen.queryByTestId('composer-project-row')).toBeNull()
  })

  it('卡片里第一件流内内容仍是附件行（结构回到纯输入件，附件行照常挂在卡内）', async () => {
    setup({ threadId: 't1' })

    fireEvent.change(screen.getByTestId('composer-file-input'), {
      target: { files: [new File(['内容'], 'note.txt', { type: 'text/plain' })] }
    })
    const pending = await screen.findByTestId('composer-pending')

    // 附件行没被挤走、也没被谁包起来：还在卡片里、在输入区之前
    expect(screen.getByTestId('composer').contains(pending)).toBe(true)
    expect(
      (pending.compareDocumentPosition(screen.getByTestId('composer-input')) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0
    ).toBe(true)
  })
})

/**
 * round 64 · 输入区默认高度（用户实拍："默认对话输入框高度偏低，可以调整高一点"、
 * "空态尤其明显"）。
 *   - 常态：最小高 48 → **56**（单行时给一行字留出上下余量）；
 *   - 初始页（空会话）：再高一档 **72** —— 那一屏没有消息，输入框是主角；
 *   - 两档都只在语义层 token 里写 px，组件只引用语义名；换档走 --motion-main 过渡（不硬切）。
 * token 值直接从语义层源码读（jsdom 不做布局，断言"真的更高"只能看声明）。
 */
describe('round 64 · 输入区默认高度（常态抬高 + 空态再高一档）', () => {
  /** 读语义层源码：路径经参数传进来（Vite 不会把 new URL(..., import.meta.url) 静态改写成资源地址） */
  function readSource(relativePath: string): string {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8')
  }
  const SEMANTIC_CSS = readSource('../../../styles/tokens/semantic.css')

  function pxTokenOf(name: string): number {
    const match = new RegExp(`--${name}:\\s*(\\d+)px`).exec(SEMANTIC_CSS)
    if (match === null) throw new Error(`语义层没有 ${name}`)
    return Number(match[1])
  }

  it('常态最小高走 --composer-input-min-height，且比原来那档（48）更高', () => {
    setup()

    const input = screen.getByTestId('composer-input')
    expect(input).toHaveClass('min-h-(--composer-input-min-height)')
    expect(input).not.toHaveClass('min-h-(--composer-input-min-height-hero)')
    expect(pxTokenOf('composer-input-min-height')).toBeGreaterThan(48)
  })

  it('初始页（hero）：换 --composer-input-min-height-hero 一档，且更高；换档有过渡（不硬切）', () => {
    setup({ hero: true })

    const input = screen.getByTestId('composer-input')
    expect(input).toHaveClass('min-h-(--composer-input-min-height-hero)')
    expect(input).not.toHaveClass('min-h-(--composer-input-min-height)')
    expect(input).toHaveClass('transition-[min-height]')
    expect(pxTokenOf('composer-input-min-height-hero')).toBeGreaterThan(
      pxTokenOf('composer-input-min-height')
    )
    // 封顶没变：长内容照旧到 max 之后内部滚动
    expect(input).toHaveClass('max-h-(--composer-input-max-height)')
    expect(input).toHaveClass('overflow-y-auto')
  })

  it('两档都是语义 token（组件里不出现写死的高度 px）', () => {
    const source = readSource('../Composer.tsx')

    expect(source).not.toMatch(/minHeight:\s*['"]?\d+px/)
    expect(source).toContain('min-h-(--composer-input-min-height)')
    expect(source).toContain('min-h-(--composer-input-min-height-hero)')
  })
})

describe('用户反馈 001/002/004 · 模型菜单 = 通道 × 模型', () => {
  const MULTI = {
    id: 'deepseek',
    type: 'openai-compatible' as const,
    baseUrl: 'https://api.deepseek.com',
    name: '公司网关',
    model: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    isDefault: true
  }
  const OTHER = {
    id: 'other',
    type: 'openai-compatible' as const,
    baseUrl: 'https://example.com',
    model: 'gpt-4o-mini',
    isDefault: false
  }

  let bridge: KyclawBridgeStubs

  function mount(providers: readonly unknown[], extra: Partial<AppSettings> = {}): void {
    const initial = { ...defaultSettings(), ...extra, providers } as AppSettings
    bridge = installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    setup()
  }

  beforeEach(() => {
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  afterEach(() => {
    clearKyclawBridge()
    useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  })

  it('001：一条通道两个模型 → 两条条目；选另一个 = 写回该通道的 model + isDefault 挪到它', async () => {
    mount([MULTI])

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    // 当前模型沿用旧 testid，另一个按模型名区分
    expect(screen.getByTestId('composer-model-deepseek')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('composer-model-deepseek-deepseek-v4-pro')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('composer-model-deepseek-deepseek-v4-pro'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        providers: [
          // 001：写回的是该通道的 `model`（当前选中的那个），注册清单原样不动
          { ...MULTI, model: 'deepseek-v4-pro', isDefault: true }
        ]
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('composer-model')).toHaveTextContent('deepseek-v4-pro')
    )
    // 落盘回来的设置里 isDefault 只在一条上
    expect(
      useSettingsStore.getState().settings.providers.filter((provider) => provider.isDefault)
    ).toHaveLength(1)
  })

  it('001：跨通道选模型也把默认挪过去（既有字段就是选择器，没有第二个"当前模型"）', async () => {
    mount([MULTI, OTHER])

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('composer-model-other'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        providers: [
          { ...MULTI, isDefault: false },
          { ...OTHER, isDefault: true }
        ]
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('composer-model')).toHaveTextContent('gpt-4o-mini')
    )
  })

  it('002：有歧义时（多通道）每条右侧标出渠道名（手填的渠道名优先）', () => {
    mount([MULTI, OTHER])

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })

    expect(screen.getByTestId('composer-model-deepseek')).toHaveTextContent('公司网关')
    // 没填渠道名的一条显示 id（回落口径见 providerLabel）
    expect(screen.getByTestId('composer-model-other')).toHaveTextContent('other')
  })

  it('004：模型名按展示名显示——但落盘的 model 仍是 API 标识原文', () => {
    mount([{ ...MULTI, model: 'deepseek-v4-pro', models: undefined }], {
      modelOverrides: { 'deepseek:deepseek-v4-pro': { displayName: '深度思考模型' } }
    })

    expect(screen.getByTestId('composer-model')).toHaveTextContent('深度思考模型')

    fireEvent.keyDown(screen.getByTestId('composer-model'), { key: 'ArrowDown' })
    expect(screen.getByTestId('composer-model-deepseek')).toHaveTextContent('深度思考模型')
    // 选它（已经是当前这一条 → 空操作）：展示名不参与任何写回
    fireEvent.click(screen.getByTestId('composer-model-deepseek'))
    expect(bridge.update).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().settings.providers[0]?.model, '展示名不进 model').toBe(
      'deepseek-v4-pro'
    )
  })
})

/**
 * P1b 配方 3：Composer 自绘 caret。
 * 真机 Chromium 有 Range.getBoundingClientRect（jsdom 没有）——这里 mock 出一个非零矩形，
 * 让"镜像层测量 → 绝对定位 2px 竖条"这条链路在单测里也能走通；几何数值不是本组断言重点。
 */
describe('P1b · Composer 自绘 caret', () => {
  beforeEach(() => {
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          x: 16,
          y: 12,
          left: 16,
          top: 12,
          right: 18,
          bottom: 34,
          width: 2,
          height: 22,
          toJSON: () => ({})
        }) as DOMRect
    })
  })

  afterEach(() => {
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  })

  it('聚焦 + 有内容 → 自绘 caret，原生 caret 走 custom 档', async () => {
    setup()
    const input = screen.getByTestId('composer-input')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '你好' } })

    const caret = await screen.findByTestId('composer-caret')
    expect(caret).toHaveClass('composer-caret')
    expect(caret).toHaveStyle({ height: '22px' })
    expect(input).toHaveAttribute('data-caret', 'custom')
    expect(input).toHaveClass('composer-caret-input')
  })

  it('IME composition 期间回原生 caret、自绘隐藏；结束后恢复（不吞字/不跳位）', async () => {
    setup()
    const input = screen.getByTestId('composer-input')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'ni' } })
    await screen.findByTestId('composer-caret')

    fireEvent.compositionStart(input)
    expect(input).toHaveAttribute('data-caret', 'native')
    expect(input).toHaveAttribute('data-composing', 'true')
    expect(screen.queryByTestId('composer-caret')).not.toBeInTheDocument()

    fireEvent.compositionEnd(input)
    expect(input).toHaveAttribute('data-caret', 'custom')
    expect(input).not.toHaveAttribute('data-composing')
    expect(await screen.findByTestId('composer-caret')).toBeInTheDocument()
  })

  it('输入中 data-typing=true 常亮；400ms 无输入后恢复闪烁', async () => {
    setup()
    const input = screen.getByTestId('composer-input')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'a' } })
    const caret = await screen.findByTestId('composer-caret')
    expect(caret).toHaveAttribute('data-typing', 'true')

    await waitFor(
      () => expect(screen.getByTestId('composer-caret')).not.toHaveAttribute('data-typing'),
      {
        timeout: 2000
      }
    )
  })

  it('失焦隐藏自绘 caret、清 data-composing', async () => {
    setup()
    const input = screen.getByTestId('composer-input')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'x' } })
    await screen.findByTestId('composer-caret')

    fireEvent.blur(input)
    expect(screen.queryByTestId('composer-caret')).not.toBeInTheDocument()
    expect(input).toHaveAttribute('data-caret', 'native')
  })
})
