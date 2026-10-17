/**
 * Office 模块级动作/运行时注册表（M3-S3；S4 的接线基础）。
 *
 * 为什么需要它：标签条挂在**常驻的** `AppTabBar`（TitleBar 子树）里，而编辑器运行时（保存/关闭）
 * 只存在于 `OfficePage`（ModuleHost → Outlet 子树）——两者是兄弟子树，props 传不过去。
 * 这里用模块级 `Map<documentId, runtime>` 把"页面持有的运行时"暴露给任何壳组件：
 *   - `OfficePage/OfficeWorkspace` 在编辑器就绪后 `registerOfficeRuntime(...)`；
 *   - `AppTabBar`（S4）与快捷键/保存按钮通过 `saveOfficeTab(tab)` / `closeOfficeTab(tab)` 走同一实现。
 *
 * S3 只落 save/close 两个动作（保存按钮 + 壳侧 Ctrl+S）；S4 再扩 activate/关闭三态流程。
 * 注意：**store 是纯的**（close 不收 IPC），副作用都在这里（面 `doc:close` → `office:release` → store close）。
 */
import { useOfficeTabsStore, type OfficeTab } from './office-tabs-store'

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
 * 关闭一个标签（S3 的最小版本：面 `doc:close` → `office:release` → store `close`）。
 * 脏标签的确认三态在 S4 由 AppTabBar 统一做；S3 的 Ctrl+W 不走这里（shell 组件不动）。
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

/** 快捷键动作里的 save/close（S4 会把 iframe 内转发与壳侧监听接到这同一份实现） */
export type OfficeShortcutAction = 'save' | 'close' | 'next-tab' | 'prev-tab'

/**
 * 壳侧快捷键入口（焦点在壳里时）：只有 `save` 在 S3 落地，其余在 S4 接标签条。
 * 返回是否消费了这次按键（调用方据此 preventDefault）。
 */
export function handleOfficeShortcut(action: OfficeShortcutAction): boolean {
  const state = useOfficeTabsStore.getState()
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
  if (action === 'save') {
    if (activeTab === undefined) return false
    void saveOfficeTab(activeTab)
    return true
  }
  // close / next-tab / prev-tab：S4 的 AppTabBar 统一实现（S3 不碰 shell 组件）
  return false
}

/** 测试用：清空注册表（模块级 Map 不随 render 重置） */
export function resetOfficeActionsForTest(): void {
  runtimes.clear()
}
