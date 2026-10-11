/**
 * 应用入口：单实例锁 + 窗口 + 托盘 + 窗口 IPC + 内嵌 agent 服务。
 * 后台服务、设置等后续任务各自挂进来（T5 起），这里只做应用生命周期。
 *
 * T17 起多了两族接线：更新通道（updater.ts，源没配就是"什么都不做"的实例）与追踪通道
 * （telemetry，Langfuse 默认关）——两者都不挡窗口、失败只记日志。
 */
import { app } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { startAgentServer } from './agent/service'
import { registerAgentIpc } from './ipc/agent'
import { registerLocalModelsIpc, pushLocalModelsOverview } from './ipc/local-models'
import { registerMemoryIpc } from './ipc/memory'
import { registerPluginIpc } from './ipc/plugins'
import { registerProjectsIpc } from './ipc/projects'
import { registerSettingsIpc } from './ipc/settings'
import { registerTelemetryIpc } from './ipc/telemetry'
import { pushUpdateState, registerUpdatesIpc } from './ipc/updates'
import { registerWindowIpc } from './ipc/window'
import { registerWorkspaceIpc } from './ipc/workspace'
import { registerWorkbenchIpc } from './ipc/workbench'
import { createLocalModelService, type LocalModelService } from './llama/service'
import { probeConfiguredProvidersQuietly } from './model-probe'
import { pluginsDirs, sweepPluginResidue } from './plugins/store'
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
import { installWebviewGuard } from './webview'
import { resolveModel } from '../mastra/model'
import { EMBEDDING_KEY_SECRET_ID } from '../shared/memory'
import type { AgentEndpoint } from '../shared/ipc'

// R18：本地优先姿态 —— 关掉 Mastra 遥测（默认会往 PostHog 打点）。
// 必须在这里、在任何动态 import mastra 之前设置；main/index.ts 是应用最早的执行点。
process.env.MASTRA_TELEMETRY_DISABLED = 'true'

/** 任务栏归组/通知的 AppUserModelID：与 electron-builder.yml 的 appId 同值（NSIS 快捷方式写的也是它） */
const APP_USER_MODEL_ID = 'com.kkomia.kyclaw'

/**
 * 本机嵌入引擎的可执行文件位置（模块 3B）：
 *   - 打包后：`<resources>/llama/llama-server.exe`（electron-builder 的 extraResources 放的）；
 *   - 开发态：仓库的 `resources/llama/llama-server.exe`（先跑 `pnpm fetch:llama` 获取，见该脚本头注）。
 * 找不到时引擎起不来，只影响"本机引擎"这一路召回（失败只做加法，不拦对话）。
 */
function llamaBinaryPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'llama', 'llama-server.exe')
    : join(app.getAppPath(), 'resources', 'llama', 'llama-server.exe')
}

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
    // round 23：插件残骸清扫（*.trash-* 与没有主人的 git 市场目录）——异步尽力，不挡窗口；
    // 只动 plugins/ 下我们管理的目录，local 市场指向的用户目录绝不碰
    setImmediate(() => {
      try {
        const dirs = pluginsDirs(userDataDir)
        sweepPluginResidue({
          dirs,
          marketplaces: readSettings(settingsPath(userDataDir)).pluginMarketplaces
        })
      } catch (error) {
        console.warn('[kyclaw] 插件残骸清扫失败（不影响使用）', error)
      }
    })
    registerWorkspaceIpc(userDataDir, (threadId) => agentProjectIdOf?.(threadId) ?? null)
    // 工作台（右侧边栏四项工具）：文件树 / Git 用只读通道，终端是长会话（由一个服务持有 PTY）
    const workbench = registerWorkbenchIpc(userDataDir, {
      projectIdOf: (threadId) => agentProjectIdOf?.(threadId) ?? null
    })
    app.on('will-quit', () => {
      // 一个终端都不留（node-pty 不随主进程退出自动收：前台 shell 死了，它拉起的子进程还在）
      workbench.terminals.disposeAll()
    })
    // 内嵌浏览器的护栏（webview 的分区/window.open/右键菜单口径，进程级挂一次）
    installWebviewGuard()
    registerProjectsIpc(userDataDir)
    registerPluginIpc(userDataDir)
    registerAgentIpc(() => agentEndpoint)
    // 追踪通道（T17）：地址读 settings.json（与设置页写的是同一份），密钥在 secrets.json
    registerTelemetryIpc({
      dataDir: userDataDir,
      secretsFile,
      langfuseActive: () => agentTelemetry?.langfuse ?? false
    })
    // round 28：语义召回的远程嵌入密钥（写/清/状态；开关与来源走 settings:update）
    registerMemoryIpc({ secretsFile })
    // 模块 3B：本机嵌入引擎 + 本地模型（下载/删除/生效）。引擎按需启动（懒加载）：
    // 只有设置里来源选「本机引擎」且真用上时才会 spawn（见 llama/service.ts）。
    const pushLocalModels = (): void => {
      void localModels
        .overview()
        .then(pushLocalModelsOverview)
        .catch((error: unknown) => {
          console.warn('[kyclaw] 本地模型总览推送失败（界面下次打开会重新拉）', error)
        })
    }
    // onChange 只在动作发生之后被调（创建时不会触发），所以这里引用自身是安全的
    const localModels: LocalModelService = createLocalModelService({
      userDataDir,
      binaryPath: llamaBinaryPath(),
      // 空闲回收：现读设置（改完当场生效；0 = 不回收）
      idleMs: () => readSettings(settingsPath(userDataDir)).semanticRecall.idleMinutes * 60_000,
      onChange: pushLocalModels
    })
    registerLocalModelsIpc(localModels)
    app.on('will-quit', () => {
      void localModels.dispose().catch((error: unknown) => {
        console.warn('[kyclaw] 本机嵌入引擎收尾失败（进程会随应用退出一起结束）', error)
      })
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
      langfuse: () => readLangfuseConfig(userDataDir, secretsFile),
      // 语义召回（round 28）：设置现读、装配只做一次（改设置要重启生效）；远程 API Key 在
      // secrets.json 的保留槽位里，解出来的明文只进内存（不进日志、不回渲染端）
      semanticRecall: () => readSettings(settingsPath(userDataDir)).semanticRecall,
      embeddingKey: () => getProviderKey(secretsFile, EMBEDDING_KEY_SECRET_ID),
      // 模块 3B：本机引擎这一路（设置里来源选它时才会被调用）。返回 null = 还没有启用的本机模型；
      // 引擎起不来会抛（装配层把它翻成"这次运行没有召回"的人话，不拦对话）
      localEmbedding: () => localModels.embeddingEndpoint()
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
