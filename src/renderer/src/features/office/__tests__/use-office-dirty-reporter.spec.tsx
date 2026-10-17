import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeQuitRequestPayload } from '@shared/office-editor'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import {
  isOfficeQuitInFlight,
  pendingOfficeQuitRequest,
  resetOfficeQuitFlowForTest
} from '../office-quit-flow'
import { resetOfficeTabsStore, useOfficeTabsStore } from '../office-tabs-store'
import { resetOfficeUiStore, useOfficeUiStore } from '../office-ui-store'
import { useOfficeDirtyReporter } from '../use-office-dirty-reporter'

let bridge: KyclawBridgeStubs

beforeEach(() => {
  resetOfficeTabsStore()
  resetOfficeQuitFlowForTest()
  resetOfficeUiStore()
  bridge = installKyclawBridge()
})

afterEach(() => {
  clearKyclawBridge()
  resetOfficeTabsStore()
  resetOfficeQuitFlowForTest()
  resetOfficeUiStore()
})

/** 在 store 里开一个标签并置脏（模拟用户编辑 → save-machine 的回调投影） */
function seedDirtyTab(path: string): string {
  let id = ''
  act(() => {
    id = useOfficeTabsStore.getState().open({ kind: 'docx', path })
    useOfficeTabsStore.getState().markDirty(id, true)
  })
  return id
}

describe('useOfficeDirtyReporter：脏计数上报', () => {
  it('挂载即上报当前计数；只传数字、变化即推（不 debounce）；卸载不推 0', () => {
    const { unmount } = renderHook(() => useOfficeDirtyReporter())

    expect(bridge.office.reportDirtyState).toHaveBeenCalledTimes(1)
    expect(bridge.office.reportDirtyState).toHaveBeenLastCalledWith(0)

    // 1 个脏标签 → 1；再加一个 → 2；保存掉一个 → 1；全部保存 → 0（连续推，不等节流）
    seedDirtyTab('D:\\a.docx')
    expect(bridge.office.reportDirtyState).toHaveBeenLastCalledWith(1)
    const second = seedDirtyTab('D:\\b.docx')
    expect(bridge.office.reportDirtyState).toHaveBeenLastCalledWith(2)
    act(() => useOfficeTabsStore.getState().markSaved(second))
    expect(bridge.office.reportDirtyState).toHaveBeenLastCalledWith(1)

    const callsBeforeUnmount = bridge.office.reportDirtyState.mock.calls.length
    unmount()
    // 卸载后不再有新的上报（尤其不能补一条 0）
    expect(bridge.office.reportDirtyState.mock.calls.length).toBe(callsBeforeUnmount)
    act(() => {
      useOfficeTabsStore.getState().markDirty(second, true)
    })
    expect(bridge.office.reportDirtyState.mock.calls.length).toBe(callsBeforeUnmount)
  })

  it('标签数组换引用但计数没变也照推（主进程只做快速判空，幂等无害）', () => {
    renderHook(() => useOfficeDirtyReporter())
    expect(bridge.office.reportDirtyState).toHaveBeenCalledTimes(1)
    act(() => {
      const id = useOfficeTabsStore.getState().open({ kind: 'docx', path: 'D:\\c.docx' })
      useOfficeTabsStore.getState().markDirty(id, false)
    })
    expect(bridge.office.reportDirtyState).toHaveBeenLastCalledWith(0)
  })

  it('桥不存在（独立渲染壳的单测 / 启动早期）：不抛、不崩', () => {
    clearKyclawBridge()
    const { result } = renderHook(() => useOfficeDirtyReporter())
    expect(result.current).toBeNull()
    seedDirtyTab('D:\\d.docx')
    expect(pendingOfficeQuitRequest()).toBeNull()
  })
})

describe('useOfficeDirtyReporter：主进程退出请求订阅', () => {
  it('收到请求写进唯一来源（hook 返回值），顺手收掉打开文件弹窗；卸载退订', () => {
    let captured: ((payload: OfficeQuitRequestPayload) => void) | undefined
    const unsubscribe = vi.fn()
    bridge.office.onQuitRequest.mockImplementation((listener) => {
      captured = listener
      return unsubscribe
    })

    const { result, unmount } = renderHook(() => useOfficeDirtyReporter())
    expect(bridge.office.onQuitRequest).toHaveBeenCalledTimes(1)
    expect(captured).toBeDefined()
    expect(result.current).toBeNull()

    act(() => useOfficeUiStore.getState().openPicker())
    expect(useOfficeUiStore.getState().pickerOpen).toBe(true)

    const payload: OfficeQuitRequestPayload = { requestId: 'req-1', reason: 'quit', dirtyCount: 2 }
    act(() => captured?.(payload))

    expect(result.current).toEqual(payload)
    expect(pendingOfficeQuitRequest()).toEqual(payload)
    expect(isOfficeQuitInFlight()).toBe(true)
    // 同层弹窗互斥：打开文件弹窗被收掉，只剩退出确认
    expect(useOfficeUiStore.getState().pickerOpen).toBe(false)

    unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('两次请求：后到的覆盖先到的（主进程一次只问一个）', () => {
    let captured: ((payload: OfficeQuitRequestPayload) => void) | undefined
    bridge.office.onQuitRequest.mockImplementation((listener) => {
      captured = listener
      return vi.fn()
    })
    const { result } = renderHook(() => useOfficeDirtyReporter())

    act(() => captured?.({ requestId: 'req-1', reason: 'quit', dirtyCount: 1 }))
    act(() => captured?.({ requestId: 'req-2', reason: 'close', dirtyCount: 3 }))
    expect(result.current?.requestId).toBe('req-2')
    expect(result.current?.reason).toBe('close')
  })
})
