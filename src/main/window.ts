/**
 * 主窗口：无边框（frame: false，窗控由标题栏自绘）+ 几何/最大化落盘（main/store.ts）。
 *
 * 防白闪三道：`backgroundColor` 按 nativeTheme（已对齐落盘主题）取 #fbfaf9 / #181817
 * （与 --Bg-GroundPC 同值）；show: false + ready-to-show 保证首帧之前底色已是画布色；
 * 渲染端 HTML 壳再先画启动画面（index.html），React 提交后才淡出。
 *
 * 关闭行为（0.1.3 托盘驻留）：Windows / Linux 按三档偏好（settings 的 `closeToTrayMode`）处理：
 *   - `ask`（默认）→ 弹原生三选一（最小化到托盘 / 退出 kyclaw / 取消；带「记住我的选择」复选框，
 *     只有明确选 tray/quit 且勾选才把偏好落盘）；
 *   - `tray` → 收进托盘（窗口与 webContents 都留着，后台任务继续跑，从托盘菜单 / 托盘单击 /
 *     再起一次应用都能找回）；
 *   - `quit` → 放行正常关闭（window-all-closed 退出应用）。
 * 判定与执行在 window-close.ts，这里只做接线（弹窗、hide、落偏好）。
 * 真退出一律放行，标记只由**真事件**立（window-close.ts 的口径 1）：
 *   - `app.on('before-quit')`（index.ts）—— 普通退出（托盘「退出 kyclaw」/ 菜单/Cmd+Q/更新安装
 *     成功后的 `app.quit()`）；
 *   - `autoUpdater` 的 `before-quit-for-update`（index.ts）—— 更新安装那条路：Electron 文档写明
 *     `autoUpdater.quitAndInstall()` 会先关掉窗口再 `app.quit()`（那时 `before-quit` 晚于 close），
 *     并把 `before-quit-for-update` 指成"关窗之前"该听的那个事件；
 *   - 本窗口的 `session-end`（下面）—— Windows 关机 / 注销：Electron 文档明确"系统关机/注销时
 *     Windows 上不发 `before-quit`"，所以这一路得单独接。`query-session-end` **不接**：那只是
 *     "要不要结束会话"的询问，可以被取消/推迟，不是真结束（接了就会把标记提前立死）。
 * macOS 不参与（关窗照旧，应用留在 Dock）。
 */
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { IPC_CHANNELS, type WindowState } from '../shared/ipc'
import type { ThemeMode } from '../shared/settings'
import { attachContextMenu } from './context-menu'
import { readSettings, settingsPath, updateSettings } from './settings'
import {
  readWindowState,
  windowStatePath,
  writeWindowState,
  type PersistedWindowState
} from './store'
import { createThemeBridge } from './theme-bridge'
import {
  closePromptOptions,
  closePromptResultOf,
  createCloseController,
  markQuitting,
  scriptedClosePromptFor
} from './window-close'
import { hardenWebviewPreferences } from './webview'
import icon from '../../resources/icon.png?asset'

/** 与 token 的 --Bg-GroundPC 同值：窗口底色先于渲染端第一帧生效 */
const WINDOW_BACKGROUND = { light: '#fbfaf9', dark: '#181817' } as const

/** 显式档直接用主题本身算首帧底色（不赌 themeSource/shouldUseDarkColors 的生效时序）；system 才读 OS */
function windowBackgroundFor(theme: ThemeMode): string {
  if (theme === 'dark') return WINDOW_BACKGROUND.dark
  if (theme === 'light') return WINDOW_BACKGROUND.light
  return nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
}

/** 默认 1280×800；最小 720×480 保证三栏骨架还有可用的中间列 */
const MIN_WIDTH = 720
const MIN_HEIGHT = 480

/** 拖拽/缩放会连续发 resize/move，写盘防抖（真正退出时在 close 里补一次同步写） */
const SAVE_DEBOUNCE_MS = 300

let mainWindow: BrowserWindow | null = null

/**
 * nativeTheme 与主窗口底色的运行时链：启动创建窗口前用它对齐落盘主题；
 * 运行中 settings:update 的 theme 变化走 applyThemeMode。
 */
const themeBridge = createThemeBridge({
  nativeTheme,
  getWindow: () => mainWindow,
  colors: WINDOW_BACKGROUND
})

/** 当前主进程解析后的明暗（system 模式取 OS） */
export function currentResolvedTheme(): 'light' | 'dark' {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** 把解析后的明暗推给渲染端（media query 在运行时切 themeSource 后可能滞后） */
function pushResolvedTheme(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  try {
    win.webContents.send(IPC_CHANNELS.settings.themeChanged, currentResolvedTheme())
  } catch (error) {
    // 推送失败不该把已落盘的主题更新翻成 IPC 错误；渲染端启动时还有 effectiveTheme 查询兜底
    console.warn('[kyclaw] 主题推送失败（渲染端会用查询值兜底）', error)
  }
}

/** 运行时主题变更入口（settings:update 落盘成功后由 index.ts 调用） */
export function applyThemeMode(theme: ThemeMode): void {
  themeBridge.applyThemeSource(theme)
  if (mainWindow !== null) pushResolvedTheme(mainWindow)
}

/** 取"还原态"几何：最大化时 getBounds 给的是最大化后的框，getNormalBounds 才是还原后的 */
function currentState(win: BrowserWindow): PersistedWindowState {
  const bounds = win.getNormalBounds()
  return {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: win.isMaximized()
  }
}

function pushState(win: BrowserWindow): void {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  const state: WindowState = { maximized: win.isMaximized() }
  win.webContents.send(IPC_CHANNELS.window.stateChanged, state)
}

export function createMainWindow(): BrowserWindow {
  const statePath = windowStatePath(app.getPath('userData'))
  const saved = readWindowState(statePath)

  // 创建窗口前对齐落盘主题；运行中切「跟随系统」由 applyThemeMode 把 themeSource 写回 'system'。
  const startupTheme = readSettings(settingsPath(app.getPath('userData'))).theme
  themeBridge.applyThemeSource(startupTheme)

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x ?? undefined,
    y: saved.y ?? undefined,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: windowBackgroundFor(startupTheme),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // 工作台「浏览器」tab 用内嵌 <webview>（隔离分区 + 无 node/preload 见 main/webview.ts）
      webviewTag: true
    }
  })

  mainWindow = win

  // 系统主题变化 / themeSource 生效后同步窗口底色与渲染端解析主题
  const stopThemeWatch = themeBridge.watchNativeTheme()
  const publishTheme = (): void => {
    pushResolvedTheme(win)
  }
  nativeTheme.on('updated', publishTheme)

  // 客户端内右键菜单：只放编辑类有用项，浏览器自带项一律没有入口（见 main/context-menu.ts）
  attachContextMenu(win)

  // 客人（webview）的偏好**每次挂载时钉死**：不吃我们的 preload、不开 node、分区固定成
  // persist:kyclaw-browser —— 渲染端写什么 partition 都进不来（安全面只在主进程这一处）。
  win.webContents.on('will-attach-webview', (_event, webPreferences) => {
    hardenWebviewPreferences(webPreferences)
  })

  // 还原上次的最大化态要在 loadURL 之前：窗口还藏着，先定好尺寸再让渲染端按最终尺寸布局
  if (saved.maximized) win.maximize()

  // 写盘防抖的计时器按窗口各存一份：换窗口时不会把上一个窗口的待写状态顶掉
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  const saveState = (): void => {
    if (win.isDestroyed()) return
    writeWindowState(statePath, currentState(win))
  }
  const saveStateLater = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(saveState, SAVE_DEBOUNCE_MS)
  }

  win.on('ready-to-show', () => {
    // 先露出窗口；后面的底色/主题同步即使异常也不能把窗口留在隐藏态
    win.show()
    themeBridge.syncWindowBackground()
    pushResolvedTheme(win)
    pushState(win)
  })

  win.on('resize', saveStateLater)
  win.on('move', saveStateLater)
  win.on('maximize', () => {
    pushState(win)
    saveStateLater()
  })
  win.on('unmaximize', () => {
    pushState(win)
    saveStateLater()
  })

  // 关闭策略（0.1.3 托盘驻留）：win/linux 按三档偏好处理关闭（ask 弹三选一 / tray 收进托盘 /
  // quit 正常退出）；真退出（app.quit / 更新安装 / 系统关机）与托盘不可用都放行
  // —— 判定与动作全在 window-close.ts
  const settingsFile = settingsPath(app.getPath('userData'))
  const closeController = createCloseController({
    // 现读落盘偏好：用户在设置页刚改过 / 上一次勾了"记住"都以当下那份为准
    mode: () => readSettings(settingsFile).closeToTrayMode,
    actions: {
      hide: () => {
        if (!win.isDestroyed()) win.hide()
      },
      quit: () => app.quit(),
      prompt: async () => {
        // 隔离探针注入（KYCLAW_CLOSE_PROMPT=tray[:remember]|quit[:remember]|cancel）：
        // **只在开发态生效**（`scriptedClosePromptFor(is.dev, …)`；打包生产忽略这个环境变量——
        // 它不能静默改偏好或触发退出）。原生模态弹窗自动化点不到，探针用它驱动**真实的**
        // close → 落盘 → hide/quit 路径；生产永远走下面的真弹窗。
        const scripted = scriptedClosePromptFor(is.dev, process.env.KYCLAW_CLOSE_PROMPT)
        if (scripted !== null) return scripted
        const { response, checkboxChecked } = await dialog.showMessageBox(win, closePromptOptions())
        return closePromptResultOf({ response, checkboxChecked })
      },
      rememberChoice: (mode) => {
        // 只写用户明确选的 tray / quit；写失败如实抛给控制器（它记日志——这次的选择照常生效，
        // 但绝不冒充"已记住"：下次关闭还会问）
        updateSettings(settingsFile, { closeToTrayMode: mode })
      }
    }
  })

  win.on('close', (event) => {
    if (saveTimer) clearTimeout(saveTimer)
    saveState()
    closeController.handleClose(event)
  })

  // Windows 关机 / 注销：`session-end` = 会话真的要结束了（Electron 文档：一旦发出就没有挽回
  // 余地；且系统关机时 Windows 上不发 `before-quit`，这条是那一路唯一的真实退出信号）。
  // 注意**不接** `query-session-end`：那只是询问、可以被取消/推迟，立标记会提前把退出锁死。
  // 边界（本环境未实测到、不冒充结论）：关机时窗口 `close` 与 `session-end` 的先后次序没有实测证据；
  // 若 close 先到，窗口会被收进托盘（不销毁），随后系统仍会结束进程——不影响"不丢数据"这一层。
  win.on('session-end', () => markQuitting())

  win.on('closed', () => {
    // nativeTheme 是进程级对象：窗口销毁后必须摘掉监听，避免闭包一直指着已销毁窗口
    stopThemeWatch()
    nativeTheme.off('updated', publishTheme)
    mainWindow = null
  })

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

/**
 * 有窗口就显示并聚焦（还原最小化 / 从托盘收起的状态），没有就新建——托盘"显示主窗口"、
 * 托盘图标单击、单实例第二实例都走这里。隐藏的窗口（关闭到托盘）原样留着 webContents，
 * 这里只负责把它重新露出来，后台任务不受影响。
 */
export function showMainWindow(): BrowserWindow {
  const existing = mainWindow
  if (!existing) return createMainWindow()

  if (existing.isMinimized()) existing.restore()
  existing.show()
  existing.focus()
  return existing
}
