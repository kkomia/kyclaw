import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShellStore } from '@renderer/lib/shell-store'
import { AppShell } from '../AppShell'

beforeEach(() => {
  useShellStore.setState({ sidebarCollapsed: false, workPanelOpen: false })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 壳里有路由件（导航链接 / 主列的 Outlet），单测一律套 MemoryRouter 渲染。 */
function renderShell(path = '/chat'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
    </MemoryRouter>
  )
}

describe('AppShell 三栏骨架', () => {
  it('三栏都在，宽度走壳 token：侧栏 240 / 主列 flex-1 / 工作台 400（默认收起）', () => {
    renderShell()

    expect(screen.getByTestId('app-root')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar')).toHaveClass('w-(--sidebar-width)')
    expect(screen.getByTestId('main-column')).toHaveClass('flex-1')

    const panel = screen.getByTestId('work-panel')
    expect(panel).not.toHaveClass('is-open')
    expect(panel).not.toHaveClass('w-(--work-panel-width)')
  })

  it('折叠侧栏：拿 is-collapsed 并用 translate(-100%) 滑出，主列类名一字不变（主列不位移）', () => {
    renderShell()
    const mainClasses = screen.getByTestId('main-column').className

    fireEvent.click(screen.getByTestId('sidebar-toggle'))

    const sidebar = screen.getByTestId('sidebar')
    expect(sidebar).toHaveClass('is-collapsed', '-translate-x-full')
    // 滑出屏幕后不该还能 Tab 进去/被读屏念到
    expect(sidebar).toHaveAttribute('inert')
    expect(screen.getByTestId('main-column').className).toBe(mainClasses)

    fireEvent.click(screen.getByTestId('sidebar-toggle'))

    expect(screen.getByTestId('sidebar')).not.toHaveClass('is-collapsed')
    expect(screen.getByTestId('sidebar')).not.toHaveClass('-translate-x-full')
    expect(screen.getByTestId('sidebar')).not.toHaveAttribute('inert')
    expect(screen.getByTestId('main-column').className).toBe(mainClasses)
  })

  it('工作台面板：开关切换 is-open 与 400 宽（收起时不占宽）', () => {
    renderShell()
    const panel = screen.getByTestId('work-panel')

    fireEvent.click(screen.getByTestId('work-panel-toggle'))
    expect(panel).toHaveClass('is-open', 'w-(--work-panel-width)')
    expect(panel).not.toHaveClass('w-0')

    fireEvent.click(screen.getByTestId('work-panel-toggle'))
    expect(panel).not.toHaveClass('is-open')
    expect(panel).toHaveClass('w-0')
  })

  it('工作台开关的新家（round 4）：钉在内容卡右上角，顶栏不再有它（用户裁决 R2 concern ①）', () => {
    renderShell()

    const toggle = screen.getByTestId('work-panel-toggle')
    // 在内容卡里面（右上角浮层定位），不在顶栏
    expect(screen.getByTestId('content-region')).toContainElement(toggle)
    expect(screen.getByTestId('titlebar')).not.toContainElement(toggle)
    // round 24：对话页顶部栏（40px）出来之后，按钮就是这条带的右端——上移 6px 与带对齐
    expect(toggle).toHaveClass('absolute', 'top-0.5', 'right-2')
    // 形态与窗控同口径：无外圈、hover 铺 Fills-F1、图标 18
    expect(toggle).toHaveClass('border-transparent', 'hover:bg-hover')
    expect(toggle.querySelector('span[aria-hidden="true"]')).toHaveClass('size-(--icon-size-md)')
    // 可访问名随开合换；展开态 = ◧（PanelRight），不带收起箭头
    expect(toggle).toHaveAccessibleName('展开工作台')
    expect(toggle.querySelector('svg')?.getAttribute('class') ?? '').toContain(
      'lucide-panel-right-open'
    )

    fireEvent.click(toggle)
    const opened = screen.getByTestId('work-panel-toggle')
    expect(opened).toHaveAccessibleName('收起工作台')
    const iconClass = opened.querySelector('svg')?.getAttribute('class') ?? ''
    expect(iconClass).toContain('lucide-panel-right')
    expect(iconClass).not.toContain('lucide-panel-right-open')
  })

  it('工作台开关只在对话路由（round 17 用户实拍）：其它页面右上角没有它', () => {
    renderShell('/plugins')

    expect(screen.queryByTestId('work-panel-toggle')).not.toBeInTheDocument()
    // 面板本体仍在（只是没有开关入口；窄窗自动收的逻辑不受影响）
    expect(screen.getByTestId('work-panel')).toBeInTheDocument()
  })

  it('对话路由：开关在（/chat；/ 会被重定向到 /chat）', () => {
    renderShell('/chat')
    expect(screen.getByTestId('work-panel-toggle')).toBeInTheDocument()
  })

  it('两个开关互不牵连（侧栏折叠不影响面板，反之亦然）', () => {
    renderShell()

    fireEvent.click(screen.getByTestId('sidebar-toggle'))
    expect(screen.getByTestId('work-panel')).not.toHaveClass('is-open')

    fireEvent.click(screen.getByTestId('work-panel-toggle'))
    expect(screen.getByTestId('sidebar')).toHaveClass('is-collapsed')

    fireEvent.click(screen.getByTestId('sidebar-toggle'))
    expect(screen.getByTestId('sidebar')).not.toHaveClass('is-collapsed')
    expect(screen.getByTestId('work-panel')).toHaveClass('is-open')
  })

  it('T5 装配：侧栏 = 新建会话 + 会话列表 + 底部单一入口；右栏 = 工作台空态', () => {
    renderShell()

    const sidebar = screen.getByTestId('sidebar')
    expect(screen.getByTestId('new-session')).toBeInTheDocument()
    expect(screen.getByTestId('session-list')).toBeInTheDocument()
    // 单一入口（雷点 3：首页只放精简菜单，设置/记忆/用量收进二级菜单）
    expect(screen.getByTestId('sidebar-footer')).toBeInTheDocument()
    expect(sidebar).toContainElement(screen.getByTestId('sidebar-footer'))
    expect(sidebar).toContainElement(screen.getByTestId('new-session'))
    expect(screen.queryByTestId('nav-settings')).not.toBeInTheDocument()

    expect(screen.getByTestId('work-panel')).toContainElement(
      screen.getByTestId('work-panel-empty')
    )
  })

  it('设置页：侧栏换成设置菜单（返回 + 栏目），会话视图让位', () => {
    renderShell('/settings')

    expect(screen.getByTestId('settings-nav')).toBeInTheDocument()
    expect(screen.getByTestId('settings-back')).toBeInTheDocument()
    expect(screen.queryByTestId('session-list')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-footer')).not.toBeInTheDocument()
  })

  it('内容区（R2 D2/D4；round 3 四角圆角卡）：一块面 + 右/底留缝 + 一对缺口角', () => {
    renderShell()

    const region = screen.getByTestId('content-region')
    // round 3：四角圆角（Kimi 式整卡），右/底留出画布缝（--shell-edge-gap = 6，Kimi 实测）
    expect(region).toHaveClass(
      'rounded-overlay',
      'bg-surface',
      'overflow-hidden',
      'mr-(--shell-edge-gap)',
      'mb-(--shell-edge-gap)'
    )
    expect(region).not.toHaveClass('rounded-t-overlay')
    // 右栏在内容区里面（不是独立第三根柱子）
    expect(region).toContainElement(screen.getByTestId('main-column'))
    expect(region).toContainElement(screen.getByTestId('work-panel'))
    // 右栏自己不再铺画布底（跟随内容区），只留分隔线
    expect(screen.getByTestId('work-panel')).toHaveClass('border-hairline')
    expect(screen.getByTestId('work-panel')).not.toHaveClass('bg-canvas')
    // 侧栏与顶栏同属"壳"那层：靠底色差 + 内容区圆角相接，没有右缘描边
    expect(screen.getByTestId('sidebar')).not.toHaveClass('border-r')
    // 左缘的两个缺口角：上沿 + 下沿一对（都跟 --content-safe-left 走）
    expect(screen.getByTestId('shell-notch')).toHaveClass('shell-notch', 'top-0')
    expect(screen.getByTestId('shell-notch-bottom')).toHaveClass(
      'shell-notch-bottom',
      'bottom-(--shell-edge-gap)'
    )
    for (const id of ['shell-notch', 'shell-notch-bottom']) {
      expect(screen.getByTestId(id)).toHaveClass(
        'left-(--content-safe-left)',
        'size-(--radius-overlay)'
      )
    }
  })

  it('窄窗兜底（R2 D4）：窗口宽度低于阈值时自动收起工作台', () => {
    const callbacks: ResizeObserverCallback[] = []
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }
      observe(): void {
        /* 只收集回调，不需要真的观察 */
      }
      unobserve(): void {
        /* noop */
      }
      disconnect(): void {
        /* noop */
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)

    useShellStore.setState({ workPanelOpen: true })
    renderShell()

    expect(callbacks).toHaveLength(1)
    // 阈值 token 在 jsdom 里读不到 → 用兜底 1120：窄窗（< 1120）收、宽窗不动
    act(() => {
      callbacks[0]([{ contentRect: { width: 900 } } as ResizeObserverEntry], {} as ResizeObserver)
    })
    expect(screen.getByTestId('work-panel')).not.toHaveClass('is-open')

    act(() => {
      useShellStore.setState({ workPanelOpen: true })
    })
    act(() => {
      callbacks[0]([{ contentRect: { width: 1400 } } as ResizeObserverEntry], {} as ResizeObserver)
    })
    expect(screen.getByTestId('work-panel')).toHaveClass('is-open')
  })

  it('data-sidebar 跟随折叠状态（内容列的安全边靠它算）', () => {
    renderShell()

    expect(screen.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'expanded')

    fireEvent.click(screen.getByTestId('sidebar-toggle'))

    expect(screen.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed')
  })
})
