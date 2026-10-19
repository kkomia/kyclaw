/**
 * PB-038：应用级控制通道的 handler（目前只有「重启应用」）。
 *
 * 为什么需要这一条：内核启动失败时，renderer 上原来那个「再跑一次」只重新问一次
 * `agent:endpoint`——而主进程 `agentStartupError` 只在成功启动时清空、`startAgentServer` 只调一次
 * （见 `src/main/index.ts`），所以按钮**永远救不回来**。PB-038 的选择是「重启应用」：
 * 真的 `app.relaunch()` + `app.quit()`。
 *
 * 两条纪律：
 * 1. **不绕过退出守卫**：有未保存的 Office 文档（`quitGuard.dirtyCount() > 0`）→ 直接回
 *    `{ok:false, reason:'unsaved-documents'}`，让 UI 告诉用户先保存；绝不强退（用户数据优先）。
 * 2. **有回包**：失败必须让 UI 知道"没有重启"，不能 fire-and-forget 制造假承诺。
 */
import { app, ipcMain } from 'electron'
import { IPC_CHANNELS, noArgsSchema, parseIpcArgs, type AppRelaunchResult } from '../../shared/ipc'

export interface AppControlDeps {
  /** 当前未保存的 Office 文档数（来自 quitGuard；> 0 时拒绝重启） */
  dirtyCount: () => number
  /** 测试注入：默认 `app.relaunch` */
  relaunch?: () => void
  /** 测试注入：默认 `app.quit` */
  quit?: () => void
}

export function registerAppControlIpc(deps: AppControlDeps): void {
  const relaunch = deps.relaunch ?? (() => app.relaunch())
  const quit = deps.quit ?? (() => app.quit())
  ipcMain.handle(IPC_CHANNELS.app.relaunch, (_event, ...args): AppRelaunchResult => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.app.relaunch)
    if (deps.dirtyCount() > 0) return { ok: false, reason: 'unsaved-documents' }
    try {
      relaunch()
      quit()
      return { ok: true }
    } catch (error) {
      console.warn('[kyclaw] 重启应用失败', error)
      return { ok: false, reason: 'relaunch-failed' }
    }
  })
}
