import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/settings'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useShellStore } from '@renderer/lib/shell-store'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
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

  it('全关光：给空态区 + 新建入口（不白屏）', async () => {
    render(<Workbench />)

    fireEvent.click(screen.getByRole('button', { name: '关闭 工作区' }))

    expect(screen.getByTestId('workbench-empty')).toBeInTheDocument()
    expect(screen.getByTestId('workbench-empty-hint')).toHaveTextContent('标签页都关掉了')
    expect(kinds()).toEqual([])
    // 头部还在（标签列表空、图标簇照常给新建入口）
    expect(screen.getByRole('tablist')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('workbench-new-tab-empty'), { key: 'ArrowDown' })
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
