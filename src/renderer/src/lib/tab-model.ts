/**
 * 标签生态统一模型（T1，2026-10-18）：**纯判定**，不持有任何状态、不 import React。
 *
 * 口径（Lead 拍板，见 .superpowers/handover/tabs-ecosystem-report.md）：
 *   - 顶栏（AppTabBar）= **文档级唯一载体**：主对话（固定、永不关）+ 新标签页（空名单例）+ 文档；
 *   - 右栏（Workbench）= **工具面板**：文件/终端/Git/浏览器/预览，不进顶栏；
 *   - 同一个文档不允许同时躺在顶栏文档标签和右栏预览标签里（office-open.ts 负责去重）。
 *
 * 这里只回答"这次 Ctrl+W 该关谁"，具体动作（脏三态确认、Office release 编排、右栏 store）
 * 仍由壳侧既有实现做 —— 本任务不重写两个 store，也不碰 Office 关闭编排。
 */

/** 标签载体：顶栏（文档级） / 右栏（工具面板） */
export type TabCarrier = 'top' | 'workbench'

/** Ctrl+W 的落点：右栏当前标签 / 顶栏空白标签 / 顶栏当前文档 / 没有可关的（吞键） */
export type CtrlWTarget = 'workbench' | 'blank' | 'doc' | 'none'

/** 判定 Ctrl+W 归属所需的上下文快照（全部现取，不缓存） */
export interface TabShortcutSnapshot {
  pathname: string
  /** 右栏面板是否处于打开态（shell-store 的 workPanelOpen） */
  workPanelOpen: boolean
  /** 焦点是否在右栏面板内（document.activeElement 落在 [data-testid="work-panel"] 里） */
  focusInWorkPanel: boolean
  /** 右栏标签数 */
  workbenchTabCount: number
  /** 顶栏空白伪标签是否开着 */
  blankTabOpen: boolean
  /** 空白伪标签是否在前台 */
  blankTabActive: boolean
  /** 顶栏文档标签数 */
  topTabCount: number
}

/**
 * 右栏此刻是否"可见"：只有 /chat 且面板打开。离开 /chat 时 AppShell 会把面板收起
 * （现状保留），所以面板关着时右栏快捷键一律不生效——从根上消灭"看不见的标签"。
 */
export function isWorkbenchVisible(pathname: string, workPanelOpen: boolean): boolean {
  return workPanelOpen && pathname.startsWith('/chat')
}

/** 焦点是否在右栏面板内：xterm/textarea/webview 的焦点都会以 activeElement 落在面板 DOM 里 */
export function isFocusInWorkPanel(
  activeElement: Element | null,
  container: ParentNode = document
): boolean {
  if (activeElement === null) return false
  const panel = container.querySelector('[data-testid="work-panel"]')
  return panel !== null && panel.contains(activeElement)
}

/**
 * Ctrl+W 的上下文归属（纯函数，单测直接打它）：
 *   1. 右栏可见且焦点在右栏、且右栏有标签 → 关右栏当前标签；
 *   2. 否则空白伪标签在前台 → 关空白（单例、无脏确认）；
 *   3. 否则顶栏有文档标签 → 关当前文档（若有脏态由壳侧弹三态）；
 *   4. 都没有 → 'none'：仍然要吞键（preventDefault），绝不把 Ctrl+W 漏给窗口关闭。
 * 主对话是固定标签、不在任何可关集合里，所以永远不会被关。
 */
export function resolveCtrlW(snapshot: TabShortcutSnapshot): CtrlWTarget {
  const workbenchFocusable =
    isWorkbenchVisible(snapshot.pathname, snapshot.workPanelOpen) &&
    snapshot.focusInWorkPanel &&
    snapshot.workbenchTabCount > 0
  if (workbenchFocusable) return 'workbench'
  if (snapshot.blankTabOpen && snapshot.blankTabActive) return 'blank'
  if (snapshot.topTabCount > 0) return 'doc'
  return 'none'
}

/** 顶栏文档标签的"可关 id"：优先 activeTabId，兜底第一条（activeTabId 为空串的过渡态） */
export function closeableTopTabId(
  activeTabId: string,
  tabs: readonly { id: string }[]
): string | null {
  if (activeTabId !== '') return activeTabId
  return tabs[0]?.id ?? null
}

/** 路径归一（Windows 大小写不敏感 + 正反斜杠都认）；只用于"同一文件"判定，不做访问判定 */
export function normalizeTabPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

/** 右栏预览标签与某个相对路径是不是同一份文件（去重用；与 office-open 的匹配口径互补） */
export function isSamePreviewPath(previewPath: string | undefined, relative: string): boolean {
  if (previewPath === undefined || previewPath === '') return false
  return normalizeTabPath(previewPath) === normalizeTabPath(relative)
}
