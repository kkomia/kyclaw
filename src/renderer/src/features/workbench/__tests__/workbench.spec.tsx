import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useShellStore } from '@renderer/lib/shell-store'
import { useProjectsStore } from '@renderer/features/projects/projects-store'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { WorkPanel } from '@renderer/components/shell/WorkPanel'
import { tick } from '@renderer/components/ui/__tests__/tick'
import { useWorkbenchStore } from '../workbench-store'
import { Workbench } from '../Workbench'
import { setupWorkbench, teardownWorkbench, type Bed } from './bed'

/**
 * 工作台（round 39 起是标签页模型）：标签的建 / 切 / 关 + 保活语义 + 变根重置 + 头部图标簇。
 * 面板用 `data-testid="workbench-panel"` + `data-kind` / `data-active` / `inert` 表达可见与可交互
 * （隐藏靠 invisible + opacity 过渡，不卸载）；xterm 与 FitAddon 用替身顶掉（真 PTY 由 Electron 探针验）。
 */
vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    write = vi.fn()
    dispose = vi.fn()
    focus = vi.fn()
    reset = vi.fn()
    open = vi.fn()
    loadAddon = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    fit = vi.fn()
  }
  return { FitAddon }
})

let bed: Bed

beforeEach(() => {
  bed = setupWorkbench()
})

afterEach(() => {
  teardownWorkbench()
})

/** 打开 ＋ 菜单并选一种工具（Radix 菜单在 jsdom 里走键盘：ArrowDown 开、聚焦后 Enter 选） */
async function newTab(kind: 'browser' | 'files' | 'git' | 'terminal'): Promise<void> {
  fireEvent.keyDown(screen.getByTestId('workbench-new-tab'), { key: 'ArrowDown' })
  const item = screen.getByTestId(`workbench-new-${kind}`)
  item.focus()
  fireEvent.keyDown(item, { key: 'Enter' })
  await tick()
}

function panelOf(kind: string): HTMLElement {
  const panel = screen
    .getAllByTestId('workbench-panel')
    .find((element) => element.dataset.kind === kind)
  if (panel === undefined) throw new Error(`没有渲染出 ${kind} 面板`)
  return panel
}

function kinds(): Array<string | undefined> {
  return screen.queryAllByTestId('workbench-panel').map((element) => element.dataset.kind)
}

/** 关掉唯一那个「文件」标签 → 落到空态（render 之后调） */
function toEmpty(): void {
  fireEvent.click(screen.getByRole('button', { name: '关闭 工作区' }))
}

/** 某行的键帽文本（按显示顺序） */
function keyCapsOf(kind: string): string[] {
  const row = screen.getByTestId(`workbench-empty-action-${kind}`)
  return Array.from(row.querySelectorAll('kbd')).map((node) => node.textContent ?? '')
}

describe('Workbench 标签页', () => {
  it('默认：一个「文件」标签（标题 = 根目录名），只挂着它', async () => {
    render(<Workbench />)

    expect(screen.getAllByRole('tab')).toHaveLength(1)
    const files = screen.getByRole('tab', { name: '工作区' })
    expect(files).toHaveAttribute('aria-selected', 'true')
    expect(panelOf('files')).toHaveAttribute('data-active', 'true')
    // 没建过的工具不挂载（各工具的 IPC 订阅因此只在用时建立）
    expect(kinds()).toEqual(['files'])

    await waitFor(() => expect(bed.bridge.workbench.listDir).toHaveBeenCalledWith('thread-1', ''))
  })

  it('归属还在写（settling）：三件按根开工的工具先不挂（不列目录、不起 PTY）；落定后才挂（round 49 回归）', async () => {
    useProjectsStore.setState({ pending: { 'thread-1': true } })
    render(<Workbench />)
    await newTab('terminal')

    // 主进程此刻还按兜底根解析：先列目录 / 先起 PTY 都会落在别的文件夹上，而且不会自己重来
    expect(screen.getAllByTestId('workbench-settling')).toHaveLength(2)
    expect(bed.bridge.workbench.listDir).not.toHaveBeenCalled()
    expect(bed.bridge.terminal.start).not.toHaveBeenCalled()

    // 回执落地（主进程认这条映射了）：真工具挂上，这次才开工
    act(() => useProjectsStore.setState({ pending: {} }))

    await waitFor(() => expect(bed.bridge.workbench.listDir).toHaveBeenCalledWith('thread-1', ''))
    await waitFor(() => expect(bed.bridge.terminal.start).toHaveBeenCalled())
    expect(screen.queryByTestId('workbench-settling')).not.toBeInTheDocument()
  })

  it('新建终端：新开一个标签并激活，文件标签不卸载（只隐藏 + inert）', async () => {
    render(<Workbench />)

    await newTab('terminal')

    expect(useWorkbenchStore.getState().tabs.map((tab) => tab.kind)).toEqual(['files', 'terminal'])
    expect(screen.getByRole('tab', { name: '终端' })).toHaveAttribute('aria-selected', 'true')
    expect(panelOf('terminal')).toHaveAttribute('data-active', 'true')
    expect(panelOf('terminal')).not.toHaveAttribute('inert')

    const files = panelOf('files')
    expect(files).toHaveAttribute('data-active', 'false')
    expect(files).toHaveAttribute('inert')
    expect(files).toHaveClass('invisible', 'opacity-0')
    // 保活的证据：切走之后终端会话还开着（挂载即起 PTY，卸载才 dispose）
    await waitFor(() => expect(bed.bridge.terminal.start).toHaveBeenCalled())
    expect(bed.bridge.terminal.dispose).not.toHaveBeenCalled()
  })

  it('浏览器/终端每次新开；文件/Git 已开就激活那一个（不重复开）', async () => {
    render(<Workbench />)

    await newTab('browser')
    await newTab('browser')
    await newTab('terminal')
    expect(useWorkbenchStore.getState().tabs.map((tab) => tab.kind)).toEqual([
      'files',
      'browser',
      'browser',
      'terminal'
    ])

    await newTab('git')
    await newTab('git')
    const tabs = useWorkbenchStore.getState().tabs
    expect(tabs.filter((tab) => tab.kind === 'git')).toHaveLength(1)
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      '工作区',
      '浏览器',
      '浏览器',
      '终端',
      '改动'
    ])

    // 点已有的标签：切过去（还是同一个面板，不重挂）
    fireEvent.click(screen.getAllByRole('tab', { name: '浏览器' })[0]!)
    expect(screen.getAllByRole('tab')[1]).toHaveAttribute('aria-selected', 'true')
    expect(useWorkbenchStore.getState().tabs).toHaveLength(5)
  })

  it('关标签：卸载（终端随之 dispose 会话）；关掉当前标签接到左边', async () => {
    render(<Workbench />)
    await newTab('terminal')
    await waitFor(() => expect(bed.bridge.terminal.start).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: '关闭 终端' }))

    expect(kinds()).toEqual(['files'])
    expect(bed.bridge.terminal.dispose).toHaveBeenCalledWith('term-1')
    expect(useWorkbenchStore.getState().activeTabId).toBe(useWorkbenchStore.getState().tabs[0]?.id)
    expect(panelOf('files')).toHaveAttribute('data-active', 'true')
  })

  it('全关光：空态给居中四行动作（浏览器 / 文件 / 改动 / 终端），头部 ＋ 保留', async () => {
    render(<Workbench />)

    fireEvent.click(screen.getByRole('button', { name: '关闭 工作区' }))

    expect(screen.getByTestId('workbench-empty')).toBeInTheDocument()
    expect(kinds()).toEqual([])
    // 头部还在（标签列表空、图标簇照常给新建入口）；底部那个 ＋ 已撤（改由动作列表承担）
    expect(screen.getByRole('tablist')).toBeInTheDocument()
    expect(screen.getByTestId('workbench-new-tab')).toBeInTheDocument()
    expect(screen.queryByTestId('workbench-new-tab-empty')).not.toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('workbench-new-tab'), { key: 'ArrowDown' })
    const item = screen.getByTestId('workbench-new-files')
    item.focus()
    fireEvent.keyDown(item, { key: 'Enter' })
    await tick()

    expect(screen.queryByTestId('workbench-empty')).not.toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  it('浏览器标签标题：页面标题优先，没有就用网址主机名（拿不到才是「浏览器」）', async () => {
    const { container } = render(<Workbench />)
    await newTab('browser')

    expect(screen.getByRole('tab', { name: '浏览器' })).toBeInTheDocument()
    const webview = container.querySelector('webview')
    if (webview === null) throw new Error('没有渲染出 webview')

    const navigate = (type: string, detail: Record<string, unknown>): void => {
      const event = new Event(type)
      Object.assign(event, detail)
      // 事件来自 webview（React 管不到的客人），state 更新要手动冲进 DOM
      act(() => {
        webview.dispatchEvent(event)
      })
    }

    navigate('did-navigate', { url: 'https://example.com/a/b' })
    expect(screen.getByRole('tab', { name: 'example.com' })).toBeInTheDocument()

    navigate('page-title-updated', { title: '示例站点' })
    expect(screen.getByRole('tab', { name: '示例站点' })).toBeInTheDocument()

    // 过长标题截断：CSS 截断 + title 属性给全名
    navigate('page-title-updated', { title: '一个特别特别长的页面标题' })
    expect(screen.getByRole('tab', { name: '一个特别特别长的页面标题' })).toHaveAttribute(
      'title',
      '一个特别特别长的页面标题'
    )
  })

  it('换会话根（切项目 / 移至项目）：面板收起 + 标签回默认，终端随之 dispose', async () => {
    render(<Workbench />)
    await newTab('terminal')
    await waitFor(() => expect(bed.bridge.terminal.start).toHaveBeenCalled())

    // 变根：默认工作区换到另一条目录（threadId 不变 —— 就是"移至项目"那种情形）
    const settings = {
      ...defaultSettings(),
      workspaces: [{ path: 'D:\\另一个工作区', mode: 'ask' as const }]
    }
    useSettingsStore.setState({ settings, loaded: true })

    await waitFor(() => expect(useShellStore.getState().workPanelOpen).toBe(false))
    expect(useWorkbenchStore.getState().tabs.map((tab) => tab.kind)).toEqual(['files'])
    expect(kinds()).toEqual(['files'])
    expect(bed.bridge.terminal.dispose).toHaveBeenCalledWith('term-1')
    // 新根的文件树（不是拿旧根继续用）
    await waitFor(() => expect(bed.bridge.workbench.listDir).toHaveBeenCalledWith('thread-1', ''))
    expect(screen.getByRole('tab', { name: '另一个工作区' })).toBeInTheDocument()
  })

  it('同根内切会话：面板不关、标签不动（文件/Git/终端按会话重挂清态）', async () => {
    render(<Workbench />)
    await newTab('git')

    // 同一个根下的另一个会话：threadId 变、rootPath 不变
    useSessionsStore.setState({ activeId: 'thread-2', loaded: true })

    await waitFor(() => expect(bed.bridge.workbench.listDir).toHaveBeenCalledWith('thread-2', ''))
    expect(useShellStore.getState().workPanelOpen).toBe(true)
    expect(useWorkbenchStore.getState().tabs.map((tab) => tab.kind)).toEqual(['files', 'git'])
    expect(screen.getByRole('tab', { name: '工作区' })).toBeInTheDocument()
  })

  it('头部图标簇：＋ 新建（四种都在）/ ⤢ 切全屏 / ▯ 收起面板（全屏一并复位）', async () => {
    render(<Workbench />)

    fireEvent.keyDown(screen.getByTestId('workbench-new-tab'), { key: 'ArrowDown' })
    for (const kind of ['browser', 'files', 'git', 'terminal']) {
      expect(screen.getByTestId(`workbench-new-${kind}`)).toBeInTheDocument()
    }
    fireEvent.keyDown(screen.getByTestId('workbench-new-browser'), { key: 'Escape' })
    await tick()

    const fullscreen = screen.getByTestId('workbench-fullscreen')
    expect(fullscreen).toHaveAccessibleName('面板全屏')
    fireEvent.click(fullscreen)
    expect(useShellStore.getState().workPanelFullscreen).toBe(true)
    expect(screen.getByTestId('workbench-fullscreen')).toHaveAccessibleName('回到窗口化')

    // e2e 契约：面板打开时，work-panel-toggle 落在头部这个 ▯ 上（浮动钮已让位）
    expect(screen.getByTestId('work-panel-toggle')).toContainElement(
      screen.getByTestId('workbench-close')
    )
    fireEvent.click(screen.getByTestId('workbench-close'))
    expect(useShellStore.getState().workPanelOpen).toBe(false)
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)
  })
})

describe('Workbench 空态：动作列表 + 真实快捷键（round 46）', () => {
  it('四行齐全：图标 + 标签（无障碍名不含键帽）+ 逐个单键的键帽', () => {
    render(<Workbench />)
    toEmpty()

    const list = screen.getByTestId('workbench-empty-actions')
    const rows = screen.getAllByTestId(/^workbench-empty-action-/)
    expect(rows).toHaveLength(4)
    expect(list).toContainElement(rows[0]!)
    // 行的无障碍名就是标签（键帽不念出来）
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      '浏览器',
      '文件',
      '改动',
      '终端'
    ])
    expect(keyCapsOf('browser')).toEqual(['Ctrl', 'T'])
    expect(keyCapsOf('files')).toEqual(['Ctrl', 'Shift', 'E'])
    expect(keyCapsOf('git')).toEqual(['Ctrl', 'Shift', 'G'])
    expect(keyCapsOf('terminal')).toEqual(['Ctrl', '`'])
    // 样式口径：行 hover / 焦点铺灰底（Fills）、150ms 过渡不硬切；键帽走 hairline 描边 + 等宽
    expect(rows[0]).toHaveClass(
      'hover:bg-hover',
      'focus-visible:bg-hover',
      'duration-(--motion-fast)'
    )
    expect(rows[0]!.querySelector('kbd')).toHaveClass(
      'border-hairline',
      'rounded-badge',
      'font-mono'
    )
    // 无标题、无解释小字
    expect(screen.queryByText('标签页都关掉了')).not.toBeInTheDocument()
  })

  it('点击行即开对应标签（空态随之让位）', () => {
    render(<Workbench />)
    toEmpty()

    fireEvent.click(screen.getByTestId('workbench-empty-action-browser'))

    expect(kinds()).toEqual(['browser'])
    expect(useWorkbenchStore.getState().tabs.map((tab) => tab.kind)).toEqual(['browser'])
    expect(screen.queryByTestId('workbench-empty')).not.toBeInTheDocument()
  })

  it('Enter / Space 也能开（原生 button 的键盘激活；jsdom 不实现，组件显式补上）', async () => {
    render(<Workbench />)
    toEmpty()

    const files = screen.getByTestId('workbench-empty-action-files')
    files.focus()
    fireEvent.keyDown(files, { key: 'Enter' })
    await tick()
    expect(kinds()).toEqual(['files'])

    fireEvent.click(screen.getByRole('button', { name: '关闭 工作区' }))
    const git = screen.getByTestId('workbench-empty-action-git')
    git.focus()
    fireEvent.keyDown(git, { key: ' ' })
    await tick()
    expect(kinds()).toEqual(['git'])
  })

  it('快捷键：Ctrl+T / Ctrl+Shift+E / Ctrl+Shift+G / Ctrl+` 各开一种（大小写与左右修饰键宽容）', () => {
    render(<Workbench />)
    toEmpty()

    fireEvent.keyDown(window, { key: 't', ctrlKey: true })
    // Ctrl+Shift+E 在多数布局下 event.key 是 'E'（大写）
    fireEvent.keyDown(window, { key: 'E', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: 'G', ctrlKey: true, shiftKey: true })
    fireEvent.keyDown(window, { key: '`', ctrlKey: true })
    expect(kinds()).toEqual(['browser', 'files', 'git', 'terminal'])

    // 反引号的另一套键名（有的实现给 'Backquote'）同样命中终端：关掉再按，重新开一个
    fireEvent.click(screen.getByRole('button', { name: '关闭 终端' }))
    expect(kinds()).toEqual(['browser', 'files', 'git'])
    fireEvent.keyDown(window, { key: 'Backquote', ctrlKey: true })
    expect(kinds()).toEqual(['browser', 'files', 'git', 'terminal'])
  })

  it('快捷键不命中：无 Ctrl 的单键 / 少 Shift / 多按 Alt·Meta 都不开；命中时吞掉事件', () => {
    render(<Workbench />)
    toEmpty()

    // 没命中就不动事件（fireEvent 返回 false 表示 defaultPrevented）
    expect(fireEvent.keyDown(window, { key: 't' })).toBe(true)
    expect(fireEvent.keyDown(window, { key: 'T', shiftKey: true })).toBe(true)
    expect(fireEvent.keyDown(window, { key: 'e', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(window, { key: 'g', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(window, { key: 't', ctrlKey: true, altKey: true })).toBe(true)
    expect(fireEvent.keyDown(window, { key: 't', ctrlKey: true, metaKey: true })).toBe(true)
    expect(fireEvent.keyDown(window, { key: 'x', ctrlKey: true })).toBe(true)
    expect(useWorkbenchStore.getState().tabs).toEqual([])

    // 命中：吞掉事件
    expect(fireEvent.keyDown(window, { key: 't', ctrlKey: true })).toBe(false)
    expect(kinds()).toEqual(['browser'])
  })

  it('面板收起也生效（监听在 window 上；WorkPanel 收起只是宽 0，不卸载）', () => {
    render(
      <WorkPanel open={false}>
        <Workbench />
      </WorkPanel>
    )
    toEmpty()
    expect(screen.getByTestId('workbench-empty-actions')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 't', ctrlKey: true })

    expect(kinds()).toEqual(['browser'])
  })
})
