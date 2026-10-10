import { Copy, Minus, PanelLeftClose, PanelLeftOpen, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { IconButton } from '../ui/icon-button'

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

      {/* 中段留白即拖拽区 */}
      <div className="min-w-0 flex-1" />

      <div className="no-drag flex items-center gap-1">
        <IconButton
          data-testid="window-minimize"
          label="最小化"
          icon={<Minus />}
          className="border-transparent hover:bg-hover"
          onClick={() => window.kyclaw?.window.minimize()}
        />
        <IconButton
          data-testid="window-maximize"
          label={maximized ? '还原' : '最大化'}
          icon={maximized ? <Copy /> : <Square />}
          className="border-transparent hover:bg-hover"
          onClick={() => window.kyclaw?.window.maximize()}
        />
        <IconButton
          data-testid="window-close"
          label="关闭"
          icon={<X />}
          className="border-transparent hover:bg-danger hover:text-(--button-danger-fg)"
          onClick={() => window.kyclaw?.window.close()}
        />
      </div>
    </header>
  )
}
