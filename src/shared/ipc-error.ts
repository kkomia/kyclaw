/**
 * B4 / PB-006：Electron IPC 错误「去壳」。
 *
 * `ipcMain.handle` 里抛出的错误到渲染端会被包一层：
 *   `Error invoking remote method 'agent:endpoint': Error: <原文>`
 * 内核启动失败的人话（错误码 / 退出码 / 日志路径）要**原样**进错误卡，不能顶着一串
 * IPC 前缀给用户看；这里只剥壳，不改写原文（原文仍完整保留）。
 */
const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/u

export function cleanIpcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(IPC_PREFIX, '')
}
