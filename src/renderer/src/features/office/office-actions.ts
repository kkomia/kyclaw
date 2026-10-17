/**
 * Office 模块级动作/运行时注册表（M3-S3 起；S4 扩到快捷键统一分发）。
 *
 * 为什么需要它：标签条挂在**常驻的** `AppTabBar`（TitleBar 子树）里，而编辑器运行时（保存/关闭）
 * 只存在于 `OfficePage`（ModuleHost 子树）——两者是兄弟子树，props 传不过去。
 * 这里用模块级 `Map<documentId, runtime>` 把"页面持有的运行时"暴露给任何壳组件：
 *   - `OfficePage/OfficeWorkspace` 在编辑器挂载后 `registerOfficeRuntime(...)`；
 *   - `AppTabBar`（关闭/保存/Ctrl+S）、`OfficePage` 的保存按钮、面内 `surface:shortcut`
 *     全部经 `saveOfficeTab(tab)` / `closeOfficeTab(tab)` / `handleOfficeShortcut(action)` 走同一实现。
 *
 * 快捷键为什么要"注册 handler"：Ctrl+W 的脏标签三态确认弹窗渲染在 AppTabBar 里（它常驻），
 * 而焦点在 iframe 内时消息只能先到 OfficePage。AppTabBar 启动时把自己的分发函数注册进来，
 * 面内转发与壳侧按键因此走**完全同一条**逻辑（不会出现两条路径各自判断路由/弹窗状态）。
 */
import { unwrapIpcError } from '@renderer/lib/ipc-error'
import { useNewTabStore } from '../newtab/new-tab-store'
import { useOfficeTabsStore, type OfficeTab } from './office-tabs-store'
import { openBlockReason } from './office-capacity'

export interface OfficeRuntime {
  /** 保存当前文档（三阶段）；返回是否成功写盘/commit */
  save(): Promise<boolean>
  /** 卸载面内编辑器（关标签前调用；幂等） */
  close(): Promise<void>
  /** 另存为（可选；保存失败时 UI 的"另存"入口） */
  saveAs?: () => Promise<boolean>
}

/** documentId → 正在挂载的文档运行时（同一 id 只允许一份） */
const runtimes = new Map<string, OfficeRuntime>()

/** 注册（返回注销函数；OfficeWorkspace 卸载时调用） */
export function registerOfficeRuntime(documentId: string, runtime: OfficeRuntime): () => void {
  runtimes.set(documentId, runtime)
  return () => {
    if (runtimes.get(documentId) === runtime) runtimes.delete(documentId)
  }
}

/** 查运行时（排障/单测用；壳组件不该绕过 saveOfficeTab 直接调） */
export function officeRuntimeOf(documentId: string): OfficeRuntime | undefined {
  return runtimes.get(documentId)
}

/**
 * 保存一个标签：有运行时（编辑器已挂）就交给运行时；没有（比如非 docx / 面还没就绪）返回 false。
 * **不伪造成功**：没接编辑器时调用方按"当前不支持"处理。
 */
export async function saveOfficeTab(tab: OfficeTab | undefined): Promise<boolean> {
  if (tab?.documentId === undefined) return false
  const runtime = runtimes.get(tab.documentId)
  if (runtime === undefined) return false
  return runtime.save()
}

/**
 * 关闭一个标签（顺序按计划 §8.3）：面 `doc:close`（卸载编辑器）→ `office:release`（主进程注册表）
 * → store `close`。store 最后，保证释放期间标签还在；释放失败只影响主进程内存，不挡关标签。
 */
export async function closeOfficeTab(tab: OfficeTab): Promise<void> {
  const runtime = tab.documentId === undefined ? undefined : runtimes.get(tab.documentId)
  if (runtime !== undefined) {
    await runtime.close()
    runtimes.delete(tab.documentId as string)
  }
  if (tab.documentId !== undefined) {
    try {
      await window.kyclaw?.office?.release(tab.documentId)
    } catch {
      // 释放失败只影响主进程注册表内存（进程退出会清），不挡关标签
    }
  }
  useOfficeTabsStore.getState().close(tab.id)
}

/** 快捷键动作（与 bridge-protocol 的 `surface:shortcut` 动作名同值；避免壳/面各一套枚举） */
export type OfficeShortcutAction = 'save' | 'close' | 'next-tab' | 'prev-tab'

/**
 * 壳侧快捷键分发器（M3-S4：AppTabBar 注册）。
 * 返回是否"消费"这次按键 —— 调用方据此 preventDefault；非 /office 路由的 Ctrl+W 返回 true
 * 但 no-op（D14：拦住 Electron 默认关窗，但不误关 Office 标签）。
 */
export type OfficeShortcutHandler = (action: OfficeShortcutAction) => boolean

let shellShortcutHandler: OfficeShortcutHandler | null = null

/** AppTabBar 启动时注册；卸载时注销（返回注销函数） */
export function registerOfficeShortcutHandler(handler: OfficeShortcutHandler): () => void {
  shellShortcutHandler = handler
  return () => {
    if (shellShortcutHandler === handler) shellShortcutHandler = null
  }
}

/**
 * 快捷键统一入口：壳侧按键与面内 `surface:shortcut` 都走这里。
 * 有 AppTabBar 注册的分发器就交给它（脏标签三态、路由门、弹窗 no-op 都在那一处）；
 * 没有（独立渲染 OfficePage 的单测/极端时序）时只保留保存的兜底。
 */
export function handleOfficeShortcut(action: OfficeShortcutAction): boolean {
  if (shellShortcutHandler !== null) return shellShortcutHandler(action)
  if (action !== 'save') return false
  const state = useOfficeTabsStore.getState()
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
  if (activeTab === undefined) return false
  void saveOfficeTab(activeTab)
  return true
}

/**
 * task-80：新建空白 Word 文档（唯一新 IPC `office:create-blank`）。
 *
 * 顺序（DESIGN §5 状态 1）：
 *   ① 渲染端先过容量闸门（`openBlockReason`；空白伪标签不计入）；
 *   ② 主进程写随包最小模板到 `%TEMP%/kyclaw/未命名-<ts>.docx` 并注册；
 *   ③ 渲染端 `openDocumentChecked`（并发兜底：被拒先 `office:release` 再回人话）；
 *   ④ 成功后 `markDirty`（新文档未保存，首次保存走另存为）。
 * 不改空白标签状态：成功路径由调用方 consume，失败留在本页。
 */
export interface CreateBlankResult {
  ok: boolean
  tabId?: string
  message?: string
}

export async function createBlankDocument(): Promise<CreateBlankResult> {
  const block = openBlockReason(useOfficeTabsStore.getState().tabs, 'docx')
  if (block !== null) return { ok: false, message: block.message }

  const api = window.kyclaw?.office
  if (api === undefined) return { ok: false, message: '当前环境打不开文档工作区' }

  let result: Awaited<ReturnType<typeof api.createBlank>>
  try {
    result = await api.createBlank({ kind: 'docx' })
  } catch (error) {
    return { ok: false, message: unwrapIpcError(error) }
  }
  if (!result.ok) return { ok: false, message: result.message }

  const opened = useOfficeTabsStore.getState().openDocumentChecked(result.document)
  if (!opened.ok) {
    void api.release(result.document.documentId).catch(() => undefined)
    return { ok: false, message: opened.block.message }
  }
  useOfficeTabsStore.getState().markDirty(opened.tabId)
  return { ok: true, tabId: opened.tabId }
}

/**
 * task-80：新增标签页里的「打开 Word 文档…」（v1 诚实降级——选择器只过滤 .docx）。
 * 取消是一等结果（静默回本页）；容量拒绝先 release 主进程注册表条目再回人话；
 * 失败给主进程人话（调用方原样显示）。成功不改空白状态，由调用方 consume。
 */
export type OpenDocumentOutcome =
  | { status: 'opened'; tabId: string }
  | { status: 'cancelled' }
  | { status: 'blocked'; message: string }
  | { status: 'failed'; message: string }

export async function openOfficeDocumentFromPicker(): Promise<OpenDocumentOutcome> {
  const block = openBlockReason(useOfficeTabsStore.getState().tabs, 'docx')
  if (block !== null) return { status: 'blocked', message: block.message }

  const api = window.kyclaw?.office
  if (api === undefined) return { status: 'failed', message: '当前环境打不开文档工作区' }

  try {
    const result = await api.openDialog()
    if (!result.ok) {
      if (result.code === 'cancelled') return { status: 'cancelled' }
      return { status: 'failed', message: result.message }
    }
    const opened = useOfficeTabsStore.getState().openDocumentChecked(result.document)
    if (!opened.ok) {
      // 选择器已经让主进程注册了文档：容量拒绝必须释放，别让它挂到窗口关闭
      void api.release(result.document.documentId).catch(() => undefined)
      return { status: 'blocked', message: opened.block.message }
    }
    return { status: 'opened', tabId: opened.tabId }
  } catch (error) {
    return { status: 'failed', message: unwrapIpcError(error) }
  }
}

/**
 * task-80：「继续」项激活即消费空白（不新增、不查容量、不弹脏确认）。
 * 标签已不存在（竞态）返回 false，调用方刷新列表留在本页。
 */
export function activateExistingDocument(tabId: string): boolean {
  const tabs = useOfficeTabsStore.getState().tabs
  if (!tabs.some((tab) => tab.id === tabId)) return false
  useOfficeTabsStore.getState().activate(tabId)
  useNewTabStore.getState().consume()
  return true
}

/** 测试用：清空注册表与分发器（模块级状态不随 render 重置） */
export function resetOfficeActionsForTest(): void {
  runtimes.clear()
  shellShortcutHandler = null
}
