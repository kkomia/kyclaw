/**
 * 应用入口：单实例锁 + 窗口 + 托盘 + 窗口 IPC + 内嵌 agent 服务。
 * 后台服务、设置等后续任务各自挂进来（T5 起），这里只做应用生命周期。
 *
 * T17 起多了两族接线：更新通道（updater.ts，源没配就是"什么都不做"的实例）与追踪通道
 * （telemetry，Langfuse 默认关）——两者都不挡窗口、失败只记日志。
 */
import { app } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { startAgentServer } from './agent/service'
import { registerAgentIpc } from './ipc/agent'
import { registerPluginIpc } from './ipc/plugins'
import { registerProjectsIpc } from './ipc/projects'
import { registerSettingsIpc } from './ipc/settings'
import { registerTelemetryIpc } from './ipc/telemetry'
import { pushUpdateState, registerUpdatesIpc } from './ipc/updates'
import { registerWindowIpc } from './ipc/window'
import { registerWorkspaceIpc } from './ipc/workspace'
import { probeConfiguredProvidersQuietly } from './model-probe'
import { getProviderKey, secretsPath } from './secrets'
import { readSettings, settingsPath } from './settings'
import { readLangfuseConfig } from './telemetry'
import {
  createInertUpdater,
  createKyclawUpdater,
  hasBundledUpdateConfig,
  UPDATE_URL_ENV
} from './updater'
import { createTray } from './tray'
import { showMainWindow } from './window'
import { resolveModel } from '../mastra/model'
import type { AgentEndpoint } from '../shared/ipc'

// R18：本地优先姿态 —— 关掉 Mastra 遥测（默认会往 PostHog 打点）。
// 必须在这里、在任何动态 import mastra 之前设置；main/index.ts 是应用最早的执行点。
process.env.MASTRA_TELEMETRY_DISABLED = 'true'

/** 任务栏归组/通知的 AppUserModelID：与 electron-builder.yml 的 appId 同值（NSIS 快捷方式写的也是它） */
const APP_USER_MODEL_ID = 'com.kkomia.kyclaw'

// 单实例：后起的实例不建窗口，直接把已运行的那个拉到前台（第二个实例自己退出）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  /** 内嵌服务当前对外暴露的端点；服务没起来（或起失败）保持 null，IPC 侧会抛错 */
  let agentEndpoint: AgentEndpoint | null = null

  /** 内嵌服务的追踪状态（T17）：服务没起来 = 没挂上导出 */
  let agentTelemetry: { langfuse: boolean } | null = null

  /**
   * round 15：会话 → 项目 id（`@` 文件列表的会话根解析用）。映射在 agent 服务的
   * session_projects 内存镜像里、服务是异步装好的 —— 所以先给晚绑定的取值器，装好后顶上；
   * 服务没起来时按"没有映射"回落（sessionRoots 的默认工作区/唯一目录兜底照常生效）。
   */
  let agentProjectIdOf: ((threadId: string) => string | null) | undefined

  app.whenReady().then(() => {
    // Windows 任务栏归组/通知：AUMID 与 electron-builder.yml 的 appId 一致
    electronApp.setAppUserModelId(APP_USER_MODEL_ID)

    // 开发期 F12 开关 DevTools、生产期屏蔽 Ctrl/Cmd+R
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    const userDataDir = app.getPath('userData')
    const secretsFile = secretsPath(userDataDir)

    registerWindowIpc()
    registerSettingsIpc(userDataDir)
    // round 22：启动时后台探一轮模型元数据（真实上下文长度/思考挡位；串行、静默、不挡窗口）
    void probeConfiguredProvidersQuietly({
      file: settingsPath(userDataDir),
      readKey: (providerId) => getProviderKey(secretsFile, providerId)
    })
    registerWorkspaceIpc(userDataDir, (threadId) => agentProjectIdOf?.(threadId) ?? null)
    registerProjectsIpc(userDataDir)
    registerPluginIpc(userDataDir)
    registerAgentIpc(() => agentEndpoint)
    // 追踪通道（T17）：地址读 settings.json（与设置页写的是同一份），密钥在 secrets.json
    registerTelemetryIpc({
      dataDir: userDataDir,
      secretsFile,
      langfuseActive: () => agentTelemetry?.langfuse ?? false
    })
    showMainWindow()
    createTray()

    // 更新通道（T17）：通道面立刻可用（渲染端一挂载就拉状态），装配是异步的（electron-updater 是
    // 动态 import）——装好后顶上并广播一次。没配更新源时就是个"什么都不做"的实例：
    // 不检查、不报错、不发网络请求（开发态与未配置的默认路径）。
    let updater = createInertUpdater(app.getVersion())
    registerUpdatesIpc(() => updater)
    void createKyclawUpdater({
      currentVersion: app.getVersion(),
      envUrl: process.env[UPDATE_URL_ENV],
      isPackaged: app.isPackaged,
      // 真发布时 electron-builder 会把 app-update.yml 写进 resources/；没有 = 没配源
      hasBundledConfig: hasBundledUpdateConfig(process.resourcesPath),
      onChange: pushUpdateState
    }).then((ready) => {
      updater = ready
      pushUpdateState(ready.state())
      // 启动检查：静默。结果只落在设置页的状态行里（没有弹窗、没有通知）
      void ready.check()
    })

    // 服务启动不挡窗口：先让壳起来，端点好了再挂上（渲染端要端点时会等它）
    startAgentServer({
      dataDir: userDataDir,
      // 每轮对话现读设置与密钥：设置页配好 provider 后下一轮就是真模型，不用重启；
      // 密钥从 safeStorage 解出来只经过主进程内存（模型构建那一下），不进日志、不回渲染端
      resolveModel: async () => {
        const providers = readSettings(settingsPath(userDataDir)).providers
        const resolved = await resolveModel(providers, (id) => getProviderKey(secretsFile, id))
        return resolved.model
      },
      // 追踪（T17）：启动时读一次——配齐了就挂 Langfuse 导出，改配置要重启应用才生效
      langfuse: () => readLangfuseConfig(userDataDir, secretsFile)
    })
      .then((handle) => {
        agentEndpoint = { baseUrl: handle.baseUrl, token: handle.token }
        agentTelemetry = handle.telemetry
        agentProjectIdOf = handle.projectIdOf
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
