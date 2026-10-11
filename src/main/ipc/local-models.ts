/**
 * 「本地模型」通道的 handler（模块 3B）：总览 + 下载/取消/删除/设为生效 + 选自定义 GGUF。
 *
 * 与其它通道同一套范式（先过 `parseIpcArgs` 入参闸门，动作都在主进程做），
 * 三个 3B 特有的口径：
 *   1. **自定义模型的路径只能从原生选择器进来**（同工作区/项目的纪律）：渲染端没有任何入参能递路径；
 *      选完先读 GGUF 头把门（不是 GGUF 就回人话），再落 `models/active.json`；
 *   2. **下载不等下完**：`download` 立刻回总览（600MB 级要几分钟），进度经 `progressChanged` 推；
 *   3. 状态是推的（与更新通道同一写法）：主进程每次变化广播一次总览，渲染端一挂载先拉一次。
 */
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC_CHANNELS, localModelIdArgsSchema, noArgsSchema, parseIpcArgs } from '../../shared/ipc'
import type { LocalModelsOverview } from '../../shared/local-models'
import type { LocalModelService } from '../llama/service'

/** 广播总览（窗口销毁竞态静默：这类推送只面向活着的渲染端） */
export function pushLocalModelsOverview(overview: LocalModelsOverview): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send(IPC_CHANNELS.localModels.progressChanged, overview)
  }
}

export function registerLocalModelsIpc(service: LocalModelService): void {
  // 变化就推：service 内部（下载进度、引擎起停、模型切换）都会回调到这里
  ipcMain.handle(IPC_CHANNELS.localModels.overview, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.localModels.overview)
    return service.overview()
  })

  ipcMain.handle(IPC_CHANNELS.localModels.download, async (_event, ...args) => {
    const [id] = parseIpcArgs(localModelIdArgsSchema, args, IPC_CHANNELS.localModels.download)
    // 不 await：下载是长事（进度走推送），这里立刻回一份当前总览
    void service.download(id).catch(() => undefined)
    return await service.overview()
  })

  ipcMain.handle(IPC_CHANNELS.localModels.cancel, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.localModels.cancel)
    service.cancel()
    return service.overview()
  })

  ipcMain.handle(IPC_CHANNELS.localModels.select, async (_event, ...args) => {
    const [id] = parseIpcArgs(localModelIdArgsSchema, args, IPC_CHANNELS.localModels.select)
    await service.select(id)
    return await service.overview()
  })

  ipcMain.handle(IPC_CHANNELS.localModels.remove, async (_event, ...args) => {
    const [id] = parseIpcArgs(localModelIdArgsSchema, args, IPC_CHANNELS.localModels.remove)
    await service.remove(id)
    return await service.overview()
  })

  ipcMain.handle(IPC_CHANNELS.localModels.pickCustom, async (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.localModels.pickCustom)
    const picked = await dialog.showOpenDialog({
      title: '选择本机嵌入模型',
      properties: ['openFile'],
      filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }]
    })
    const path = picked.canceled ? undefined : picked.filePaths[0]
    // 取消 = 什么都不做（照旧回当前总览）
    if (path !== undefined) await service.selectCustom(path)
    return await service.overview()
  })
}
