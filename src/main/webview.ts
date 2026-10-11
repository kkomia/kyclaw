/**
 * 内嵌浏览器（工作台「浏览器」tab）的主进程侧收口。
 *
 * `<webview>` 的形态与纪律：
 *   - 独立分区 `persist:kyclaw-browser`：客人的 cookie/缓存与主窗口（也就是应用自己）完全分开，
 *     客人也**没有**我们的 preload、不开 nodeIntegration/contextIsolation 之外的东西；
 *   - 分区在 `will-attach-webview` 里**强制钉死**：渲染端就算写别的 partition 也进不来
 *     （将来多了别的 webview 也不会悄悄共用一个会话）；
 *   - `window.open` 一律拦下：外面用系统浏览器打开，应用内不开新窗（`web-contents-created` 收口，
 *     主窗口与客人都走这条）；
 *   - 客人里的右键菜单与主窗口同一口径（编辑区才给剪切/复制/粘贴，浏览器自带项一律没有）。
 *
 * 为什么是 webview 而不是 WebContentsView：z-order 与 DOM 一致（面板上的自绘菜单/浮层盖得住它）、
 * 裁剪随 DOM 走，工程成本最小。
 */
import { app, shell, type WebContents } from 'electron'
import { attachWebContentsContextMenu } from './context-menu'

/** 浏览器的独立会话分区（持久化：登录态重启后还在） */
export const BROWSER_PARTITION = 'persist:kyclaw-browser'

/**
 * 挂全局的 webContents 护栏（进程级，只能挂一次；从 main/index.ts 的 whenReady 里调一次）。
 * 注意：**不**给 webview 挂在我们自己的 webPreferences 里 —— 客人的偏好由窗口的
 * will-attach-webview 逐次钉死（见 main/window.ts）。
 */
export function installWebviewGuard(): void {
  app.on('web-contents-created', (_event, contents) => {
    // 客人自己弹的新窗口不开在应用里：交给系统浏览器（与主窗口的 window.open 同口径）
    contents.setWindowOpenHandler((details) => {
      void shell.openExternal(details.url)
      return { action: 'deny' }
    })

    if (contents.getType() === 'webview') attachWebContentsContextMenu(contents)
  })
}

/** 客人的 webPreferences 钉死（will-attach-webview 里调）：没有 preload、没有 node、独立分区 */
export function hardenWebviewPreferences(preferences: {
  preload?: string
  nodeIntegration?: boolean
  contextIsolation?: boolean
  sandbox?: boolean
  partition?: string
  webSecurity?: boolean
}): void {
  delete preferences.preload
  preferences.nodeIntegration = false
  preferences.contextIsolation = true
  preferences.sandbox = true
  preferences.partition = BROWSER_PARTITION
}

/** 排障用：一个 webContents 是不是客人 */
export function isWebview(contents: WebContents): boolean {
  return contents.getType() === 'webview'
}
