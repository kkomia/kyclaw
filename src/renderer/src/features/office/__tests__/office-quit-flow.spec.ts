import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelQuitOutcome,
  discardQuitOutcome,
  isOfficeQuitInFlight,
  officeQuitActionOf,
  pendingOfficeQuitRequest,
  quitSaveTargets,
  resetOfficeQuitFlowForTest,
  saveAllBeforeQuit,
  setPendingOfficeQuitRequest,
  useOfficeQuitStore
} from '../office-quit-flow'
import { resetOfficeTabsStore, type OfficeTab } from '../office-tabs-store'
import { countDirtyOfficeTabs } from '../use-office-dirty-reporter'

beforeEach(() => {
  resetOfficeQuitFlowForTest()
  resetOfficeTabsStore()
})

afterEach(() => {
  resetOfficeQuitFlowForTest()
  resetOfficeTabsStore()
})

/** 造一个标签（只填与退出保存相关的字段） */
function tab(id: string, title: string, patch: Partial<OfficeTab> = {}): OfficeTab {
  return {
    id,
    kind: 'docx',
    title,
    dirty: true,
    readOnly: false,
    lastActiveAt: 0,
    ...patch
  }
}

describe('quitSaveTargets / countDirtyOfficeTabs：只算"脏且非只读"', () => {
  it('脏标签按 store 顺序返回；干净标签与只读标签都跳过（只读不可能有未保存修改）', () => {
    const tabs = [
      tab('a', 'A'),
      tab('b', 'B', { dirty: false }),
      tab('c', 'C', { readOnly: true }),
      tab('d', 'D')
    ]
    expect(quitSaveTargets(tabs).map((entry) => entry.id)).toEqual(['a', 'd'])
    expect(countDirtyOfficeTabs(tabs)).toBe(2)
    // 只读 + 干净 → 0；空列表 → 0（主进程本来也不会问）
    expect(countDirtyOfficeTabs([tab('x', 'X', { readOnly: true })])).toBe(0)
    expect(countDirtyOfficeTabs([])).toBe(0)
  })
})

describe('saveAllBeforeQuit：串行保存全部', () => {
  it('全成功：按顺序逐个保存，进度事件是 0/2 → 1/2 → 2/2，结果 saved', async () => {
    const saved: string[] = []
    const progress: Array<{ done: number; total: number; currentTitle?: string }> = []
    const outcome = await saveAllBeforeQuit({
      tabs: [tab('a', '方案.docx'), tab('b', '报告.docx')],
      saveTab: async (entry) => {
        saved.push(entry.id)
        return true
      },
      onProgress: (event) => progress.push(event)
    })

    expect(outcome).toEqual({ result: 'saved' })
    expect(saved).toEqual(['a', 'b'])
    expect(progress).toEqual([
      { done: 0, total: 2, currentId: 'a', currentTitle: '方案.docx' },
      { done: 1, total: 2, currentId: 'b', currentTitle: '报告.docx' },
      { done: 2, total: 2 }
    ])
  })

  it('中途失败：停在失败项（后面的不再保存），结果 cancelled + 失败项信息', async () => {
    const saved: string[] = []
    const outcome = await saveAllBeforeQuit({
      tabs: [tab('a', 'A.docx'), tab('b', 'B.docx'), tab('c', 'C.docx')],
      saveTab: async (entry) => {
        saved.push(entry.id)
        return entry.id !== 'b'
      }
    })

    expect(saved).toEqual(['a', 'b'])
    expect(outcome.result).toBe('cancelled')
    if (outcome.result === 'cancelled') {
      expect(outcome.failure?.id).toBe('b')
      expect(outcome.failure?.title).toBe('B.docx')
      expect(outcome.failure?.message).toContain('B.docx')
      expect(outcome.failure?.message).toContain('保存失败')
    }
  })

  it('保存动作抛错也按失败处理（不把退出流程带崩）', async () => {
    const outcome = await saveAllBeforeQuit({
      tabs: [tab('a', 'A.docx')],
      saveTab: async () => {
        throw new Error('IPC 断了')
      }
    })
    expect(outcome.result).toBe('cancelled')
    if (outcome.result === 'cancelled') expect(outcome.failure?.id).toBe('a')
  })

  it('没有要保存的标签：直接 saved（主进程本不该问，防御路径）', async () => {
    const saveTab = vi.fn(async () => true)
    const progress: number[] = []
    const outcome = await saveAllBeforeQuit({
      tabs: [tab('a', 'A.docx', { dirty: false }), tab('b', 'B.docx', { readOnly: true })],
      saveTab,
      onProgress: (event) => progress.push(event.done)
    })

    expect(outcome).toEqual({ result: 'saved' })
    expect(saveTab).not.toHaveBeenCalled()
    expect(progress).toEqual([0])
  })
})

describe('三态决策 → 主进程动作', () => {
  it('saved / discarded / cancelled 一一对应（discarded 直接执行，不再叠二次确认）', () => {
    expect(officeQuitActionOf({ result: 'saved' })).toBe('saved')
    expect(officeQuitActionOf(discardQuitOutcome())).toBe('discarded')
    expect(officeQuitActionOf(cancelQuitOutcome())).toBe('cancelled')
    expect(cancelQuitOutcome().result).toBe('cancelled')
  })
})

describe('壳内待决退出请求（唯一来源）', () => {
  it('写入 / 读取 / 清空；isOfficeQuitInFlight 跟着 request 变化', () => {
    expect(pendingOfficeQuitRequest()).toBeNull()
    expect(isOfficeQuitInFlight()).toBe(false)

    setPendingOfficeQuitRequest({ requestId: 'req-1', reason: 'quit', dirtyCount: 2 })
    expect(pendingOfficeQuitRequest()).toEqual({
      requestId: 'req-1',
      reason: 'quit',
      dirtyCount: 2
    })
    expect(isOfficeQuitInFlight()).toBe(true)

    setPendingOfficeQuitRequest(null)
    expect(pendingOfficeQuitRequest()).toBeNull()
    expect(isOfficeQuitInFlight()).toBe(false)
  })

  it('store 只会有一份请求（新请求覆盖旧的；主进程一次只问一个）', () => {
    setPendingOfficeQuitRequest({ requestId: 'req-1', reason: 'quit', dirtyCount: 1 })
    setPendingOfficeQuitRequest({ requestId: 'req-2', reason: 'close', dirtyCount: 3 })
    expect(useOfficeQuitStore.getState().request?.requestId).toBe('req-2')
  })
})
