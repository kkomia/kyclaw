import { Copy, Minus, PanelLeftClose, PanelLeftOpen, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { OtterMark } from '@renderer/features/brand/OtterMark'
import { IconButton } from '../ui/icon-button'
import { AppTabBar } from './AppTabBar'

/**
 * 顶栏 / 标题栏（spec §6.2：42px + 无边框窗口自绘窗控）。
 * 整条是拖拽区（drag-region），可点元素一律放进 no-drag 容器 —— 拖拽区会吞点击。
 * 窗控三键图标 18（IconButton 的 --icon-size-md），hover 铺 Fills-F1（--fill-hover）；
 * 关闭键 hover 铺 --Colors-Red（语义层 --danger）+ 危险前色。
 * 侧栏伸缩开关**不画外圈**（R2 D3，对照 Kimi 桌面实测截图：顶栏里的图标只有图标本身 + hover 底色），
 * 尺寸/位置与窗控一致（36 高、图标 18）。
 *
 * 工作台（◧）开关 **round 4 已从本组件搬走**（用户裁决 R2 concern ①："右侧边栏打开的是工作区，
 * 应该属于 chat 的内容，不应该放在顶栏"）—— 现在钉在内容卡右上角，见 AppShell。
 *
 * 2026-10-17（0.2.0 顶侧多标签页打样）：中段从"纯留白拖拽区"换成浏览器式**标签栏**（AppTabBar，
 * tabs + 末尾「＋」）。标签区 / 「＋」是 no-drag，标签栏内部末尾的留白仍是拖拽区 —— 所以
 * 「左 = 二级栏开合钮，中 = 标签栏，右 = 窗控」三段之间与标签右侧空白都能拖窗。
 * 标签栏常驻（跨路由可见），Ctrl+W / Ctrl+Tab 的键盘监听也挂在它上面。
 *
 * v2（用户 2026-10-17 看完布局后拍板）：二级栏开合钮**恒显**——不再按模块隐藏（笔记/知识库/Office
 * 里没有二级栏也保留这个位置），保证顶栏左端在切模块时一致；`showSidebarToggle` 门已删。
 */
export interface TitleBarProps {
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
}

/** 窗口最大化状态：挂载时问一次主进程，之后跟推送走。preload 缺失（浏览器里看渲染端）当 false。 */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    const api = window.kyclaw?.window
    if (!api) return

    let disposed = false
    void api.isMaximized().then((value) => {
      if (!disposed) setMaximized(value)
    })
    const unsubscribe = api.onStateChanged((state) => setMaximized(state.maximized))

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return maximized
}

export function TitleBar({ sidebarCollapsed, onToggleSidebar }: TitleBarProps): React.JSX.Element {
  const maximized = useMaximized()
  const pathname = useLocation().pathname
  /**
   * task-96 收口（一屏一只，Lead 口径）：
   *   - 对话页（/chat）：输入卡右上角状态海獭是唯一一只 → 顶栏品牌位隐藏；
   *   - 关于页（/settings/about）：关于页自己有 96 海獭 → 顶栏让位；
   *   - 其它非对话模块（Office/笔记/知识库/其它设置…）：顶栏品牌位 32 可见（这些页面没有输入卡海獭）。
   */
  const showOtterBrand =
    pathname !== '/chat' && pathname !== '/' && !pathname.startsWith('/settings/about')

  return (
    <header
      data-testid="titlebar"
      className="drag-region flex h-(--titlebar-height) shrink-0 items-center gap-2 px-2 select-none"
    >
      <div className="no-drag flex items-center">
        <IconButton
          data-testid="sidebar-toggle"
          label={sidebarCollapsed ? '展开侧栏' : '收起侧栏'}
          icon={sidebarCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          className="border-transparent hover:bg-hover"
          onClick={onToggleSidebar}
        />
      </div>

      {showOtterBrand ? (
        <span data-testid="titlebar-otter" className="no-drag flex items-center pl-1">
          <OtterMark size={32} variant="static" title="kyclaw" />
        </span>
      ) : null}

      <AppTabBar />

      <div className="no-drag flex items-center gap-1">
        <IconButton
          data-testid="window-minimize"
          label="最小化"
          icon={<Minus strokeWidth={1.5} />}
          iconClassName="size-(--icon-size-window-control)"
          className="border-transparent hover:bg-hover"
          onClick={() => window.kyclaw?.window.minimize()}
        />
        <IconButton
          data-testid="window-maximize"
          label={maximized ? '还原' : '最大化'}
          icon={maximized ? <Copy strokeWidth={1.5} /> : <Square strokeWidth={1.5} />}
          iconClassName="size-(--icon-size-window-control)"
          className="border-transparent hover:bg-hover"
          onClick={() => window.kyclaw?.window.maximize()}
        />
        <IconButton
          data-testid="window-close"
          label="关闭"
          icon={<X strokeWidth={1.5} />}
          iconClassName="size-(--icon-size-window-control)"
          className="border-transparent hover:bg-danger hover:text-(--button-danger-fg)"
          onClick={() => window.kyclaw?.window.close()}
        />
      </div>
    </header>
  )
}
