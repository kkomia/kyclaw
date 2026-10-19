import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installKyclawBridge, clearKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import {
  useOfficeTabsStore,
  resetOfficeTabsStore
} from '@renderer/features/office/office-tabs-store'
import type { OfficeDocumentInfo } from '@shared/office-editor'
import {
  resetOfficeSessionRuntime,
  restoreOfficeSessionOnce,
  startOfficeSessionSync
} from '../office-session-sync'

const doc = (id: string, kind: 'docx' | 'xlsx' | 'pptx' = 'docx'): OfficeDocumentInfo => ({
  documentId: id,
  kind,
  displayName: `${id}.${kind}`,
  displayPath: `C:\\docs\\${id}.${kind}`,
  absolutePath: `C:\\docs\\${id}.${kind}`,
  size: 1,
  mtimeMs: 1,
  sha256: `sha-${id}`,
  readOnly: false
})

beforeEach(() => {
  installKyclawBridge()
  resetOfficeTabsStore()
  resetOfficeSessionRuntime()
  vi.useFakeTimers()
})
afterEach(() => {
  clearKyclawBridge()
  resetOfficeTabsStore()
  resetOfficeSessionRuntime()
  vi.useRealTimers()
})

describe('M4-T renderer session sync', () => {
  it('sync：300ms 节流、只报 documentId、dirty 过滤', async () => {
    const sync = vi.fn<typeof window.kyclaw.office.sessionSync>(async () => ({ ok: true }))
    window.kyclaw.office.sessionSync = sync
    const stop = startOfficeSessionSync()
    useOfficeTabsStore.getState().openDocumentChecked(doc('a'))
    useOfficeTabsStore.getState().openDocumentChecked(doc('b', 'xlsx'))
    useOfficeTabsStore.getState().openDocumentChecked(doc('c', 'pptx'))
    vi.advanceTimersByTime(299)
    expect(sync).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    await vi.runOnlyPendingTimersAsync()
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.calls[0]?.[0]).toEqual(['a', 'b', 'c'])
    // active = 最后打开的 c
    expect(sync.mock.calls[0]?.[1]).toBe('c')
    // 触发第二次（把 b 标脏）→ 上报集合里没有 b
    const tabB = useOfficeTabsStore.getState().tabs.find((tab) => tab.documentId === 'b')
    useOfficeTabsStore.getState().markDirty(tabB?.id ?? '')
    vi.advanceTimersByTime(300)
    await vi.runOnlyPendingTimersAsync()
    expect(sync.mock.calls.at(-1)?.[0]).toEqual(['a', 'c'])
    stop()
  })

  it('restore：单例、逐个进 store、active 激活、聚合计数', async () => {
    const restore = vi.fn(async () => ({
      restored: [doc('a'), doc('b', 'xlsx'), doc('c', 'pptx')],
      activeDocumentId: 'b',
      modifiedOnDisk: 1,
      skipped: 2
    }))
    window.kyclaw.office.sessionRestore = restore
    const summary = await restoreOfficeSessionOnce()
    expect(restore).toHaveBeenCalledTimes(1)
    expect(summary).toEqual({ restored: 3, modifiedOnDisk: 1, skipped: 2 })
    const state = useOfficeTabsStore.getState()
    expect(state.tabs.map((tab) => tab.documentId)).toEqual(['a', 'b', 'c'])
    expect(state.tabs.find((tab) => tab.id === state.activeTabId)?.documentId).toBe('b')
    // 单例：第二次不再调 IPC
    await restoreOfficeSessionOnce()
    expect(restore).toHaveBeenCalledTimes(1)
  })

  it('restore 异常静默（不抛、返回 0）', async () => {
    window.kyclaw.office.sessionRestore = vi.fn(async () => {
      throw new Error('boom')
    })
    await expect(restoreOfficeSessionOnce()).resolves.toEqual({
      restored: 0,
      modifiedOnDisk: 0,
      skipped: 0
    })
  })
})
