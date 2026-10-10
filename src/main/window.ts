/**
 * 主窗口：无边框（frame: false，窗控由标题栏自绘）+ 几何/最大化落盘（main/store.ts）。
 *
 * 防白闪两道：`backgroundColor` 按系统主题取 #fbfaf9 / #181817（与 --Bg-GroundPC 同值），
 * 再配 show: false + ready-to-show —— 首帧之前底色就已经是画布色，不会闪白。
 *
 * 关闭窗口即退出（window-all-closed → app.quit，模板口径）：托盘只做"显示/退出"，
 * 不做"关到托盘后台驻留"——后台行为等 T6 起主进程真跑服务时再定。
 */
import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { IPC_CHANNELS, type WindowState } from '../shared/ipc'
import {
  readWindowState,
  windowStatePath,
  writeWindowState,
  type PersistedWindowState
} from './store'
import icon from '../../resources/icon.png?asset'

/** 与 token 的 --Bg-GroundPC 同值：窗口底色先于渲染端第一帧生效 */
const WINDOW_BACKGROUND = { light: '#fbfaf9', dark: '#181817' } as const

/** 默认 1280×800；最小 720×480 保证三栏骨架还有可用的中间列 */
const MIN_WIDTH = 720
const MIN_HEIGHT = 480

/** 拖拽/缩放会连续发 resize/move，写盘防抖（真正退出时在 close 里补一次同步写） */
const SAVE_DEBOUNCE_MS = 300

let mainWindow: BrowserWindow | null = null

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
    backgroundColor: nativeTheme.shouldUseDarkColors
      ? WINDOW_BACKGROUND.dark
      : WINDOW_BACKGROUND.light,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow = win

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
    win.show()
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

  win.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveState()
  })

  win.on('closed', () => {
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

/** 有窗口就显示并聚焦（还原最小化），没有就新建——托盘"显示主窗口"/单实例第二实例都走这里 */
export function showMainWindow(): BrowserWindow {
  const existing = mainWindow
  if (!existing) return createMainWindow()

  if (existing.isMinimized()) existing.restore()
  existing.show()
  existing.focus()
  return existing
}
