/**
 * 设置通道的 handler（IPC 契约的"服务端"）。
 * 与窗口通道同一套范式：先过 `parseIpcArgs` 入参闸门，再动作；
 * 区别是设置不作用在"发来消息的那个窗口"上，而是读写这个应用自己的 userData 目录
 * （目录在注册时传进来，测试用临时目录即可，不必 mock electron 的 app）。
 */
import { ipcMain } from 'electron'
import {
  IPC_CHANNELS,
  noArgsSchema,
  parseIpcArgs,
  settingsUpdateArgsSchema
} from '../../shared/ipc'
import { readSettings, settingsPath, updateSettings } from '../settings'

export function registerSettingsIpc(userDataDir: string): void {
  const file = settingsPath(userDataDir)

  ipcMain.handle(IPC_CHANNELS.settings.get, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.settings.get)
    return readSettings(file)
  })

  ipcMain.handle(IPC_CHANNELS.settings.update, (_event, ...args) => {
    const [patch] = parseIpcArgs(settingsUpdateArgsSchema, args, IPC_CHANNELS.settings.update)
    // 落盘失败会把错误抛回渲染端（updateSettings 不吞写失败）
    return updateSettings(file, patch)
  })
}
