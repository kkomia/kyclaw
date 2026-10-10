/**
 * 窗口控制通道的 handler（IPC 契约的"服务端"）。
 * 每个 handler 先过 `parseIpcArgs` 入参闸门，再作用于**发来消息的那个窗口**
 * （用 BrowserWindow.fromWebContents 取，多窗口时不会误控别人的窗口）。
 * 窗口已销毁的竞态一律静默无操作：这类调用只可能来自正在关闭的渲染端。
 */
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC_CHANNELS, noArgsSchema, parseIpcArgs } from '../../shared/ipc'

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerWindowIpc(): void {
  ipcMain.handle(IPC_CHANNELS.window.minimize, (event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.window.minimize)
    senderWindow(event)?.minimize()
  })

  ipcMain.handle(IPC_CHANNELS.window.maximize, (event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.window.maximize)
    const win = senderWindow(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  ipcMain.handle(IPC_CHANNELS.window.close, (event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.window.close)
    senderWindow(event)?.close()
  })

  ipcMain.handle(IPC_CHANNELS.window.isMaximized, (event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.window.isMaximized)
    return senderWindow(event)?.isMaximized() ?? false
  })
}
