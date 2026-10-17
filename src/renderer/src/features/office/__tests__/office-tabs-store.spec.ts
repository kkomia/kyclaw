import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { officeDocumentFixture } from '@renderer/__tests__/kyclaw-bridge'
import { OFFICE_TAB_KINDS, resetOfficeTabsStore, useOfficeTabsStore } from '../office-tabs-store'

beforeEach(() => {
  resetOfficeTabsStore()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('office-tabs-store：独立于会话的标签模型', () => {
  it('只有文档/网页七种 kind，没有 chat/session；也不带 threadId（主对话不进标签体系）', () => {
    expect(OFFICE_TAB_KINDS).toEqual(['docx', 'pptx', 'xlsx', 'pdf', 'image', 'text', 'web'])
    expect(OFFICE_TAB_KINDS).not.toContain('chat')
    expect(OFFICE_TAB_KINDS).not.toContain('session')

    const state = useOfficeTabsStore.getState()
    expect(state.tabs).toEqual([])
    expect(state.activeTabId).toBe('')
    expect('threadId' in state).toBe(false)
  })

  it('按路径去重、web 按 URL 去重；重复打开只激活已有的那个', () => {
    const { open } = useOfficeTabsStore.getState()
    const docx = open({ kind: 'docx', path: 'D:\\工作\\方案.docx' })
    const first = useOfficeTabsStore.getState().tabs[0]
    expect(first?.id).toBe(docx)
    expect(first?.title).toBe('方案.docx')

    open({ kind: 'pptx', path: 'D:\\工作\\汇报.pptx' })
    expect(useOfficeTabsStore.getState().activeTabId).not.toBe(docx)

    // 同一路径：不重新开，只激活（引用都不换）
    const reopened = open({ kind: 'docx', path: 'D:\\工作\\方案.docx' })
    expect(reopened).toBe(docx)
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(2)
    expect(useOfficeTabsStore.getState().activeTabId).toBe(docx)

    // web 类按 URL 去重，标题默认取主机名
    const web = open({ kind: 'web', url: 'https://example.com/a/b' })
    const webTab = useOfficeTabsStore.getState().tabs.find((tab) => tab.id === web)
    expect(webTab?.title).toBe('example.com')
    open({ kind: 'web', url: 'https://example.com/a/b', title: '另一个标题' })
    expect(useOfficeTabsStore.getState().tabs.filter((tab) => tab.kind === 'web')).toHaveLength(1)
    expect(useOfficeTabsStore.getState().activeTabId).toBe(web)
  })

  it('切标签不丢状态：dirty / readOnly / 标题都跟着标签，重复打开也不重置', () => {
    const { open, activate, markDirty } = useOfficeTabsStore.getState()
    const docx = open({ kind: 'docx', path: 'D:\\工作\\方案.docx', readOnly: true })
    markDirty(docx)

    const pptx = open({ kind: 'pptx', path: 'D:\\工作\\汇报.pptx' })
    expect(useOfficeTabsStore.getState().activeTabId).toBe(pptx)

    activate(docx)
    const selected = useOfficeTabsStore.getState().tabs.find((tab) => tab.id === docx)
    expect(selected).toMatchObject({
      id: docx,
      kind: 'docx',
      title: '方案.docx',
      dirty: true,
      readOnly: true
    })
    expect(useOfficeTabsStore.getState().activeTabId).toBe(docx)

    // 再开一次同一路径：只激活，不把 dirty / readOnly 洗掉
    open({ kind: 'docx', path: 'D:\\工作\\方案.docx' })
    expect(useOfficeTabsStore.getState().tabs.find((tab) => tab.id === docx)).toMatchObject({
      dirty: true,
      readOnly: true
    })
    expect(useOfficeTabsStore.getState().activeTabId).toBe(docx)
  })

  it('lastActiveAt：打开时落时间，再次激活会刷新，非当前标签不受影响', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const { open, activate } = useOfficeTabsStore.getState()
    const docx = open({ kind: 'docx', path: 'a.docx' })
    vi.setSystemTime(2_000)
    const pptx = open({ kind: 'pptx', path: 'b.pptx' })

    const at = (id: string): number | undefined =>
      useOfficeTabsStore.getState().tabs.find((tab) => tab.id === id)?.lastActiveAt
    expect(at(docx)).toBe(1_000)
    expect(at(pptx)).toBe(2_000)

    vi.setSystemTime(3_000)
    activate(docx)
    expect(at(docx)).toBe(3_000)
    expect(at(pptx)).toBe(2_000)
  })

  it('close 返回是否真的关闭；关当前接左邻居；closeAll 清空', () => {
    const { open, close, closeAll } = useOfficeTabsStore.getState()
    const docx = open({ kind: 'docx', path: 'a.docx' })
    const pptx = open({ kind: 'pptx', path: 'b.pptx' })
    const xlsx = open({ kind: 'xlsx', path: 'c.xlsx' })

    expect(close('不存在的标签')).toBe(false)
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(3)

    // 关一个不是当前的：当前标签不动
    expect(close(pptx)).toBe(true)
    expect(useOfficeTabsStore.getState().activeTabId).toBe(xlsx)

    // 关当前：接到左边那个
    expect(close(xlsx)).toBe(true)
    expect(useOfficeTabsStore.getState().activeTabId).toBe(docx)

    closeAll()
    expect(useOfficeTabsStore.getState().tabs).toEqual([])
    expect(useOfficeTabsStore.getState().activeTabId).toBe('')
  })

  it('reorder：按 id 移到目标下标，越界夹取，激活不变', () => {
    const { open, reorder } = useOfficeTabsStore.getState()
    const docx = open({ kind: 'docx', path: 'a.docx' })
    const pptx = open({ kind: 'pptx', path: 'b.pptx' })
    const xlsx = open({ kind: 'xlsx', path: 'c.xlsx' })
    const ids = (): string[] => useOfficeTabsStore.getState().tabs.map((tab) => tab.id)

    reorder(xlsx, 0)
    expect(ids()).toEqual([xlsx, docx, pptx])
    expect(useOfficeTabsStore.getState().activeTabId).toBe(xlsx)

    reorder(xlsx, 99)
    expect(ids()).toEqual([docx, pptx, xlsx])

    const before = useOfficeTabsStore.getState().tabs
    reorder('没有这个标签', 0)
    expect(useOfficeTabsStore.getState().tabs).toBe(before)
  })

  it('markSaved 清 dirty；tabsOfKind 只交该类型的标签（保持显示顺序）', () => {
    const { open, markDirty, markSaved, tabsOfKind } = useOfficeTabsStore.getState()
    const first = open({ kind: 'docx', path: 'a.docx' })
    const sheet = open({ kind: 'xlsx', path: 'b.xlsx' })
    const second = open({ kind: 'docx', path: 'c.docx' })

    markDirty(first)
    markDirty(sheet)
    expect(tabsOfKind('docx').map((tab) => tab.id)).toEqual([first, second])
    expect(tabsOfKind('web')).toEqual([])

    markSaved(first)
    expect(useOfficeTabsStore.getState().tabs.find((tab) => tab.id === first)?.dirty).toBe(false)
    expect(useOfficeTabsStore.getState().tabs.find((tab) => tab.id === sheet)?.dirty).toBe(true)
  })
})

describe('office-tabs-store：M3-S2 openDocument（按 documentId 去重）', () => {
  it('documentId 去重：二次打开只激活，不重置 dirty/readOnly；不同 id 才开新标签', () => {
    const first = officeDocumentFixture({ documentId: 'doc-1', displayName: '方案.docx' })
    const id = useOfficeTabsStore.getState().openDocument(first)
    const tab = useOfficeTabsStore.getState().tabs.find((item) => item.id === id)

    expect(tab).toMatchObject({
      kind: 'docx',
      title: '方案.docx',
      path: 'D:\\工作\\方案.docx',
      documentId: 'doc-1',
      dirty: false,
      readOnly: false
    })

    useOfficeTabsStore.getState().markDirty(id)
    // 同一 documentId、displayPath 换成会话相对路径：只激活，仍是同一个标签
    const again = useOfficeTabsStore
      .getState()
      .openDocument(
        officeDocumentFixture({ documentId: 'doc-1', displayPath: '方案.docx', readOnly: true })
      )
    expect(again).toBe(id)
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(1)
    expect(useOfficeTabsStore.getState().tabs[0]).toMatchObject({ dirty: true, readOnly: false })

    // 另一个 documentId（同一显示路径也不算同一份）：开新标签
    const other = useOfficeTabsStore
      .getState()
      .openDocument(officeDocumentFixture({ documentId: 'doc-2', displayName: '另一份.docx' }))
    expect(other).not.toBe(id)
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(2)
    expect(useOfficeTabsStore.getState().activeTabId).toBe(other)
  })

  it('readOnly 跟主进程回包走（只读打开的标签如实标记）', () => {
    const id = useOfficeTabsStore
      .getState()
      .openDocument(officeDocumentFixture({ documentId: 'doc-ro', readOnly: true }))
    expect(useOfficeTabsStore.getState().tabs.find((tab) => tab.id === id)?.readOnly).toBe(true)
  })
})
