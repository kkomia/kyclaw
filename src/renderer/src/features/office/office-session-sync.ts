/**
 * M4-T：标签持久化渲染端接线。
 * - sync：每次 tabs/active 变化节流（300ms）上报 documentId；**脏 id 不上报**（天然不持久化/不恢复）。
 * - restore：启动调一次 sessionRestore，串行返回后按现有容量策略进 store；返回聚合计数供 UI 提示。
 */
import { useOfficeTabsStore } from './office-tabs-store'

const SYNC_INTERVAL_MS = 300
let syncTimer: ReturnType<typeof setTimeout> | null = null
let started = false
let restoreStarted = false

function currentPayload(): { documentIds: string[]; activeDocumentId: string | null } | null {
  const state = useOfficeTabsStore.getState()
  const documentIds = state.tabs
    .filter((tab) => tab.documentId !== undefined && tab.documentId !== '' && !tab.dirty)
    .map((tab) => tab.documentId as string)
  if (documentIds.length === 0) return null
  const active = state.tabs.find((tab) => tab.id === state.activeTabId)
  return {
    documentIds,
    activeDocumentId:
      active?.documentId !== undefined && active?.documentId !== '' ? active.documentId : null
  }
}

async function flush(): Promise<void> {
  syncTimer = null
  const payload = currentPayload()
  if (payload === null) return
  try {
    await window.kyclaw?.office?.sessionSync(payload.documentIds, payload.activeDocumentId)
  } catch {
    /* 持久化失败静默 */
  }
}

/** 安装节流同步；返回取消函数（测试/卸载用）。 */
export function startOfficeSessionSync(): () => void {
  if (started) return () => undefined
  started = true
  const unsubscribe = useOfficeTabsStore.subscribe((state, previous) => {
    if (state.tabs === previous.tabs && state.activeTabId === previous.activeTabId) return
    if (syncTimer !== null) return
    syncTimer = setTimeout(() => {
      void flush()
    }, SYNC_INTERVAL_MS)
  })
  return () => {
    unsubscribe()
    started = false
    if (syncTimer !== null) {
      clearTimeout(syncTimer)
      syncTimer = null
    }
  }
}

export interface OfficeSessionRestoreSummary {
  restored: number
  modifiedOnDisk: number
  skipped: number
}

/** 启动恢复（单例）：串行主进程 open 后逐个进 store；失败/超限只在计数里，不抛。 */
export async function restoreOfficeSessionOnce(): Promise<OfficeSessionRestoreSummary> {
  const summary: OfficeSessionRestoreSummary = { restored: 0, modifiedOnDisk: 0, skipped: 0 }
  if (restoreStarted) return summary
  restoreStarted = true
  try {
    const result = await window.kyclaw?.office?.sessionRestore()
    if (result === undefined) return summary
    summary.modifiedOnDisk = result.modifiedOnDisk
    summary.skipped = result.skipped
    for (const info of result.restored) {
      const opened = useOfficeTabsStore.getState().openDocumentChecked(info)
      if (opened.ok) summary.restored += 1
      else summary.skipped += 1
    }
    const active = result.activeDocumentId
    if (active !== null) {
      const tab = useOfficeTabsStore.getState().tabs.find((item) => item.documentId === active)
      if (tab !== undefined) useOfficeTabsStore.getState().activate(tab.id)
    }
  } catch {
    /* 恢复失败静默：不影响正常打开 */
  }
  return summary
}

/** 测试重置（模块单例状态）。 */
export function resetOfficeSessionRuntime(): void {
  started = false
  restoreStarted = false
  if (syncTimer !== null) {
    clearTimeout(syncTimer)
    syncTimer = null
  }
}
