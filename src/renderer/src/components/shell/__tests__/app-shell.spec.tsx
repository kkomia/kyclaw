import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Link, MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeQuitRequestPayload } from '@shared/office-editor'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { resetOfficeQuitFlowForTest } from '@renderer/features/office/office-quit-flow'
import { resetOfficeTabsStore } from '@renderer/features/office/office-tabs-store'
import { resetSessionsStore, useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { isWorkPanelSpaceConstrained, useShellStore } from '@renderer/lib/shell-store'
import { AppShell } from '../AppShell'

beforeEach(() => {
  useShellStore.setState({
    sidebarCollapsed: false,
    sidebarAutoCollapsed: false,
    workPanelOpen: false,
    workPanelWidth: 400,
    workPanelFullscreen: false,
    workPanelFit: null
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 壳当前是否处于"空间不足 → 铺满"（结论从布局事实派生，不再有单独的布尔字段） */
function spaceConstrained(): boolean {
  return isWorkPanelSpaceConstrained(useShellStore.getState().workPanelFit)
}

/**
 * ResizeObserver 替身：jsdom 没有布局，宽度只能由测试喂。
 * 只收集"谁在观察谁"，所以 `fire(元素, 宽)` 能精确驱动某一路观察者 —— 壳行那一路是 AppShell
 * 判"空间够不够"用的，内容区那一路是 WorkPanel 收窄过宽宽度用的（两者混着喂会互相干扰）。
 */
function stubResizeObserver(): { fire: (target: Element, width: number) => void } {
  const instances: Array<{ callback: ResizeObserverCallback; targets: Set<Element> }> = []
  class FakeResizeObserver {
    readonly callback: ResizeObserverCallback
    readonly targets = new Set<Element>()

    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
      instances.push({ callback, targets: this.targets })
    }
    observe(target: Element): void {
      this.targets.add(target)
    }
    unobserve(target: Element): void {
      this.targets.delete(target)
    }
    disconnect(): void {
      this.targets.clear()
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)

  return {
    fire(target, width) {
      act(() => {
        for (const observer of instances) {
          if (!observer.targets.has(target)) continue
          observer.callback(
            [{ contentRect: { width } } as ResizeObserverEntry],
            {} as ResizeObserver
          )
        }
      })
    }
  }
}

/** 壳里有路由件（导航链接 / 主列的 Outlet），单测一律套 MemoryRouter 渲染。 */
function renderShell(path = '/chat'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
    </MemoryRouter>
  )
}

describe('AppShell 三栏骨架', () => {
  it('三栏都在，宽度走壳 token：一级导航 56 图标栏 / 侧栏 240 / 主列 flex-1 / 工作台 400（默认收起）', () => {
    renderShell()

    expect(screen.getByTestId('app-root')).toBeInTheDocument()
    // 一级导航是 flow，且与 shell-row 平级：row 的实测宽已经不含它，窄窗判据无需二次折算
    expect(screen.getByTestId('primary-nav')).toHaveClass('w-(--primary-nav-rail-width)')
    expect(screen.getByTestId('primary-nav')).not.toHaveClass('w-(--primary-nav-width)')
    expect(screen.getByTestId('primary-nav').parentElement).toBe(
      screen.getByTestId('shell-row').parentElement
    )
    // 二级栏在内容卡内部（卡内左列），与主列/工作台是 flex 兄弟
    const region = screen.getByTestId('content-region')
    expect(region).toContainElement(screen.getByTestId('sidebar'))
    expect(screen.getByTestId('sidebar')).toHaveClass('w-(--sidebar-width)')
    expect(screen.getByTestId('main-column')).toHaveClass('flex-1')

    const panel = screen.getByTestId('work-panel')
    expect(panel).not.toHaveClass('is-open')
    expect(panel).not.toHaveClass('w-(--work-panel-width)')
  })

  it('折叠侧栏：卡内宽度收 0 + inert；主列是它的 flex 兄弟，胶囊卡结构不变', () => {
    renderShell()
    const region = screen.getByTestId('content-region')

    fireEvent.click(screen.getByTestId('sidebar-toggle'))

    const sidebar = screen.getByTestId('sidebar')
    expect(sidebar).toHaveClass('is-collapsed', 'w-0')
    expect(sidebar).not.toHaveClass('w-(--sidebar-width)')
    // 收没之后不该还画竖线 —— 会话栏与主对话之间那条 hairline 只在展开时存在
    expect(sidebar).not.toHaveClass('border-r')
    // 折叠不影响卡的结构：侧栏仍在卡里、主列是它后面的 flex 兄弟
    expect(region).toContainElement(sidebar)
    expect(sidebar.nextElementSibling).toBe(screen.getByTestId('main-column'))
    // 收没后不该还能 Tab 进去/被读屏念到
    expect(sidebar).toHaveAttribute('inert')

    fireEvent.click(screen.getByTestId('sidebar-toggle'))

    expect(screen.getByTestId('sidebar')).not.toHaveClass('is-collapsed')
    expect(screen.getByTestId('sidebar')).toHaveClass('w-(--sidebar-width)', 'border-r')
    expect(screen.getByTestId('sidebar')).not.toHaveAttribute('inert')
    expect(region).toContainElement(screen.getByTestId('sidebar'))
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

  it('顶栏侧栏开合钮恒显（v2 用户口径）：没有二级栏的 Office 路由也保留左端位置', () => {
    renderShell('/office')

    // 二级栏本身没有（Office 是独立模块），但顶栏左端的开合钮一致保留 —— 旧 showSidebarToggle 门已删
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument()
    const toggle = screen.getByTestId('sidebar-toggle')
    fireEvent.click(toggle)
    expect(useShellStore.getState().sidebarCollapsed).toBe(true)
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

  it('T5 装配：侧栏 = 新建会话 + 会话列表（task-73：底部不再有第二个设置入口）；右栏 = 工作台', () => {
    renderShell()

    const sidebar = screen.getByTestId('sidebar')
    expect(screen.getByTestId('new-session')).toBeInTheDocument()
    expect(screen.getByTestId('session-list')).toBeInTheDocument()
    expect(sidebar).toContainElement(screen.getByTestId('new-session'))
    // 用户反馈：会话侧栏底部 ⚙ 与最左 rail 底部齿轮重复 → 侧栏里不再有设置入口；
    // 唯一入口 = rail 的 primary-nav-settings（本文件另有「rail 设置可点」用例）
    expect(screen.queryByTestId('sidebar-footer')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-settings')).not.toBeInTheDocument()
    expect(screen.getByTestId('primary-nav-settings')).toBeInTheDocument()
    expect(sidebar).not.toContainElement(screen.getByTestId('primary-nav-settings'))

    expect(screen.getByTestId('work-panel')).toContainElement(screen.getByTestId('workbench'))
  })

  it('设置页：侧栏换成设置菜单（返回 + 栏目），会话视图让位', () => {
    renderShell('/settings')

    expect(screen.getByTestId('settings-nav')).toBeInTheDocument()
    // round 50：设置左列与侧栏滚动区同款——静置不显示滚动条（见 scrollbar-contract.spec.ts）
    expect(screen.getByTestId('settings-nav')).toHaveClass('scrollbar-auto-hide')
    expect(screen.getByTestId('settings-back')).toBeInTheDocument()
    expect(screen.queryByTestId('session-list')).not.toBeInTheDocument()
    // 侧栏里任何「设置」入口都不该有（唯一入口在 rail）
    expect(screen.queryByTestId('sidebar-footer')).not.toBeInTheDocument()
    expect(screen.queryByTestId('nav-settings')).not.toBeInTheDocument()
  })

  it('rail 底部设置是唯一入口：可点并进入 /settings（侧栏不出现第二个）', () => {
    function Probe(): React.JSX.Element {
      return <div data-testid="location-probe">{useLocation().pathname}</div>
    }

    render(
      <MemoryRouter initialEntries={['/chat']}>
        <AppShell />
        <Probe />
      </MemoryRouter>
    )

    const railSettings = screen.getByTestId('primary-nav-settings')
    expect(railSettings).toHaveAccessibleName('设置')
    fireEvent.click(railSettings)

    expect(screen.getByTestId('location-probe')).toHaveTextContent('/settings')
    expect(screen.getByTestId('settings-nav')).toBeInTheDocument()
    expect(screen.queryByTestId('nav-settings')).not.toBeInTheDocument()
  })

  it('内容区（R2 D2/D4；round 3 四角圆角卡；2026-10-17 侧栏进卡）：一整块面 + 右/底留缝 + 内部分界细线', () => {
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
    // 会话侧栏、主列、右栏全在同一张卡里（不再是覆盖层 / 独立柱子）
    expect(region).toContainElement(screen.getByTestId('sidebar'))
    expect(region).toContainElement(screen.getByTestId('main-column'))
    expect(region).toContainElement(screen.getByTestId('work-panel'))
    // 侧栏底色跟卡一致（--bg-surface），与主对话之间只留一条 1px 接缝线（task-85：调灰一档）
    expect(screen.getByTestId('sidebar')).toHaveClass(
      'bg-surface',
      'border-r',
      'border-(--seam-line)'
    )
    expect(screen.getByTestId('sidebar')).not.toHaveClass('bg-canvas')
    // 覆盖层时代的缺口角（shell-notch / shell-notch-bottom）已删除
    expect(screen.queryByTestId('shell-notch')).not.toBeInTheDocument()
    expect(screen.queryByTestId('shell-notch-bottom')).not.toBeInTheDocument()
    // 右栏自己不再铺画布底（跟随内容区），只留接缝线（task-85：调灰一档）
    expect(screen.getByTestId('work-panel')).toHaveClass('border-(--seam-line)')
    expect(screen.getByTestId('work-panel')).not.toHaveClass('bg-canvas')
  })

  it('窄窗兜底（round 77）：空间不够时工作台临时铺满内容区 —— 不关面板、不挤压聊天、不动全屏偏好', () => {
    const ro = stubResizeObserver()
    useShellStore.setState({ workPanelOpen: true })
    renderShell()

    const bench = screen.getByTestId('workbench')
    ro.fire(screen.getByTestId('shell-row'), 800)

    // 面板还在（不再自动收起），改成占满内容区
    const panel = screen.getByTestId('work-panel')
    expect(spaceConstrained()).toBe(true)
    expect(panel).toHaveClass('is-open', 'flex-1')
    // 2026-10-17 侧栏进卡后，全屏只需 flex-1 就落在侧栏右边；覆盖层时代的 safe-left 偏移已退休
    expect(panel).not.toHaveClass('ml-(--content-safe-left)')
    expect(panel).not.toHaveClass('w-(--work-panel-width)')
    expect(panel).toHaveAttribute('data-fullscreen', 'true')
    // "铺满"的来源要能分清：auto = 空间不足，不是用户按的 ⤢
    expect(panel).toHaveAttribute('data-fullscreen-source', 'auto')
    // 聊天让位但**不卸载**（状态要留）
    const main = screen.getByTestId('main-column')
    expect(main).toHaveClass('hidden')
    expect(screen.getByTestId('content-region')).toContainElement(main)
    // 工作台自己也没重挂（标签 / 终端 PTY 保活）
    expect(screen.getByTestId('workbench')).toBe(bench)
    // 用户偏好一个字节都没动
    expect(useShellStore.getState().workPanelOpen).toBe(true)
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)

    // 窗口拉宽 → 自动回到分栏
    ro.fire(screen.getByTestId('shell-row'), 1400)
    expect(spaceConstrained()).toBe(false)
    expect(panel).toHaveClass('is-open', 'w-(--work-panel-width)')
    expect(panel).not.toHaveClass('flex-1')
    expect(panel).toHaveAttribute('data-fullscreen', 'false')
    expect(panel).toHaveAttribute('data-fullscreen-source', 'none')
    expect(screen.getByTestId('main-column')).not.toHaveClass('hidden')
    expect(screen.getByTestId('workbench')).toBe(bench)
  })

  it('窄窗判据是实测算出来的：收起侧栏 / 拖宽面板都会翻转结论', () => {
    const ro = stubResizeObserver()
    useShellStore.setState({ workPanelOpen: true })
    renderShell()
    const row = screen.getByTestId('shell-row')

    // 1000 宽：侧栏 240 + 面板 400 → 中列只剩 354 → 铺满
    ro.fire(row, 1000)
    expect(spaceConstrained()).toBe(true)

    // 收起侧栏（safeLeft 0）→ 中列 594 → 分栏
    // jsdom 量不出行宽，收起后再喂同一个宽度（真机上这次是 effect 重跑时读 clientWidth）
    fireEvent.click(screen.getByTestId('sidebar-toggle'))
    ro.fire(row, 1000)
    expect(spaceConstrained()).toBe(false)

    // 侧栏展开回来 + 面板拖到 760：1400 的宽窗也放不下（1394 − 240 − 760 = 394）
    fireEvent.click(screen.getByTestId('sidebar-toggle'))
    act(() => {
      useShellStore.setState({ workPanelWidth: 760 })
    })
    ro.fire(row, 1400)
    expect(spaceConstrained()).toBe(true)

    // 双击把手回默认 400 → 同一个窗口又够（1394 − 240 − 400 = 754）
    act(() => {
      useShellStore.setState({ workPanelWidth: 400 })
    })
    ro.fire(row, 1400)
    expect(spaceConstrained()).toBe(false)
  })

  it('铺满后关面板（▯）回聊天：中列回来，这一位也收掉', () => {
    const ro = stubResizeObserver()
    useShellStore.setState({ workPanelOpen: true })
    renderShell()

    ro.fire(screen.getByTestId('shell-row'), 800)
    expect(screen.getByTestId('main-column')).toHaveClass('hidden')

    fireEvent.click(screen.getByTestId('workbench-close'))

    expect(useShellStore.getState().workPanelOpen).toBe(false)
    expect(spaceConstrained()).toBe(false)
    expect(screen.getByTestId('main-column')).not.toHaveClass('hidden')
    expect(screen.getByTestId('work-panel')).toHaveClass('w-0')
  })

  it('量不到行宽（jsdom / 隐藏态）时不乱判：维持分栏，不藏中列', () => {
    const ro = stubResizeObserver()
    useShellStore.setState({ workPanelOpen: true })
    renderShell()

    ro.fire(screen.getByTestId('shell-row'), 0)

    expect(spaceConstrained()).toBe(false)
    expect(screen.getByTestId('main-column')).not.toHaveClass('hidden')
    expect(screen.getByTestId('work-panel')).toHaveClass('is-open', 'w-(--work-panel-width)')
  })

  it('实机陷阱（round 78）：拖到越界进 auto 后，「恢复并排布局」就地收回并排（不动全屏偏好）', () => {
    const ro = stubResizeObserver()
    useShellStore.setState({ workPanelOpen: true, workPanelWidth: 560 })
    renderShell()
    const row = screen.getByTestId('shell-row')

    // 1274 − 240 − 560 = 474 < 480 → 铺满：把手让位、⤢ 槽换成"恢复并排布局"
    ro.fire(row, 1280)
    expect(spaceConstrained()).toBe(true)
    expect(screen.queryByTestId('work-panel-resizer')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workbench-restore-split'))

    // 落到 546 = 554（贴边上限） − 8（余量）；偏好与面板开关都没被动
    expect(useShellStore.getState().workPanelWidth).toBe(546)
    expect(useShellStore.getState().workPanelFullscreen).toBe(false)
    expect(useShellStore.getState().workPanelOpen).toBe(true)

    // 真机上这次重算是 effect 重跑读 clientWidth；jsdom 量不出行宽，再喂一次同一个宽度
    ro.fire(row, 1280)
    expect(spaceConstrained()).toBe(false)
    expect(screen.getByTestId('work-panel')).toHaveClass('is-open', 'w-(--work-panel-width)')
    expect(screen.getByTestId('main-column')).not.toHaveClass('hidden')
    expect(screen.getByTestId('work-panel-resizer')).toBeInTheDocument()
  })

  it('800 真窄窗（并排不可能）：槽位给「返回对话」，点了直接关面板回聊天', () => {
    const ro = stubResizeObserver()
    useShellStore.setState({ workPanelOpen: true })
    renderShell()

    // 794 − 240 − 480 = 74 < 面板下限 280 → 收窄也摆不开
    ro.fire(screen.getByTestId('shell-row'), 800)
    expect(spaceConstrained()).toBe(true)
    expect(screen.queryByTestId('workbench-restore-split')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('workbench-back-to-chat'))

    expect(useShellStore.getState().workPanelOpen).toBe(false)
    expect(spaceConstrained()).toBe(false)
    expect(screen.getByTestId('main-column')).not.toHaveClass('hidden')
    expect(screen.getByTestId('work-panel')).toHaveClass('w-0')
  })

  it('data-sidebar 跟随折叠状态（布局事实：卡内有没有 240 的二级栏；E2E/探针也读它）', () => {
    renderShell()

    expect(screen.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'expanded')

    fireEvent.click(screen.getByTestId('sidebar-toggle'))

    expect(screen.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed')
  })
})

/**
 * W7（D4=A）：窄窗自动降级**会话**二级栏。
 * 判据：内容卡宽 − 侧栏标称宽(240) < --chat-min-readable-width(480) ⇒ auto 收成 0（布局事实）；
 * 窗口变宽按用户偏好恢复。阈值换算：窗口宽 782 时内容卡 776 − 240 = 536，所以 < 782 才会触发；
 * 单测直接把行宽喂给壳行的 ResizeObserver（jsdom 没有布局）。
 */
describe('AppShell · W7（D4=A 窄窗自动降级会话二级栏）', () => {
  it('窄窗：自动收成 0（布局事实），用户偏好保持展开；窗口变宽自动恢复', () => {
    const ro = stubResizeObserver()
    renderShell()
    const row = screen.getByTestId('shell-row')

    // 700 行宽 → 内容卡 694；694 − 240 = 454 < 480 ⇒ 自动收起
    ro.fire(row, 700)

    const sidebar = screen.getByTestId('sidebar')
    expect(sidebar).toHaveClass('is-collapsed', 'w-0')
    expect(sidebar).not.toHaveClass('border-r')
    expect(sidebar).toHaveAttribute('inert')
    expect(screen.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed')
    // 开合钮显示真实布局态（自动收起 → "展开侧栏"）
    expect(screen.getByTestId('sidebar-toggle')).toHaveAccessibleName('展开侧栏')
    // 关键：这是布局事实，不是偏好 —— store 里的用户偏好仍是"展开"
    expect(useShellStore.getState().sidebarAutoCollapsed).toBe(true)
    expect(useShellStore.getState().sidebarCollapsed).toBe(false)

    // 1280 行宽 → 内容卡 1274；1274 − 240 = 1034 ≥ 480 ⇒ 解除自动收起，按偏好展开
    ro.fire(row, 1280)

    expect(screen.getByTestId('sidebar')).not.toHaveClass('is-collapsed')
    expect(screen.getByTestId('sidebar')).toHaveClass('w-(--sidebar-width)')
    expect(screen.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'expanded')
    expect(useShellStore.getState().sidebarAutoCollapsed).toBe(false)
    expect(useShellStore.getState().sidebarCollapsed).toBe(false)
  })

  it('阈值是实测的：720 触发、1280 不触发；刚好等于最小可读宽也不收（严格小于）', () => {
    const ro = stubResizeObserver()
    renderShell()
    const row = screen.getByTestId('shell-row')

    // 726 行宽 → 卡 720；720 − 240 = 480 = 最小可读宽 ⇒ 不收（严格小于才收）
    ro.fire(row, 726)
    expect(screen.getByTestId('sidebar')).not.toHaveClass('is-collapsed')

    // 725 → 卡 719；479 < 480 ⇒ 收
    ro.fire(row, 725)
    expect(screen.getByTestId('sidebar')).toHaveClass('is-collapsed')

    ro.fire(row, 1280)
    expect(screen.getByTestId('sidebar')).not.toHaveClass('is-collapsed')
  })

  it('手动态优先：用户手动收起后 auto 不再生效，宽窗也不会把侧栏自动展开', () => {
    const ro = stubResizeObserver()
    renderShell()
    const row = screen.getByTestId('shell-row')

    fireEvent.click(screen.getByTestId('sidebar-toggle'))
    expect(useShellStore.getState().sidebarCollapsed).toBe(true)
    // 用户手动收起后，窄窗 auto 不置位（优先级：手动收起 > auto）
    ro.fire(row, 700)
    expect(useShellStore.getState().sidebarAutoCollapsed).toBe(false)

    // 放宽：保持用户手动收起的状态（不自动展开）
    ro.fire(row, 1280)
    expect(useShellStore.getState().sidebarAutoCollapsed).toBe(false)
    expect(screen.getByTestId('sidebar')).toHaveClass('is-collapsed')
  })

  it('用户手动展开但空间不足：auto 折叠生效（auto 只压"手动展开"，不改偏好）', () => {
    const ro = stubResizeObserver()
    renderShell()
    const row = screen.getByTestId('shell-row')

    // 先在宽窗确认展开，再缩窄 → auto 折叠；偏好仍是展开
    ro.fire(row, 1280)
    expect(screen.getByTestId('sidebar')).not.toHaveClass('is-collapsed')

    ro.fire(row, 700)
    expect(useShellStore.getState().sidebarCollapsed).toBe(false)
    expect(useShellStore.getState().sidebarAutoCollapsed).toBe(true)
    expect(screen.getByTestId('sidebar')).toHaveClass('is-collapsed')

    // 再放宽 → 按偏好自动回来（不闪跳：判据只用标称侧栏宽，不读自己收起后的实际占宽）
    ro.fire(row, 1280)
    expect(screen.getByTestId('sidebar')).not.toHaveClass('is-collapsed')
  })

  it('设置页的栏目菜单不降级（它是操作入口，不是会话侧栏），窄窗仍可用', () => {
    const ro = stubResizeObserver()
    renderShell('/settings')

    ro.fire(screen.getByTestId('shell-row'), 700)

    expect(useShellStore.getState().sidebarAutoCollapsed).toBe(false)
    expect(screen.getByTestId('sidebar')).not.toHaveClass('is-collapsed')
    expect(screen.getByTestId('settings-nav')).toBeInTheDocument()
  })

  it('无二级栏模块不受影响：/notes 窄窗没有侧栏可收，auto 不置位', () => {
    const ro = stubResizeObserver()
    renderShell('/notes')

    ro.fire(screen.getByTestId('shell-row'), 700)

    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument()
    expect(useShellStore.getState().sidebarAutoCollapsed).toBe(false)
    expect(screen.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed')
  })

  it('与工作台空间判定不打架：自动收起释放的 240 计入 fit.safeLeft，放宽后恢复', () => {
    const ro = stubResizeObserver()
    useShellStore.setState({ workPanelOpen: true })
    renderShell()
    const row = screen.getByTestId('shell-row')

    ro.fire(row, 700)
    expect(useShellStore.getState().sidebarAutoCollapsed).toBe(true)
    expect(useShellStore.getState().workPanelFit?.safeLeft).toBe(0)

    ro.fire(row, 1280)
    expect(useShellStore.getState().sidebarAutoCollapsed).toBe(false)
    expect(useShellStore.getState().workPanelFit?.safeLeft).toBe(240)
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
    // round 59 的可见左缘偏移随覆盖层一同退休（侧栏已是卡内 flex 兄弟）
    expect(panel).not.toHaveClass('ml-(--content-safe-left)')
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

  it('面板开着时才有拖拽把手；关面板也走 store（全屏一并复位）', () => {
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

/** round 64（用户口径）：Ctrl+K / Cmd+K = 新建会话，挂在**壳**上（全局，与当前路由无关） */
describe('AppShell · round 64（Ctrl+K 新建会话）', () => {
  function LocationProbe(): React.JSX.Element {
    return <div data-testid="location">{useLocation().pathname}</div>
  }

  function renderShellWithProbe(path: string): void {
    render(
      <MemoryRouter initialEntries={[path]}>
        <AppShell />
        <LocationProbe />
      </MemoryRouter>
    )
  }

  beforeEach(() => {
    resetSessionsStore()
  })

  it('设置页按 Ctrl+K：开一个无项目草稿（activeId 落位）并回对话页', () => {
    renderShellWithProbe('/settings')
    expect(screen.getByTestId('settings-nav')).toBeInTheDocument()

    act(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    })

    expect(useSessionsStore.getState().activeId).not.toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })

  it('macOS 上按 Cmd+K（metaKey）走同一条路', () => {
    renderShellWithProbe('/plugins')

    act(() => {
      fireEvent.keyDown(window, { key: 'k', metaKey: true })
    })

    expect(useSessionsStore.getState().activeId).not.toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })

  it('别的键不新建（Ctrl+Shift+K / 普通 k；也不抢工作台的 Ctrl+Shift+E）', () => {
    renderShellWithProbe('/chat')

    act(() => {
      fireEvent.keyDown(window, { key: 'k' })
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true, shiftKey: true })
      fireEvent.keyDown(window, { key: 'e', ctrlKey: true, shiftKey: true })
    })

    expect(useSessionsStore.getState().activeId).toBeNull()
  })
})

describe('AppShell · M3-S5-2 退出确认挂载点', () => {
  afterEach(() => {
    clearKyclawBridge()
    resetOfficeQuitFlowForTest()
    resetOfficeTabsStore()
  })

  it('壳空闲时不渲染退出确认（没收到请求就没有 DOM）', () => {
    installKyclawBridge()
    renderShell('/chat')
    expect(screen.queryByTestId('office-quit-dialog')).not.toBeInTheDocument()
  })

  it('主进程推退出请求 → 壳上弹退出确认（/chat 也弹）；取消回 cancelled 并收起', async () => {
    const bridge = installKyclawBridge()
    let quitListener: ((payload: OfficeQuitRequestPayload) => void) | undefined
    bridge.office.onQuitRequest.mockImplementation((listener) => {
      quitListener = listener
      return () => undefined
    })
    renderShell('/chat')

    act(() => quitListener?.({ requestId: 'req-1', reason: 'quit', dirtyCount: 1 }))

    // 挂在壳上（不在 OfficePage）：聊天页/设置页触发退出也能看到保存确认
    expect(screen.getByTestId('office-quit-dialog')).toBeInTheDocument()
    expect(screen.getByText('退出前保存更改？')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('office-quit-cancel'))
    await waitFor(() =>
      expect(bridge.office.respondQuitRequest).toHaveBeenCalledWith({
        requestId: 'req-1',
        action: 'cancelled'
      })
    )
    expect(screen.queryByTestId('office-quit-dialog')).not.toBeInTheDocument()
  })
})
