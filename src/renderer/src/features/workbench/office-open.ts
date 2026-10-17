/**
 * 聊天交付卡 / 文件树 → Office 标签的入口（M3-S4 的并行块）。
 *
 * 两处入口共用这里的一份逻辑（不要各写一份）：
 *   1. `openOfficeFromSession(threadId, relative)`：主进程按会话根解析 + containment，成功回
 *      `document`（只读 `absolutePath` 只用于匹配/展示），壳只做 `openDocument`（按 documentId
 *      去重/激活）。**绝对路径绝不回传主进程**——S2 的 `office:read/save` 只认 documentId。
 *   2. `goToOffice()`：成功后跳 `/office`。
 *   3. `officeTabForPreview(...)`：工作台预览找"同一文件已开 Office 标签"。
 *
 * 为什么跳路由不用 `useNavigate`：这三个入口的既有单测（files-tool / preview-tool /
 * deliverable-card 三个 spec，几十处 render）都是**不带 Router 直接 render** 的；而应用用的是
 * HashRouter（App.tsx），改 hash 与 `navigate('/office')` 等价。仓内先例：ComposerControls 的
 * 「打开工作区设置」也是直接改 `window.location.hash`。这样入口组件不必为了一个跳转去改几十处
 * 测试床，也不会把 router 依赖散进 workbench。
 */
import type { OfficeDocumentInfo } from '@shared/office-editor'
import { useOfficeTabsStore, type OfficeTab } from '@renderer/features/office/office-tabs-store'
import { absoluteOf } from './use-workbench-root'

/** 第一步只接 .docx（主进程也只认这个后缀）；入口只对 docx 显示，非 docx 不给假入口 */
export function isOfficeEditablePath(path: string): boolean {
  return /\.docx$/i.test(path)
}

/**
 * 跳到 Office 模块。`navigate('/office')` 的 Router-free 等价（见文件头注）。
 * 已经在 /office 时不做任何事（改同一个 hash 也可能触发一次多余的导航）。
 */
export function goToOffice(): void {
  if (window.location.hash === '#/office') return
  window.location.hash = '#/office'
}

/**
 * 主进程回包里只读的 `absolutePath`：**只用于"同一文件"匹配**（预览交叉提示）。
 * 为什么要在渲染端记一份：`OfficeTab` 里存的是 `path = displayPath`（选择器入口是绝对路径、
 * 会话入口是相对路径），光靠它做跨工作区匹配会把同名相对路径误判成同一文件。等 S4-2 给 store
 * 补上绝对路径字段后，这里可以退化成直接读 tab。
 */
const absolutePathByDocumentId = new Map<string, string>()

/** 测试用：清掉模块级缓存（不随 render 重置） */
export function resetOfficeOpenState(): void {
  absolutePathByDocumentId.clear()
}

export interface OpenOfficeResult {
  document: OfficeDocumentInfo
  /** 壳 store 里的标签 id（已存在时是激活的那条） */
  tabId: string
  /** 主进程说这份文件已经在注册表里（壳只激活，不重复开） */
  alreadyOpen: boolean
}

/**
 * 从会话文件打开 Office 标签（聊天交付卡 / 文件树共用）。
 *
 * 只有 `ok:true` 才写 store；分类失败（未授权 / 非 docx / 文件没了 / 太大 / 取消）
 * 一律抛 `Error(人话)`，由调用方展示 —— **不静默、不假装打开、失败不跳转**。
 * 同一文件第二次调用：主进程回 alreadyOpen、store 按 documentId 只激活（不会重复开标签）。
 */
export async function openOfficeFromSession(
  threadId: string,
  relative: string
): Promise<OpenOfficeResult> {
  const office = window.kyclaw?.office
  if (office === undefined) {
    throw new Error('Office 通道不可用（window.kyclaw.office 缺失）')
  }
  const result = await office.openFromSession(threadId, relative)
  if (!result.ok) throw new Error(result.message)
  absolutePathByDocumentId.set(result.document.documentId, result.document.absolutePath)
  const tabId = useOfficeTabsStore.getState().openDocument(result.document)
  return { document: result.document, tabId, alreadyOpen: result.alreadyOpen }
}

/** 路径归一（Windows 大小写不敏感 + 正反斜杠都认）；只做匹配，不做任何访问判定 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/**
 * 在 Office 标签里找出与「预览里这份文件」同一个文件的那条标签（只认第一步的 docx）。
 *
 * 匹配顺序（宁可漏提示，不误报成"同一文件"）：
 *   1. 经本模块入口打开过的标签：只认渲染端记下的**绝对路径**精确匹配（跨工作区同名相对路径不会误报）；
 *   2. 其他标签（选择器打开 / 别处打开的）：`displayPath` 可能绝对也可能相对，双候选匹配
 *      （相对路径 或 rootPath+relative 拼出的绝对路径）。跨工作区同名相对路径是已知的弱边界。
 *
 * 找不到返回 undefined。`rootPath` 判不出时只能比相对路径。
 */
export function officeTabForPreview(
  tabs: readonly OfficeTab[],
  rootPath: string | null,
  relative: string
): OfficeTab | undefined {
  if (!isOfficeEditablePath(relative)) return undefined
  const relativeKey = normalizePath(relative)
  const absoluteKey = rootPath === null ? null : normalizePath(absoluteOf(rootPath, relative))

  for (const tab of tabs) {
    if (tab.kind !== 'docx') continue
    const knownAbsolute =
      tab.documentId === undefined ? undefined : absolutePathByDocumentId.get(tab.documentId)
    if (knownAbsolute !== undefined) {
      if (absoluteKey !== null && normalizePath(knownAbsolute) === absoluteKey) return tab
      continue
    }
    if (tab.path === undefined) continue
    const pathKey = normalizePath(tab.path)
    if (pathKey === relativeKey || (absoluteKey !== null && pathKey === absoluteKey)) return tab
  }
  return undefined
}
