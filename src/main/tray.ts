/**
 * 托盘：显示主窗口 / 退出（spec §2.1 应用生命周期里的"窗口 / 托盘 / 单实例锁"）。
 * 菜单文案是用户可见界面，用产品名 kyclaw。
 */
import { app, Menu, Tray } from 'electron'
import { showMainWindow } from './window'
import icon from '../../resources/icon.png?asset'

// 托盘必须留模块级引用：Tray 被 GC 掉图标就没了（同 BrowserWindow）
let tray: Tray | null = null

export function createTray(): void {
  if (tray) return

  tray = new Tray(icon)
  tray.setToolTip('kyclaw')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => void showMainWindow() },
      { type: 'separator' },
      { label: '退出 kyclaw', click: () => app.quit() }
    ])
  )
  // Windows 上单击托盘图标 = 显示窗口（与系统里多数应用一致）
  tray.on('click', () => void showMainWindow())
}
