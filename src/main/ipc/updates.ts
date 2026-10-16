/**
 * 更新通道的 handler（IPC 契约的"服务端"）。
 * 与其他通道同一套范式：先过 `parseIpcArgs` 入参闸门，再动作。
 *
 * 状态是推的：更新器每次变化都经 `pushUpdateState` 广播给所有窗口（进度是连续事件）；
 * 窗口刚起来时先拉一次 `updates:state`（推送只对"已经在听的渲染端"有效）。
 * 更新器本身在主进程装配（main/index.ts：源解析 + app 版本 + electron-updater 动态加载），
 * 这里只管通道；装配是异步的，所以用取值函数拿"当前那个"（装好前是个不检查的占位实例）。
 */
import { BrowserWindow, ipcMain } from 'electron'
import {
  IPC_CHANNELS,
  noArgsSchema,
  parseIpcArgs,
  type BundledReleaseNotes,
  type UpdateState
} from '../../shared/ipc'
import type { KyclawUpdater } from '../updater'

/** 广播给所有窗口（窗口销毁竞态静默：这类推送只面向活着的渲染端） */
export function pushUpdateState(state: UpdateState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(IPC_CHANNELS.updates.stateChanged, state)
  }
}

/**
 * `readNotes` 由调用方注入（main/index.ts 给的是"按 app.getVersion() 读随包 md"的那个 reader）：
 * 这里不碰 electron 的 app，通道模块只负责入参闸门与转发（测试注入假 reader 就能验）。
 */
export function registerUpdatesIpc(
  current: () => KyclawUpdater,
  readNotes: () => BundledReleaseNotes
): void {
  ipcMain.handle(IPC_CHANNELS.updates.state, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.updates.state)
    return current().state()
  })

  // 本版本随包发行说明：无入参（**不接受任何路径/文件名**）、纯读盘、不发网络请求 ——
  // 断网 / 没配源 / 已是最新都能答（它跟更新器没有关系，所以不经过 current()）
  ipcMain.handle(IPC_CHANNELS.updates.releaseNotes, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.updates.releaseNotes)
    return readNotes()
  })

  // 手动检查：等到"检查"这一步落地再回包（下载在后台继续，进度走推送）
  ipcMain.handle(IPC_CHANNELS.updates.check, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.updates.check)
    return current().check()
  })

  ipcMain.handle(IPC_CHANNELS.updates.install, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.updates.install)
    current().install()
  })
}
