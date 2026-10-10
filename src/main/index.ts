/**
 * 应用入口：单实例锁 + 窗口 + 托盘 + 窗口 IPC。
 * 后台服务、设置等后续任务各自挂进来（T5 起），这里只做应用生命周期。
 */
import { app } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { registerSettingsIpc } from './ipc/settings'
import { registerWindowIpc } from './ipc/window'
import { createTray } from './tray'
import { showMainWindow } from './window'

// 单实例：后起的实例不建窗口，直接把已运行的那个拉到前台（第二个实例自己退出）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(() => {
    // Windows 任务栏归组用
    electronApp.setAppUserModelId('com.electron')

    // 开发期 F12 开关 DevTools、生产期屏蔽 Ctrl/Cmd+R
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    registerWindowIpc()
    registerSettingsIpc(app.getPath('userData'))
    showMainWindow()
    createTray()

    app.on('activate', () => {
      showMainWindow()
    })
  })

  // 关完窗口即退出（Windows/Linux 口径）；macOS 停留在 Dock，等 activate 再起窗
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
