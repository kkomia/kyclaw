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
import { isSamePreviewPath } from '@renderer/lib/tab-model'
import { absoluteOf } from './use-workbench-root'
import { useWorkbenchStore } from './workbench-store'

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
  // 绝对路径已随 `OfficeDocumentInfo` 落进 OfficeTab.absolutePath（store 里只读，仅用于匹配）
  // M3-S5-3：打开闸门（标签数/未保存数超限）在这里统一吹哨——被拒就抛人话，**不新增标签**；
  // 调用方拿到 Error 原样展示（聊天卡/文件树既有错误行），不静默、不假装打开。
  const opened = useOfficeTabsStore.getState().openDocumentChecked(result.document)
  if (!opened.ok) throw new Error(opened.block.message)
  // T1（2026-10-18）：同一个文档不允许"顶栏文档标签 + 右栏预览标签"各开一份 ——
  // 顶栏是文档级唯一载体，打开/激活文档后把右栏里同路径的预览标签收掉（涉及多个入口的
  // 唯一收口点：交付卡「编辑」、文件树「在 Office 标签页中打开/双击」都会走这里）。
  closePreviewTabsFor(relative)
  return { document: result.document, tabId: opened.tabId, alreadyOpen: result.alreadyOpen }
}

/** T1：关掉右栏里与这份相对路径同一文件的预览标签（右栏不可见时也清理，保持"不双开"不变式） */
function closePreviewTabsFor(relative: string): void {
  const workbench = useWorkbenchStore.getState()
  for (const tab of workbench.tabs) {
    if (tab.kind !== 'preview' || !isSamePreviewPath(tab.path, relative)) continue
    workbench.closeTab(tab.id)
  }
}

/**
 * 测试用：早先渲染端用模块级 Map 记 `documentId → absolutePath`，S4 起该缓存已删
 * （绝对路径随 `OfficeDocumentInfo` 落进 `OfficeTab.absolutePath`）。保留这个空函数只是
 * 让既有测试床不用为一行清理逻辑改 import；新用例不应再依赖它。
 */
export function resetOfficeOpenState(): void {
  // S4 起渲染端不再有 absolutePath 缓存；保留函数只为兼容既有测试床（不再有要清的模块级状态）
  void 0
}

/** 路径归一（Windows 大小写不敏感 + 正反斜杠都认）；只做匹配，不做任何访问判定 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/**
 * 在 Office 标签里找出与「预览里这份文件」同一个文件的那条标签（只认第一步的 docx）。
 *
 * 匹配口径（宁可漏提示，不误报成"同一文件"）：
 *   1. 有 `absolutePath`（M3-S4 起所有 docx 标签都有，主进程回包带过来的只读字段）：
 *      与 `rootPath + relative` 拼出的绝对路径精确比 —— 跨工作区同名相对路径**不会**误报；
 *   2. 没有（S4 之前落下的标签 / 直接 `open()` 开的假标签）才退化成 `displayPath` 双候选
 *      （相对路径或绝对路径相等即可）。这是已知的弱边界，只为兼容旧调用方。
 *
 * 找不到返回 undefined。`rootPath` 判不出时只能比相对路径（绝对路径那一路自动跳过）。
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
    if (tab.absolutePath !== undefined) {
      // 有绝对路径身份：只认精确绝对匹配，绝不拿相对路径兜底（防跨根误报）
      if (absoluteKey !== null && normalizePath(tab.absolutePath) === absoluteKey) return tab
      continue
    }
    if (tab.path === undefined) continue
    const pathKey = normalizePath(tab.path)
    if (pathKey === relativeKey || (absoluteKey !== null && pathKey === absoluteKey)) return tab
  }
  return undefined
}
