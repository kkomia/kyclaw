import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentApiStub,
  attachmentsApiStub,
  filesApiStub,
  knowledgeApiStub,
  localModelsApiStub,
  memoryApiStub,
  notesApiStub,
  officeApiStub,
  pluginsApiStub,
  projectsApiStub,
  searchApiStub,
  settingsApiStub,
  telemetryApiStub,
  terminalApiStub,
  translateApiStub,
  updatesApiStub,
  workbenchApiStub,
  workspaceApiStub
} from '@renderer/__tests__/kyclaw-bridge'
import type { KyclawWindowApi } from '@shared/ipc'
import { TitleBar, type TitleBarProps } from '../TitleBar'

/** 装一个假的 preload 桥（渲染端真正会看到的那张面），并按需替换方法 */
function stubWindowApi(overrides: Partial<KyclawWindowApi> = {}): KyclawWindowApi {
  const api: KyclawWindowApi = {
    minimize: vi.fn(),
    maximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(async () => false),
    onStateChanged: vi.fn(() => () => {}),
    ...overrides
  }
  // T5 起 KyclawApi 多了 settings 面、T6 起多了 agent 面、T18 起多了 projects 面、T17 起多了
  // updates / telemetry 面、round 28 起多了 memory 面、模块 3B 起多了 localModels 面、
  // 工作台起多了 workbench / terminal 面、round 32 起多了 translate 面、模块 2 起多了 attachments 面、
  // round 53 起多了 files 面（File → 绝对路径的小桥）、M5 起多了 notes / knowledge 面：
  // 本文件只测窗口面，其余给桩即可
  window.kyclaw = {
    window: api,
    settings: settingsApiStub(),
    workspace: workspaceApiStub(),
    workbench: workbenchApiStub(),
    terminal: terminalApiStub(),
    office: officeApiStub(),
    projects: projectsApiStub(),
    notes: notesApiStub(),
    knowledge: knowledgeApiStub(),
    agent: agentApiStub(),
    attachments: attachmentsApiStub(),
    files: filesApiStub(),
    updates: updatesApiStub(),
    telemetry: telemetryApiStub(),
    plugins: pluginsApiStub(),
    memory: memoryApiStub(),
    localModels: localModelsApiStub(),
    translate: translateApiStub(),
    search: searchApiStub()
  }
  return api
}

function renderTitleBar(props: Partial<TitleBarProps> = {}): {
  onToggleSidebar: ReturnType<typeof vi.fn>
  rerender: (next: Partial<TitleBarProps>) => void
  unmount: () => void
} {
  const onToggleSidebar = vi.fn()
  const full: TitleBarProps = {
    sidebarCollapsed: false,
    onToggleSidebar,
    ...props
  }
  const { rerender, unmount } = render(
    <MemoryRouter>
      <TitleBar {...full} />
    </MemoryRouter>
  )

  return {
    onToggleSidebar,
    rerender: (next) =>
      rerender(
        <MemoryRouter>
          <TitleBar {...full} {...next} />
        </MemoryRouter>
      ),
    unmount
  }
}

function renderTitleBarAt(initialEntry: string): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TitleBar sidebarCollapsed={false} onToggleSidebar={vi.fn()} />
    </MemoryRouter>
  )
}

/** 取 ipc 推送监听器（onStateChanged 注册进去的那个） */
function pushedListener(api: KyclawWindowApi): (state: { maximized: boolean }) => void {
  const listener = vi.mocked(api.onStateChanged).mock.calls[0]?.[0]
  if (!listener) throw new Error('没有订阅窗口状态')
  return listener
}

beforeEach(() => {
  stubWindowApi()
})

describe('TitleBar', () => {
  it('42 高 + 拖拽区（-webkit-app-region: drag），按钮都落在 no-drag 容器里', () => {
    renderTitleBar()

    const bar = screen.getByTestId('titlebar')
    expect(bar).toHaveClass('h-(--titlebar-height)', 'drag-region')

    for (const testId of ['sidebar-toggle', 'window-minimize']) {
      expect(screen.getByTestId(testId).closest('.no-drag'), testId).not.toBeNull()
    }
  })

  it('中段是顶栏标签栏（0.2.0 打样）：标签区 + 「＋」在 no-drag 里，标签右侧留白仍可拖窗', () => {
    renderTitleBar()

    expect(screen.getByTestId('titlebar')).toContainElement(screen.getByTestId('app-tabbar'))
    // 可点区域一律 no-drag（否则 drag-region 会吞点击）
    expect(screen.getByTestId('app-tabbar-scroll').closest('.no-drag')).not.toBeNull()
    expect(screen.getByTestId('app-tab-add').closest('.no-drag')).not.toBeNull()
    // 标签栏内部的留白不属于 no-drag：标题栏的 drag-region 在那里继续生效
    expect(screen.getByTestId('app-tabbar-spacer').closest('.no-drag')).toBeNull()
  })

  it('窗控三键：图标 18 的 lucide 图标（R10）', () => {
    renderTitleBar()

    for (const testId of ['window-minimize', 'window-maximize', 'window-close']) {
      const button = screen.getByTestId(testId)
      const icon = button.querySelector('span')
      const svg = icon?.querySelector('svg')

      expect(icon, testId).toHaveClass('size-(--icon-size-md)')
      expect(svg, testId).not.toBeNull()
      expect(svg?.getAttribute('class'), testId).toMatch(/lucide/)
    }
  })

  it('悬停档：最小化/最大化铺 Fills-F1，关闭键铺 --Colors-Red + 危险前色', () => {
    renderTitleBar()

    for (const testId of ['window-minimize', 'window-maximize']) {
      expect(screen.getByTestId(testId), testId).toHaveClass('hover:bg-hover')
    }

    const close = screen.getByTestId('window-close')
    expect(close).toHaveClass('hover:bg-danger', 'hover:text-(--button-danger-fg)')
    expect(close).not.toHaveClass('hover:bg-hover')
  })

  it('三键同组：最小化/最大化/关闭在同一个按钮区里', () => {
    renderTitleBar()

    const group = screen.getByTestId('window-minimize').parentElement
    expect(group).toHaveClass('no-drag')
    expect(screen.getByTestId('window-maximize').parentElement).toBe(group)
    expect(screen.getByTestId('window-close').parentElement).toBe(group)
  })

  it('点窗控三键 → 打到 preload 的三个方法', () => {
    const api = stubWindowApi()
    renderTitleBar()

    fireEvent.click(screen.getByTestId('window-minimize'))
    fireEvent.click(screen.getByTestId('window-maximize'))
    fireEvent.click(screen.getByTestId('window-close'))

    expect(api.minimize).toHaveBeenCalledTimes(1)
    expect(api.maximize).toHaveBeenCalledTimes(1)
    expect(api.close).toHaveBeenCalledTimes(1)
  })

  it('挂载时问一次 isMaximized（不能只看推送）', async () => {
    const api = stubWindowApi({ isMaximized: vi.fn(async () => true) })
    renderTitleBar()

    await screen.findByRole('button', { name: '还原' })
    expect(api.isMaximized).toHaveBeenCalledTimes(1)
  })

  it('最大化状态决定第二键的可访问名（最大化 ⇄ 还原），推送来了就跟着变', async () => {
    const api = stubWindowApi({ isMaximized: vi.fn(async () => false) })
    renderTitleBar()

    await screen.findByRole('button', { name: '最大化' })

    act(() => pushedListener(api)({ maximized: true }))
    expect(screen.getByTestId('window-maximize')).toHaveAccessibleName('还原')

    act(() => pushedListener(api)({ maximized: false }))
    expect(screen.getByTestId('window-maximize')).toHaveAccessibleName('最大化')
  })

  it('卸载时退订状态推送（不留悬挂监听）', () => {
    const unsubscribe = vi.fn()
    stubWindowApi({ onStateChanged: vi.fn(() => unsubscribe) })
    const { unmount } = renderTitleBar()

    unmount()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('侧栏折叠钮：点击回调 + 按折叠态换可访问名', () => {
    const { onToggleSidebar, rerender } = renderTitleBar({ sidebarCollapsed: false })

    const toggle = screen.getByTestId('sidebar-toggle')
    expect(toggle).toHaveAccessibleName('收起侧栏')

    fireEvent.click(toggle)
    expect(onToggleSidebar).toHaveBeenCalledTimes(1)

    rerender({ sidebarCollapsed: true })
    expect(screen.getByTestId('sidebar-toggle')).toHaveAccessibleName('展开侧栏')
  })

  it('侧栏开关不画外圈（R2 D3；工作台开关 round 4 已搬去内容卡右上角，见 app-shell.spec）：描边透明 + 悬停只铺 Fills-F1', () => {
    renderTitleBar({ sidebarCollapsed: false })

    const toggle = screen.getByTestId('sidebar-toggle')
    expect(toggle).toHaveClass('border-transparent', 'hover:bg-hover')
    // 图标仍是 18 档（IconButton 默认）
    expect(toggle.querySelector('span[aria-hidden="true"]')).toHaveClass('size-(--icon-size-md)')
  })

  it('顶栏不再有工作台开关（round 4：搬进内容卡右上角）', () => {
    renderTitleBar()

    expect(screen.queryByTestId('work-panel-toggle')).not.toBeInTheDocument()
  })

  it('preload 桥缺失（例如浏览器里打开渲染端）也不崩：点键静默无操作', () => {
    const api = stubWindowApi()
    Reflect.deleteProperty(window, 'kyclaw')

    expect(() => renderTitleBar()).not.toThrow()
    expect(() => fireEvent.click(screen.getByTestId('window-close'))).not.toThrow()
    expect(api.close).not.toHaveBeenCalled()
  })

  it('一屏一只：/chat 不渲染顶栏品牌位（输入卡状态灯是唯一一只）', () => {
    renderTitleBarAt('/chat')
    expect(screen.queryByTestId('titlebar-otter')).not.toBeInTheDocument()
  })

  it('一屏一只：关于页不渲染顶栏品牌位（关于页 96 是唯一一只）', () => {
    renderTitleBarAt('/settings/about')
    expect(screen.queryByTestId('titlebar-otter')).not.toBeInTheDocument()
  })

  it('一屏一只：非对话模块（Office/笔记/知识库/其它设置）渲染顶栏品牌位 32 static', () => {
    for (const route of ['/office', '/notes', '/knowledge', '/settings/appearance', '/plugins']) {
      const view = render(
        <MemoryRouter initialEntries={[route]}>
          <TitleBar sidebarCollapsed={false} onToggleSidebar={vi.fn()} />
        </MemoryRouter>
      )
      const brand = screen.getByTestId('titlebar-otter')
      expect(brand, route).toHaveClass('no-drag')
      const mark = brand.querySelector('[data-testid="otter-mark"]')
      expect(mark, route).toHaveAttribute('data-size', '32')
      expect(mark, route).toHaveAttribute('data-variant', 'static')
      expect(mark?.querySelector('svg[viewBox="0 0 48 48"]'), route).not.toBeNull()
      expect(brand.closest('[data-testid="titlebar"]'), route).not.toBeNull()
      view.unmount()
    }
  })
})
