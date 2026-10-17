/**
 * 托盘：显示主窗口 / 退出（spec §2.1 应用生命周期里的"窗口 / 托盘 / 单实例锁"）。
 * 菜单文案是用户可见界面，用产品名 kyclaw。
 *
 * 0.1.3 托盘驻留：托盘还多担一件事——它是"关闭到托盘"唯一的找回入口，所以：
 *   - 给关闭策略注册**现问现答**的可用性探针（`isDestroyed()` 一起看：启动后托盘对象如果
 *     失效了，关闭立刻回到"照常关窗退出"，不会把窗口藏到一个没有入口的后台）；
 *   - 创建的任何异常都在 tray-setup.ts 里被收成 null，**不能把应用启动炸掉**。
 */
import { app, Tray } from 'electron'
import { showMainWindow } from './window'
import { trayMenuTemplate } from './tray-menu'
import { attachTray } from './tray-setup'
import { registerTrayAvailability } from './window-close'
import icon from '../../resources/icon.png?asset'

// 托盘必须留模块级引用：Tray 被 GC 掉图标就没了（同 BrowserWindow）
let tray: Tray | null = null

// 可用性探针（共享注册函数，免得 tray.ts 与 window.ts 互相 import 成环）：
// 现问现答，没有托盘 / 托盘对象已销毁 = 不可用 → 关闭策略放行（见 window-close.ts 的口径 2）
registerTrayAvailability(() => tray !== null && !tray.isDestroyed())

/** 建托盘（幂等）；返回 null = 这次没建起来（关闭策略会走"不可用"分支） */
export function createTray(): Tray | null {
  if (tray !== null && !tray.isDestroyed()) return tray

  tray = attachTray({
    create: () => new Tray(icon),
    tooltip: 'kyclaw',
    menu: trayMenuTemplate({
      show: () => void showMainWindow(),
      quit: () => app.quit()
    }),
    // Windows 上单击托盘图标 = 显示窗口（与系统里多数应用一致）
    onClick: () => void showMainWindow()
  })
  return tray
}
