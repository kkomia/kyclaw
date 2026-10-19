/**
 * 应用入口：单实例锁 + 窗口 + 托盘 + 窗口 IPC + 内嵌 agent 服务。
 * 后台服务、设置等后续任务各自挂进来（T5 起），这里只做应用生命周期。
 *
 * T17 起多了两族接线：更新通道（updater.ts，源没配就是"什么都不做"的实例）与追踪通道
 * （telemetry，Langfuse 默认关）——两者都不挡窗口、失败只记日志。
 */
import { app, autoUpdater, BrowserWindow, ipcMain, protocol, webContents } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { startAgentServer } from './agent/service'
import { registerAgentIpc } from './ipc/agent'
import { registerAttachmentsIpc } from './ipc/attachments'
import { registerKnowledgeIpc } from './ipc/knowledge'
import { registerLocalModelsIpc, pushLocalModelsOverview } from './ipc/local-models'
import { registerMemoryIpc } from './ipc/memory'
import { registerNotesIpc } from './ipc/notes'
import { registerOfficeIpc } from './ipc/office'
import { registerPluginIpc } from './ipc/plugins'
import { registerProjectsIpc } from './ipc/projects'
import { registerRulesIpc } from './ipc/rules'
import { registerSearchIpc } from './ipc/search'
import { registerSettingsIpc } from './ipc/settings'
import { registerTelemetryIpc } from './ipc/telemetry'
import { registerTranslateIpc } from './ipc/translate'
import { pushUpdateState, registerUpdatesIpc } from './ipc/updates'
import { registerWindowIpc } from './ipc/window'
import { registerWorkspaceIpc } from './ipc/workspace'
import { registerWorkbenchIpc } from './ipc/workbench'
import { isKernelPortEnabled } from './kernel/feature-flag'
import { defaultKernelRoot } from './kernel/kernel-layout'
import { KernelStartupError, kernelFailureText } from './kernel/kernel-startup'
import { ensureMcpHomePatch } from './kernel/mcp-profile'
import { createLocalModelService, type LocalModelService } from './llama/service'
import { probeConfiguredProvidersQuietly } from './model-probe'
import {
  createOfficeProtocolHandler,
  OFFICE_SCHEME,
  OFFICE_SCHEME_PRIVILEGES
} from './office-protocol'
import { pluginsDirs, sweepPluginResidue } from './plugins/store'
import { printPdf } from './print-pdf'
import { readBundledReleaseNotes } from './release-notes'
import { getProviderKey, secretsPath } from './secrets'
import { initializeDefaultWorkspace, readSettings, settingsPath } from './settings'
import { readLangfuseConfig } from './telemetry'
import {
  createInertUpdater,
  createKyclawUpdater,
  hasBundledUpdateConfig,
  readBundledUpdateUrl,
  resolveUpdateSource,
  UPDATE_URL_ENV
} from './updater'
import { createTray } from './tray'
import { applyThemeMode, currentResolvedTheme, showMainWindow } from './window'
import { isQuitting, markQuitting, registerCloseAllowGuard } from './window-close'
import { createOfficeQuitGuard, registerOfficeQuitIpc } from './office-quit'
import { installWebviewGuard } from './webview'
import { resolveModel } from './model'
import { killAllRunning } from './tools/exec'
import { EMBEDDING_KEY_SECRET_ID } from '../shared/memory'
import { SEARCH_KEY_SECRET_ID } from '../shared/search'
import { IPC_CHANNELS, type AgentEndpoint } from '../shared/ipc'

// R18：本地优先姿态 —— 关掉 Mastra 遥测（默认会往 PostHog 打点）。
// 必须在这里、在任何动态 import mastra 之前设置；main/index.ts 是应用最早的执行点。
process.env.MASTRA_TELEMETRY_DISABLED = 'true'

/**
 * M3-S1：`kyclaw-office://` 隔离面协议的 **privileged 注册**。
 *
 * Electron 硬要求：`protocol.registerSchemesAsPrivileged` 必须在本进程 ready 之前调用
 * （文档原话：after the ready event the API is no longer usable），所以放模块顶层；
 * 真正接资源的 `protocol.handle` 在 `app.whenReady()` 里、创建主窗口之前注册。
 * 协议只读 `out/renderer`，dev 形态下 iframe 走 Vite（同源，不经过这个协议）。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: OFFICE_SCHEME, privileges: OFFICE_SCHEME_PRIVILEGES }
])

/** 任务栏归组/通知的 AppUserModelID：与 electron-builder.yml 的 appId 同值（NSIS 快捷方式写的也是它） */
const APP_USER_MODEL_ID = 'com.kkomia.kyclaw'

/**
 * 冷启动打点（主进程一侧，round 73）。只记内存、只在"渲染端文档加载完"那一刻打两行，不改行为。
 *
 * 口径：
 *   - 时间点相对**本模块开始执行**（`MAIN_T0`，即 Electron 把主进程脚本跑起来的那一刻）；
 *   - `process.uptime()` 是"进程起来（Electron 自己启动）到本模块开始"的那一段 —— 打点里唯一
 *     能反映 Electron 自身启动成本的口子（窗口创建之后的可见性由渲染端的线接手）；
 *   - 两条线与渲染端那条（lib/startup-timing.ts，打的是 epoch ms）**按绝对时间对齐**：
 *     主进程给 `主进程时间原点`，渲染端给 `performance.timeOrigin`，两者之差就是"进程启动 →
 *     渲染端开始加载"这一段。
 *   - 只在 `did-finish-load`（渲染端文档加载完）打一次；报完就清，不常驻（不占内存、不重复刷）。
 */
const MAIN_T0 = Date.now()
const ELECTRON_BOOT_MS = Math.round(process.uptime() * 1000)
const mainMarks: string[] = []
/** 汇总行打过了没有 —— 报过之后才到的打点单出"续"行（agent 服务就绪一定晚于渲染端文档加载） */
let mainStartupReported = false

function mainMark(name: string): void {
  const at = Date.now() - MAIN_T0
  mainMarks.push(`${name} ${at}ms`)
  if (mainStartupReported) {
    console.info(`[kyclaw] 启动分解（主进程·续）: ${name} 距本模块开始 ${at}ms`)
  }
}

function reportMainStartup(): void {
  console.info(
    `[kyclaw] 启动分解（主进程）: Electron 自身启动到本模块 ${ELECTRON_BOOT_MS}ms · ${mainMarks.join(' · ')}`
  )
  console.info(`[kyclaw] 主进程时间原点（epoch ms，与渲染端那条线对齐用）: ${MAIN_T0}`)
  mainMarks.length = 0
  mainStartupReported = true
}

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

/**
 * 内置技能根目录（round 64）：
 *   - 打包后：`<resources>/skills`（electron-builder.yml 的 extraResources 放的 office 四件套）；
 *   - 开发态：仓库的 `resources/skills`（改完技能文件不用重新打包，下一轮对话就是新的）。
 * 找不到 = 没有内置技能（只剩插件技能），不影响其它功能。
 */
function builtinSkillsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills')
}

// 单实例：后起的实例不建窗口，直接把已运行的那个拉到前台（第二个实例自己退出）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  /**
   * M3-S5：退出确认 guard（纯状态机在 office-quit.ts）。
   *
   * 两个入口都接它：`app.on('before-quit', quitGuard.handleBeforeQuit)`（托盘退出 / app.quit /
   * 窗口关完后的第二次进入）与 window-close 的 allow 分支守卫（点 X 且偏好 quit / 托盘不可用；
   * 那条路上 renderer 在 before-quit 之前就没了，必须在关窗前问）。托盘隐藏分支不接：
   * 窗口不销毁，内容还在内存里。
   *
   * 在这里创建（`whenReady` 之前）：只捕获依赖、不碰窗口对象；窗口按 owner 的 webContents
   * 现找，窗口重建后也不会指向已销毁实例。
   */
  const quitGuard = createOfficeQuitGuard({
    // 只发给**最后一次上报脏计数**的那个 webContents（owner 校验）；找不到 = 拿不到壳 → 按取消
    sendToWindow: (ownerId, payload) => {
      const contents = webContents.fromId(ownerId)
      if (contents === undefined || contents.isDestroyed()) return false
      contents.send(IPC_CHANNELS.office.quitRequest, payload)
      return true
    },
    quit: () => app.quit(),
    // close 入口：mark 已置（下一次 close 直接 allow），这里只补"真的再关一次"。
    // 窗口按 owner 的 webContents 现找：不持窗口引用，避免窗口重建后指向已销毁实例。
    closeWindow: (ownerId) => {
      const contents = webContents.fromId(ownerId)
      const win = contents === undefined ? null : BrowserWindow.fromWebContents(contents)
      if (win === null || win.isDestroyed()) return
      win.close()
    },
    markQuitting,
    isQuitting,
    /**
     * Lead 决策（2026-10-17）：退出确认框要**等用户做决定**，5s 太短（用户慢慢看/点就超时=取消，
     * 体验成"点了退出却白点一次"）。这里放宽到 60s；超时仍按取消处理（应用保持打开）。
     * 纯状态机的默认值保持 5s 不变，单测不受影响。
     */
    askTimeoutMs: 60_000
  })

  /** 内嵌服务当前对外暴露的端点；服务没起来（或起失败）保持 null，IPC 侧会抛错 */
  let agentEndpoint: AgentEndpoint | null = null

  /**
   * B4 / 验收④：内核（或整个 agent 服务）起不来时的**可诊断文案**。
   * `agent:endpoint` 在服务就绪前会轮询；一旦这里已有值就立刻抛该文案（不用干等 8s），
   * 渲染端现有的错误卡对中文错误原样显示 —— 用户能看到「哪一步失败 + 错误码 + 退出码 + 日志路径」。
   */
  let agentStartupError: string | null = null

  /** 内嵌服务的追踪状态（T17）：服务没起来 = 没挂上导出 */
  let agentTelemetry: { langfuse: boolean } | null = null
  let agentRulesRegistered = false

  /**
   * round 15：会话 → 项目 id（`@` 文件列表的会话根解析用）。映射在 agent 服务的
   * session_projects 内存镜像里、服务是异步装好的 —— 所以先给晚绑定的取值器，装好后顶上；
   * 服务没起来时按"没有映射"回落（sessionRoots 的默认工作区/唯一目录兜底照常生效）。
   */
  let agentProjectIdOf: ((threadId: string) => string | null) | undefined

  app.whenReady().then(() => {
    // round 73：冷启动打点 —— app ready（Electron 与我们的模块都已就位，从这里开始建窗口）
    mainMark('app ready')
    // Windows 任务栏归组/通知：AUMID 与 electron-builder.yml 的 appId 一致
    electronApp.setAppUserModelId(APP_USER_MODEL_ID)

    // 开发期 F12 开关 DevTools、生产期屏蔽 Ctrl/Cmd+R
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    const userDataDir = app.getPath('userData')
    const secretsFile = secretsPath(userDataDir)
    /**
     * B4 / PB-006：内核启动参数（**只在 flag 开时注入**；flag 关不解析路径、不建目录、行为不变）。
     *   - electronExecutable：安装版 = process.execPath（Electron-as-node 跑内核入口）；
     *   - asarPath：内核根 —— 打包态 process.resourcesPath/kernel（extraResources 落的），
     *     开发态 app.getAppPath()/resources/kernel（`pnpm fetch:kernel` 落的），
     *     KYCLAW_KERNEL_ROOT 可覆盖（故障演练/排查）；
     *   - dshHome：userData/dsh-home —— 内核数据不落仓库、不落安装目录（验收②）；
     *   - logFile：userData/logs/kernel.log —— 启动失败可诊断（验收④）。
     */
    const kernelEnabled = isKernelPortEnabled()
    const kernelRoot = kernelEnabled
      ? defaultKernelRoot({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
          env: process.env
        })
      : ''
    const kernelLogFile = join(userDataDir, 'logs', 'kernel.log')
    /** 内核的隔离 home（PB-006 验收②；MCP home patch 也落这里，两处必须同一个路径） */
    const kernelDshHome = join(userDataDir, 'dsh-home')
    /**
     * PB-023：MCP 改走 DSH 内核插件 —— 内核启动前把应用设置里的 `mcpServers` 写成
     * `$DSH_HOME/cordis.patch.yml`（home patch；每个 enabled 的 server 一条 `@deepseek-ai/dsh-mcp-client`）。
     * 语义：**改配置后需重启应用生效**（内核在 boot 时读 patch，没有 host 侧 reload 接口）。
     * 写失败不挡内核启动：MCP 是加法能力，错误只记日志（内核日志/控制台）。
     */
    if (kernelEnabled) {
      try {
        const mcpPatch = ensureMcpHomePatch(
          kernelDshHome,
          readSettings(settingsPath(userDataDir)).mcpServers
        )
        if (mcpPatch.changed) {
          console.info(
            `[kyclaw] MCP 配置已写入内核 patch：${mcpPatch.file}（启用 ${String(mcpPatch.included.length)} 个 server）`
          )
        }
        if (mcpPatch.skipped.length > 0) {
          console.warn('[kyclaw] MCP 配置有跳过项（未写入内核 patch）', mcpPatch.skipped)
        }
      } catch (error) {
        console.warn(
          '[kyclaw] MCP 配置写入内核 patch 失败（MCP 本次不可用，不影响其它功能）',
          error
        )
      }
    }
    // 首轮设置/工作区 IPC 读取前补齐一次默认工作区；失败只记日志，不挡窗口启动。
    initializeDefaultWorkspace(userDataDir, app.getPath('home'))

    registerWindowIpc()
    // round 63：更新源写进设置后要当场生效，所以设置通道带一个回调（更新器本身是异步装配的，
    // 这里晚绑定取"当前那个"——回调只在渲染端保存设置时触发，那时下面的 updater 早就装配好了）
    registerSettingsIpc(userDataDir, {
      onUpdateUrlSaved: () => updater.reconfigure(),
      // 主题改完同步 nativeTheme 与窗口底色
      onThemeSaved: applyThemeMode,
      effectiveTheme: currentResolvedTheme
    })
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
    // M3-S2：Office 文档注册表（选择器 / 会话打开 / 按 id 读字节 / 释放）。
    // 注册表只存元数据（不存文档内容）；webContents 销毁时由 handler 自己 releaseAll。
    registerOfficeIpc(userDataDir, {
      projectIdOf: (threadId) => agentProjectIdOf?.(threadId) ?? null
    })
    // M3-S5：退出确认的两条主进程入口接线（状态机见 office-quit.ts 文件头）：
    //   1) 两条 invoke 通道：壳上报脏计数 / 壳回退出确认结果；
    //   2) 窗口 close 的 **allow 分支**守卫（点 X 且偏好 quit / 托盘不可用那条路；
    //      hide 收进托盘的路径不问壳，见 window-close.ts 的 registerCloseAllowGuard 注释）。
    // before-quit 的监听在 `whenReady` 之外统一挂（见文件末尾），保持原来的注册时机。
    registerOfficeQuitIpc(quitGuard, ipcMain)
    registerCloseAllowGuard((event) => quitGuard.guardCloseAllow(event))
    // 工作台（右侧边栏四项工具）：文件树 / Git 用只读通道，终端是长会话（由一个服务持有 PTY）
    const workbench = registerWorkbenchIpc(userDataDir, {
      projectIdOf: (threadId) => agentProjectIdOf?.(threadId) ?? null
    })
    app.on('will-quit', () => {
      // 一个终端都不留（node-pty 不随主进程退出自动收：前台 shell 死了，它拉起的子进程还在）
      workbench.terminals.disposeAll()
      // 在途的办公档转换同样不留：kit 子进程不随主进程退出（杀法是同步发起的，见 handles 的说明）
      workbench.disposeOfficePreview()
      // round 72：在途的 bash 命令同样不留 —— Windows 上子进程不随父进程退出而终止，
      // 一个正在跑的 `sleep 600` / 构建 / 长下载会变成孤儿。账本只记我们自己拉起的那些
      // （见 exec.ts 的 running），用户自己在终端里跑的进程不在里面。
      const killed = killAllRunning()
      if (killed > 0) console.log(`[kyclaw] 退出清账：已终止 ${killed} 个在途命令`)
    })
    // 内嵌浏览器的护栏（webview 的分区/window.open/右键菜单口径，进程级挂一次）
    installWebviewGuard()
    registerProjectsIpc(userDataDir)
    // M5：笔记 / 知识库（本地优先；数据在 userData/notes、userData/knowledge，全在本机）
    registerNotesIpc(userDataDir)
    registerKnowledgeIpc(userDataDir)
    registerRulesIpc(userDataDir, { processorRegistered: () => agentRulesRegistered })
    // round 64：内置技能目录由这一层算（要 app），插件页总览与 agent 侧共用同一个路径
    registerPluginIpc(userDataDir, { builtinSkillsDir: builtinSkillsDir() })
    registerAgentIpc(
      () => agentEndpoint,
      {},
      () => agentStartupError
    )
    // 模块 2：附件（PDF 文字层抽取在主进程跑，渲染端零新依赖）
    registerAttachmentsIpc()
    // 追踪通道（T17）：地址读 settings.json（与设置页写的是同一份），密钥在 secrets.json
    registerTelemetryIpc({
      dataDir: userDataDir,
      secretsFile,
      langfuseActive: () => agentTelemetry?.langfuse ?? false
    })
    // round 28：语义召回的远程嵌入密钥（写/清/状态；开关与来源走 settings:update）
    registerMemoryIpc({ secretsFile })
    // round 32：思考翻译（翻译一段思考文本 + 可选密钥）。服务地址/模型/目标语言走 settings:update，
    // 密钥与 provider 同一套 safeStorage 槽位；请求只在主进程发（渲染端有 CSP，也不该拿密钥）
    registerTranslateIpc(userDataDir)
    // round 45：联网搜索的三个可选 Key（Exa / Tavily / Jina）——写/清/状态，与 provider 密钥同一套纪律
    registerSearchIpc(userDataDir)
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
    // round 73：冷启动打点 —— IPC 通道注册完（窗口在这之前一直没建：这些注册都在关键路径上）
    mainMark('IPC 通道注册完')
    // M3-S1：隔离面资源服务（`kyclaw-office://surface/…` → out/renderer 下的真实文件）。
    // 必须在创建主窗口之前注册：主窗口一出来渲染端就可能挂 iframe 请求资源。
    // 根目录表达式与 window.ts 的 loadFile(join(__dirname,'../renderer/index.html')) 同源；
    // 打包态 __dirname 在 app.asar/out/main，fs 直读 asar 内文件是支持的。
    protocol.handle(
      OFFICE_SCHEME,
      createOfficeProtocolHandler({ rootDir: join(__dirname, '../renderer') })
    )
    const mainWindow = showMainWindow()
    // round 73：冷启动打点 —— 窗口建好并开始加载渲染端；之后的"可见 / 文档加载完"挂在这个窗口上
    mainMark('窗口已创建')
    mainWindow.once('ready-to-show', () => mainMark('窗口可见'))
    mainWindow.webContents.once('did-finish-load', () => {
      mainMark('渲染端文档加载完')
      reportMainStartup()
    })
    // 托盘：win/linux「关闭到托盘」的入口（建失败会走"不可用"分支——关窗照常退出，见 tray.ts）
    // KYCLAW_DISABLE_TRAY=1（隔离探针 / 排查用）= 本次运行不建托盘：与"托盘建失败"走同一条
    // 回退路径（关闭窗口即退出），用于在真 Electron 里验证"藏不住"的那半边
    if (process.env.KYCLAW_DISABLE_TRAY !== '1') createTray()

    // 更新通道（T17 / round 63）：通道面立刻可用（渲染端一挂载就拉状态），装配是异步的
    // （electron-updater 是动态 import）——装好后顶上并广播一次。源现算（环境变量 > 设置里的更新源 >
    // 打包内 app-update.yml > 没配），所以设置里改完当场生效、不用重启（见上面 registerSettingsIpc
    // 的 onUpdateUrlSaved）；没配源的路径就是个"什么都不做"的实例：不检查、不报错、不发网络请求。
    let updater = createInertUpdater(app.getVersion())
    // 本版本随包发行说明（本轮）：按 app.getVersion() 读那一个文件（打包态 resources/release-notes/、
    // 开发态仓库 build/release-notes/）——「关于」栏的「更新日志」入口用它，断网/已是最新也能看
    registerUpdatesIpc(
      () => updater,
      () =>
        readBundledReleaseNotes({
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          appPath: app.getAppPath(),
          version: app.getVersion()
        })
    )
    // 打包内源的地址：只有两个用处——界面占位提示、切回内置源时把 feed 显式设回去（见 main/updater.ts）
    const builtinUrl = readBundledUpdateUrl(process.resourcesPath)
    void createKyclawUpdater({
      currentVersion: app.getVersion(),
      resolveSource: () =>
        resolveUpdateSource({
          envUrl: process.env[UPDATE_URL_ENV],
          settingsUrl: readSettings(settingsPath(userDataDir)).updateUrl,
          isPackaged: app.isPackaged,
          // 真发布时 electron-builder 会把 app-update.yml 写进 resources/；没有 = 没配源
          hasBundledConfig: hasBundledUpdateConfig(process.resourcesPath)
        }),
      builtinUrl,
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
      localEmbedding: () => localModels.embeddingEndpoint(),
      // 模块 4：产出物的 PDF 导出（工具层不 import electron，真实现只能在主进程这一侧给；
      // 隐窗 + printToPDF 见 main/print-pdf.ts）
      printPdf,
      // round 45：联网搜索（现读设置 + 两个可选 Key）。自定义 Key 按当前服务商取；
      // Jina Key 与搜索链无关，只给 fetch 的阅读模式。明文只进内存，不回渲染端、不进日志。
      webSearch: () => {
        const settings = readSettings(settingsPath(userDataDir)).webSearch
        return {
          settings,
          searchKey: getProviderKey(secretsFile, SEARCH_KEY_SECRET_ID[settings.provider]),
          readerKey: getProviderKey(secretsFile, SEARCH_KEY_SECRET_ID.jina)
        }
      },
      // round 64：内置技能目录（office 四件套）——agent 侧的技能清单与 use_skill 读的就是它
      builtinSkillsDir: builtinSkillsDir(),
      // B4 / PB-006：内核迁移的真机注入（flag 关时整个字段不传，旧路径一行不变）。
      // 内核根/DSH_HOME/日志落点全在这一处定；失败时 bootstrap 写 kernel.log 并抛带 code 的错误。
      ...(kernelEnabled
        ? {
            kernel: {
              electronExecutable: process.execPath,
              asarPath: kernelRoot,
              dshHome: kernelDshHome,
              logFile: kernelLogFile
            }
          }
        : {})
    })
      .then((handle) => {
        agentEndpoint = { baseUrl: handle.baseUrl, token: handle.token }
        agentStartupError = null
        agentTelemetry = handle.telemetry
        agentRulesRegistered = handle.rules.processorRegistered
        agentProjectIdOf = handle.projectIdOf
        // round 73：冷启动打点 —— **渲染端"可输入"就卡在这一刻之后**：端点没就绪，对话页一直停在
        // 「正在连接…」；就绪之后还要再等两次 HTTP（会话列表 + 历史回灌）。这一笔单出一行。
        mainMark('agent 服务就绪')
        console.log(`[kyclaw] agent 服务已启动：${handle.baseUrl}`)
        if (is.dev) {
          console.log(`[kyclaw] agent token（仅开发期打印，便于 curl 本地联调）：${handle.token}`)
        }
        app.on('will-quit', () => {
          agentRulesRegistered = false
          handle.stop().catch((error) => {
            console.error('[kyclaw] agent 服务关闭失败', error)
          })
        })
      })
      .catch((error) => {
        agentRulesRegistered = false
        // 验收④：内核启动失败 = 用户可见的可诊断错误（错误码/原因/退出码 + 日志路径）。
        // 非内核类失败（端口/装配）用通用文案，别把 kernel.log 说成它们的日志。
        agentStartupError =
          error instanceof KernelStartupError
            ? kernelFailureText(error, kernelLogFile)
            : `agent 服务启动失败：${error instanceof Error ? error.message : String(error)}`
        console.error('[kyclaw] agent 服务启动失败：', agentStartupError)
      })

    app.on('activate', () => {
      showMainWindow()
    })
  })

  // M3-S5：`before-quit` 不再直接立"正在退出"标记 —— 先过 exit guard：
  //   有未保存文档且还没决定 → preventDefault 并向壳发 `office:quit-request`（用户选取消时窗口留着）；
  //   脏计数为 0 或壳已回 saved/discarded → guard 内部才调 markQuitting（窗口 close 见到一律放行）。
  // 这正是原注释的硬口径"只有真退出事件才立标记"：标记是单向的，绝不能提前立
  // （提前立会让用户取消后，之后的点 X 绕过托盘策略）。顺序与唯一调用点见 office-quit.ts。
  app.on('before-quit', quitGuard.handleBeforeQuit)

  /**
   * 更新安装（quitAndInstall）那一路单独接一个真事件。
   *
   * 依据（本机已核对，不是推测）：
   *   - Electron 文档（electron.d.ts）：原生 `autoUpdater.quitAndInstall()` "会先关掉所有窗口，
   *     再自动 `app.quit()`"，所以那条路上 `before-quit` 晚于窗口 close——只听 before-quit 会把
   *     安装触发的那次关窗收进托盘、把安装卡住；文档同时指明这种时候要听 `before-quit-for-update`。
   *   - electron-updater 6.8.9（node_modules/electron-updater/out/BaseUpdater.js 的 quitAndInstall）：
   *     只有 **安装真的启动成功**（`install()` 返回 true）才走
   *     `setImmediate(() => { require('electron').autoUpdater.emit('before-quit-for-update'); app.quit() })`；
   *     失败 / 已经在装（`quitAndInstallCalled`）/ 没有更新包时**什么都不发、也不退出**。
   * 所以在**发事件的那个对象**（Electron 原生 autoUpdater）上接：它只在"更新即将退出"这一刻发，
   * 安装失败或重复安装不会发，标记不会被提前立起来。
   * 平台兜底：这个对象在个别平台可能缺席，缺了就跳过（那一路本来也没有更新可用）——不拿启动去赌。
   */
  autoUpdater?.on('before-quit-for-update', markQuitting)

  // 关完窗口即退出（Windows/Linux 口径）；macOS 停留在 Dock，等 activate 再起窗。
  // 托盘驻留不冲突：win/linux 上窗口"关闭"会被收成隐藏（window-close.ts），根本走不到这里；
  // 真的走到这里只有两种情形——正在退出，或托盘不可用（那本来就该关窗退出）
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
