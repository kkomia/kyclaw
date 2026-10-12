import { act, fireEvent, render, screen } from '@testing-library/react'
import { Link, MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useShellStore } from '@renderer/lib/shell-store'
import { AppShell } from '../AppShell'

beforeEach(() => {
  useShellStore.setState({
    sidebarCollapsed: false,
    workPanelOpen: false,
    workPanelWidth: 400,
    workPanelFullscreen: false
  })
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
    // 宽度走 store → 内联覆盖 token（round 39 拖拽调宽之后，内外层仍读同一条变量）
    expect(panel).toHaveStyle('--work-panel-width: 400px')

    // round 39：面板开着时收起它的是头部那个 ▯（浮动钮让位，两者共用 e2e 契约的 testid）
    fireEvent.click(screen.getByTestId('workbench-close'))
    expect(panel).not.toHaveClass('is-open')
    expect(panel).toHaveClass('w-0')
  })

  it('工作台开关的新家（round 4 / round 39）：关着时钉在内容卡右上角，开着时让位给头部图标簇', () => {
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
    // 关着时它就是"打开入口"：可访问名与图标都指向"展开"
    expect(toggle).toHaveAccessibleName('展开工作台')
    expect(toggle.querySelector('svg')?.getAttribute('class') ?? '').toContain(
      'lucide-panel-right-open'
    )

    fireEvent.click(toggle)
    // 打开后浮动钮不渲染（round 39：那个位置换成了工作台自己的头部）；
    // 同一个 testid 落在头部的 ▯ 上 —— walkthrough 用它收起面板，契约不破
    const headerClose = screen.getByTestId('workbench-close')
    expect(screen.getByTestId('work-panel-toggle')).toContainElement(headerClose)
    expect(headerClose).toHaveAccessibleName('收起工作台')
    const iconClass = headerClose.querySelector('svg')?.getAttribute('class') ?? ''
    expect(iconClass).toContain('lucide-panel-right')
    expect(iconClass).not.toContain('lucide-panel-right-open')
  })

  it('工作台开关只在对话路由（round 17 用户实拍）：其它页面右上角没有它', () => {
    renderShell('/plugins')

    expect(screen.queryByTestId('work-panel-toggle')).not.toBeInTheDocument()
    // 面板本体仍在（只是没有开关入口；窄窗自动收的逻辑不受影响）
    expect(screen.getByTestId('work-panel')).toBeInTheDocument()
  })

  it('离开对话路由自动收起工作台（round 48 用户口径）：设置/插件等页不残留打开的面板', () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <AppShell />
        <Link to="/plugins" data-testid="go-plugins">
          插件
        </Link>
        <Link to="/chat" data-testid="go-chat">
          对话
        </Link>
      </MemoryRouter>
    )

    // 对话页：开面板 + 全屏
    fireEvent.click(screen.getByTestId('work-panel-toggle'))
    fireEvent.click(screen.getByTestId('workbench-fullscreen'))
    expect(screen.getByTestId('work-panel')).toHaveClass('is-open')

    // 切到插件页：面板与全屏一并收起
    fireEvent.click(screen.getByTestId('go-plugins'))
    expect(useShellStore.getState().workPanelOpen).toBe(false)
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)
    expect(screen.getByTestId('work-panel')).not.toHaveClass('is-open')

    // 回到对话：不自动展开（由用户再开）
    fireEvent.click(screen.getByTestId('go-chat'))
    expect(screen.getByTestId('work-panel')).not.toHaveClass('is-open')
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

  it('T5 装配：侧栏 = 新建会话 + 会话列表 + 底部单一入口；右栏 = 工作台（四工具 tab 栏）', () => {
    renderShell()

    const sidebar = screen.getByTestId('sidebar')
    expect(screen.getByTestId('new-session')).toBeInTheDocument()
    expect(screen.getByTestId('session-list')).toBeInTheDocument()
    // 单一入口（雷点 3：首页只放精简菜单，设置/记忆/用量收进二级菜单）
    expect(screen.getByTestId('sidebar-footer')).toBeInTheDocument()
    expect(sidebar).toContainElement(screen.getByTestId('sidebar-footer'))
    expect(sidebar).toContainElement(screen.getByTestId('new-session'))
    expect(screen.queryByTestId('nav-settings')).not.toBeInTheDocument()

    expect(screen.getByTestId('work-panel')).toContainElement(screen.getByTestId('workbench'))
  })

  it('设置页：侧栏换成设置菜单（返回 + 栏目），会话视图让位', () => {
    renderShell('/settings')

    expect(screen.getByTestId('settings-nav')).toBeInTheDocument()
    // round 50：设置左列与侧栏滚动区同款——静置不显示滚动条（见 scrollbar-contract.spec.ts）
    expect(screen.getByTestId('settings-nav')).toHaveClass('scrollbar-auto-hide')
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

    // 两个观察者：AppShell 的（壳宽 → 自动收面板）与 WorkPanel 的（内容区宽 → 收回过宽宽度）。
    // 这里只驱动"壳宽"这一路；把回调全喂一遍即可（宽度那路收到 0 宽的内容区也不动）
    expect(callbacks.length).toBeGreaterThan(0)
    const fire = (width: number): void => {
      act(() => {
        for (const callback of callbacks) {
          callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver)
        }
      })
    }

    // 阈值 token 在 jsdom 里读不到 → 用兜底 1120：窄窗（< 1120）收、宽窗不动
    fire(900)
    expect(screen.getByTestId('work-panel')).not.toHaveClass('is-open')

    act(() => {
      useShellStore.setState({ workPanelOpen: true })
    })
    fire(1400)
    expect(screen.getByTestId('work-panel')).toHaveClass('is-open')
  })

  it('data-sidebar 跟随折叠状态（内容列的安全边靠它算）', () => {
    renderShell()

    expect(screen.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'expanded')

    fireEvent.click(screen.getByTestId('sidebar-toggle'))

    expect(screen.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed')
  })
})

describe('AppShell · round 39（全屏 / 浮动钮让位）', () => {
  it('浮动 ▯：面板关着时是打开入口；开着时不渲染（不与头部图标簇重叠）', () => {
    renderShell()

    expect(screen.getByTestId('work-panel-toggle')).toHaveClass('absolute')
    expect(screen.queryByTestId('workbench-close')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('work-panel-toggle'))

    // 浮动钮不在了；开关落到头部 ▯ 上（同一个 testid 换了个家）
    const toggle = screen.getByTestId('work-panel-toggle')
    expect(toggle).not.toHaveClass('absolute')
    expect(screen.getByTestId('workbench-close')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workbench-close'))
    expect(screen.getByTestId('work-panel-toggle')).toHaveClass('absolute')
  })

  it('全屏（⤢）：中列 hidden 让位但不卸载，工作台占满内容区；关面板时一并退出全屏', () => {
    renderShell()
    fireEvent.click(screen.getByTestId('work-panel-toggle'))

    fireEvent.click(screen.getByTestId('workbench-fullscreen'))

    expect(useShellStore.getState().workPanelFullscreen).toBe(true)
    const panel = screen.getByTestId('work-panel')
    expect(panel).toHaveAttribute('data-fullscreen', 'true')
    expect(panel).toHaveClass('is-open', 'flex-1')
    expect(panel).not.toHaveClass('w-(--work-panel-width)')
    // round 59：全屏让开可见左缘（这条变量就挂在壳根，见 AppShell/[data-sidebar]）
    expect(panel).toHaveClass('ml-(--content-safe-left)')
    // 中列只是 hidden（聊天状态要留），不是卸载
    const main = screen.getByTestId('main-column')
    expect(main).toHaveClass('hidden')
    expect(screen.getByTestId('content-region')).toContainElement(main)
    // 全屏时没有可拖的把手（宽度不适用）
    expect(screen.queryByTestId('work-panel-resizer')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workbench-close'))

    expect(useShellStore.getState().workPanelOpen).toBe(false)
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)
    expect(screen.getByTestId('main-column')).not.toHaveClass('hidden')
    expect(screen.getByTestId('work-panel')).toHaveClass('w-0')
  })

  it('面板开着时才有拖拽把手；窄窗自动收面板也走 store（全屏一并复位）', () => {
    useShellStore.setState({ workPanelOpen: true, workPanelFullscreen: true })
    renderShell()

    const panel = screen.getByTestId('work-panel')
    expect(panel).toHaveClass('flex-1')
    expect(screen.queryByTestId('work-panel-resizer')).not.toBeInTheDocument()

    act(() => {
      useShellStore.getState().setWorkPanelOpen(false)
    })
    expect(panel).toHaveClass('w-0')
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)
  })
})
