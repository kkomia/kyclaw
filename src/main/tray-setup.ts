/**
 * 托盘的"全活"创建（0.1.3 托盘驻留，从 tray.ts 抽出来单测的那半）：真件（图标资源 + Tray 构造）
 * 只有在 electron 运行时里装得起来，所以这里只依赖**注入的构造器**与 electron 的 `Menu`
 * （单测 mock 掉 electron，见 main/__tests__/tray-setup.spec.ts）。
 *
 * 成败两种下场都必须是明确状态：
 *   - 成功 → 返回 Tray（调用方留引用；可用性由 tray.ts 注册的探针现问现答，见 window-close.ts）；
 *   - 任何一步抛（图标资源坏了、系统托盘起不来、Linux 没有状态通知宿主…）→ 销毁半成品、
 *     返回 null（托盘这次就是不可用 → 关闭窗口按"退出应用"走）。
 *
 * 为什么不做"失败就算了、其余照旧"：托盘是关闭到托盘这套行为**唯一**的找回入口——
 * 建不出来还把窗口藏起来，就是留下一个找不回来的后台进程（用户只能去任务管理器）。
 * 为什么整段共用一个 try：工具提示 / 菜单 / 单击任何一步没挂上，托盘就是个**半残入口**
 * （比如没有菜单 = 关到后台之后没有「退出 kyclaw」），按同一个标准失败更安全。
 */
import { Menu, type MenuItemConstructorOptions, type Tray } from 'electron'

export interface TraySetup {
  /** 真件是 `() => new Tray(icon)`（icon 由 tray.ts 传——`?asset` 导入单测解析不了） */
  create: () => Tray
  tooltip: string
  menu: MenuItemConstructorOptions[]
  onClick: () => void
}

/** 建托盘并挂全；失败退回 null（半成品会被销毁） */
export function attachTray(setup: TraySetup): Tray | null {
  let tray: Tray | null = null
  try {
    tray = setup.create()
    tray.setToolTip(setup.tooltip)
    tray.setContextMenu(Menu.buildFromTemplate(setup.menu))
    tray.on('click', setup.onClick)
    return tray
  } catch (error) {
    console.warn(
      '[kyclaw] 托盘创建失败：关闭窗口将按「退出应用」处理（不会藏到没有入口的后台）',
      error
    )
    try {
      tray?.destroy()
    } catch {
      // 半成品销毁失败没有可做的（进程退出时系统会一起收回）
    }
    return null
  }
}
