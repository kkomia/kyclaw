import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearKyclawBridge,
  installKyclawBridge,
  officeDocumentFixture,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import {
  closeOfficeTab,
  handleOfficeShortcut,
  registerOfficeShortcutHandler,
  officeRuntimeOf,
  registerOfficeRuntime,
  resetOfficeActionsForTest,
  saveOfficeTab
} from '../office-actions'
import { resetOfficeTabsStore, useOfficeTabsStore, type OfficeTab } from '../office-tabs-store'

/**
 * 模块级 Office 动作/运行时注册表（M3-S3）：常驻 AppTabBar（TitleBar 子树）与 OfficePage
 * 是兄弟子树，运行时要能跨子树找到 —— 这里验注册/查找/保存/关闭/快捷键分发的语义。
 */
let bridge: KyclawBridgeStubs

beforeEach(() => {
  resetOfficeTabsStore()
  resetOfficeActionsForTest()
  bridge = installKyclawBridge()
})

afterEach(() => {
  clearKyclawBridge()
  resetOfficeActionsForTest()
})

/** 开一个 docx 标签并返回标签对象 */
function openDocxTab(documentId = 'doc-1'): OfficeTab {
  const id = useOfficeTabsStore
    .getState()
    .openDocument(officeDocumentFixture({ documentId, displayName: '方案.docx' }))
  const tab = useOfficeTabsStore.getState().tabs.find((entry) => entry.id === id)
  if (tab === undefined) throw new Error('标签没开出来')
  return tab
}

describe('office-actions：运行时注册表', () => {
  it('注册后按 documentId 找到；注销后查不到；同一 id 重注册覆盖', () => {
    const first = { save: vi.fn(async () => true), close: vi.fn(async () => undefined) }
    const unregister = registerOfficeRuntime('doc-1', first)
    expect(officeRuntimeOf('doc-1')).toBe(first)

    const second = { save: vi.fn(async () => false), close: vi.fn(async () => undefined) }
    const unregisterSecond = registerOfficeRuntime('doc-1', second)
    expect(officeRuntimeOf('doc-1')).toBe(second)

    unregister()
    expect(officeRuntimeOf('doc-1')).toBe(second)
    unregisterSecond()
    expect(officeRuntimeOf('doc-1')).toBeUndefined()
  })

  it('旧 runtime 的注销函数不会误删新 runtime', () => {
    const first = { save: vi.fn(async () => true), close: vi.fn(async () => undefined) }
    const second = { save: vi.fn(async () => true), close: vi.fn(async () => undefined) }
    const unregisterFirst = registerOfficeRuntime('doc-1', first)
    registerOfficeRuntime('doc-1', second)
    unregisterFirst()
    expect(officeRuntimeOf('doc-1')).toBe(second)
  })
})

describe('office-actions：saveOfficeTab / closeOfficeTab', () => {
  it('saveOfficeTab：有运行时走运行时；没有 documentId / 没有运行时一律 false（不伪造成功）', async () => {
    const tab = openDocxTab('doc-1')
    expect(await saveOfficeTab(tab)).toBe(false)

    const save = vi.fn(async () => true)
    registerOfficeRuntime('doc-1', { save, close: vi.fn(async () => undefined) })
    expect(await saveOfficeTab(tab)).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)

    expect(await saveOfficeTab(undefined)).toBe(false)
  })

  it('closeOfficeTab：面 doc:close → office:release → store close；释放失败不挡关标签', async () => {
    const tab = openDocxTab('doc-1')
    const close = vi.fn(async () => undefined)
    registerOfficeRuntime('doc-1', { save: vi.fn(async () => true), close })
    bridge.office.release.mockResolvedValue(undefined)

    await closeOfficeTab(tab)
    expect(close).toHaveBeenCalledTimes(1)
    expect(bridge.office.release).toHaveBeenCalledWith('doc-1')
    expect(officeRuntimeOf('doc-1')).toBeUndefined()
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(0)

    // 主进程 release 抛错（越权/已经释放）：不冒泡、标签照样关
    const tab2 = openDocxTab('doc-2')
    bridge.office.release.mockRejectedValue(new Error('boom'))
    await expect(closeOfficeTab(tab2)).resolves.toBeUndefined()
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(0)
  })
})

describe('office-actions：快捷键统一分发（S4）', () => {
  it('没有注册分发器时只兜底 save：有 active 文档且有运行时就保存；无标签返回 false', async () => {
    expect(handleOfficeShortcut('save')).toBe(false)

    const tab = openDocxTab('doc-1')
    expect(handleOfficeShortcut('save')).toBe(true) // 有标签：消费按键（即使运行时空）
    const save = vi.fn(async () => true)
    registerOfficeRuntime('doc-1', { save, close: vi.fn(async () => undefined) })
    handleOfficeShortcut('save')
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(1)
    expect(useOfficeTabsStore.getState().activeTabId).toBe(tab.id)

    // 没有分发器时 close/next/prev 不消费（留给常驻 AppTabBar 的门控逻辑）
    expect(handleOfficeShortcut('close')).toBe(false)
    expect(handleOfficeShortcut('next-tab')).toBe(false)
    expect(handleOfficeShortcut('prev-tab')).toBe(false)
  })

  it('注册分发器后：所有动作（含面内 surface:shortcut）原样委托给它，返回值即"是否消费按键"', () => {
    openDocxTab('doc-1')
    const seen: string[] = []
    const handler = vi.fn((action: string) => {
      seen.push(action)
      return action !== 'prev-tab'
    })
    const unregister = registerOfficeShortcutHandler(
      handler as unknown as Parameters<typeof registerOfficeShortcutHandler>[0]
    )

    expect(handleOfficeShortcut('save')).toBe(true)
    expect(handleOfficeShortcut('close')).toBe(true)
    expect(handleOfficeShortcut('next-tab')).toBe(true)
    expect(handleOfficeShortcut('prev-tab')).toBe(false)
    expect(seen).toEqual(['save', 'close', 'next-tab', 'prev-tab'])
    expect(handler).toHaveBeenCalledTimes(4)

    unregister()
    // 注销后回落到兜底（save 仍能保存，close 不再消费）
    expect(handleOfficeShortcut('close')).toBe(false)
  })

  it('后注册的分发器覆盖前一个；旧的注销函数不会误删新分发器；reset 清空', () => {
    openDocxTab('doc-1')
    const first = vi.fn(() => false)
    const second = vi.fn(() => true)
    const unregisterFirst = registerOfficeShortcutHandler(first)
    const unregisterSecond = registerOfficeShortcutHandler(second)

    expect(handleOfficeShortcut('save')).toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()

    unregisterFirst()
    expect(handleOfficeShortcut('save')).toBe(true)
    expect(second).toHaveBeenCalledTimes(2)

    unregisterSecond()
    resetOfficeActionsForTest()
    expect(handleOfficeShortcut('save')).toBe(true) // 兜底 save
  })
})
