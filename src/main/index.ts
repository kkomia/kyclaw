/**
 * 应用入口：单实例锁 + 窗口 + 托盘 + 窗口 IPC + 内嵌 agent 服务。
 * 后台服务、设置等后续任务各自挂进来（T5 起），这里只做应用生命周期。
 */
import { app } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { startAgentServer } from './agent/service'
import { registerAgentIpc } from './ipc/agent'
import { registerSettingsIpc } from './ipc/settings'
import { registerWindowIpc } from './ipc/window'
import { registerWorkspaceIpc } from './ipc/workspace'
import { getProviderKey, secretsPath } from './secrets'
import { readSettings, settingsPath } from './settings'
import { createTray } from './tray'
import { showMainWindow } from './window'
import { resolveModel } from '../mastra/model'
import type { AgentEndpoint } from '../shared/ipc'

// R18：本地优先姿态 —— 关掉 Mastra 遥测（默认会往 PostHog 打点）。
// 必须在这里、在任何动态 import mastra 之前设置；main/index.ts 是应用最早的执行点。
process.env.MASTRA_TELEMETRY_DISABLED = 'true'

// 单实例：后起的实例不建窗口，直接把已运行的那个拉到前台（第二个实例自己退出）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  /** 内嵌服务当前对外暴露的端点；服务没起来（或起失败）保持 null，IPC 侧会抛错 */
  let agentEndpoint: AgentEndpoint | null = null

  app.whenReady().then(() => {
    // Windows 任务栏归组用
    electronApp.setAppUserModelId('com.electron')

    // 开发期 F12 开关 DevTools、生产期屏蔽 Ctrl/Cmd+R
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    const userDataDir = app.getPath('userData')
    const secretsFile = secretsPath(userDataDir)

    registerWindowIpc()
    registerSettingsIpc(userDataDir)
    registerWorkspaceIpc(userDataDir)
    registerAgentIpc(() => agentEndpoint)
    showMainWindow()
    createTray()

    // 服务启动不挡窗口：先让壳起来，端点好了再挂上（渲染端要端点时会等它）
    startAgentServer({
      dataDir: userDataDir,
      // 每轮对话现读设置与密钥：设置页配好 provider 后下一轮就是真模型，不用重启；
      // 密钥从 safeStorage 解出来只经过主进程内存（模型构建那一下），不进日志、不回渲染端
      resolveModel: async () => {
        const providers = readSettings(settingsPath(userDataDir)).providers
        const resolved = await resolveModel(providers, (id) => getProviderKey(secretsFile, id))
        return resolved.model
      }
    })
      .then((handle) => {
        agentEndpoint = { baseUrl: handle.baseUrl, token: handle.token }
        console.log(`[kyclaw] agent 服务已启动：${handle.baseUrl}`)
        if (is.dev) {
          console.log(`[kyclaw] agent token（仅开发期打印，便于 curl 本地联调）：${handle.token}`)
        }
        app.on('will-quit', () => {
          handle.stop().catch((error) => {
            console.error('[kyclaw] agent 服务关闭失败', error)
          })
        })
      })
      .catch((error) => {
        console.error('[kyclaw] agent 服务启动失败', error)
      })

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
