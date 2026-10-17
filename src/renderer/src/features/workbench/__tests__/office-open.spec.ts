import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OfficeOpenResult } from '@shared/office-editor'
import {
  clearKyclawBridge,
  installKyclawBridge,
  officeDocumentFixture,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import {
  resetOfficeTabsStore,
  useOfficeTabsStore
} from '@renderer/features/office/office-tabs-store'
import {
  goToOffice,
  isOfficeEditablePath,
  officeTabForPreview,
  openOfficeFromSession,
  resetOfficeOpenState
} from '../office-open'

/**
 * 聊天交付卡 / 文件树 / 预览提示三处共用的 Office 打开逻辑：
 * ① .docx 判定；② `openFromSession` 成功才写 store（按 documentId 去重/激活）、失败抛人话；
 * ③ 跳 /office（HashRouter 口径）；④ 预览按"同一文件"匹配 Open 标签（绝对路径优先，跨工作区不误报）。
 */
let bridge: KyclawBridgeStubs

function okResult(absolutePath: string, extra: { displayPath?: string } = {}): OfficeOpenResult {
  return {
    ok: true as const,
    document: officeDocumentFixture({
      displayPath: extra.displayPath ?? 'docs/方案.docx',
      absolutePath
    }),
    alreadyOpen: false
  }
}

beforeEach(() => {
  resetOfficeTabsStore()
  resetOfficeOpenState()
  bridge = installKyclawBridge()
  window.location.hash = ''
})

afterEach(() => {
  clearKyclawBridge()
  resetOfficeTabsStore()
  resetOfficeOpenState()
  window.location.hash = ''
})

describe('isOfficeEditablePath：第一步只认 .docx', () => {
  it('.docx（大小写不敏感）算；doc / docx 备份名 / 目录都不算', () => {
    expect(isOfficeEditablePath('docs/方案.docx')).toBe(true)
    expect(isOfficeEditablePath('docs/方案.DOCX')).toBe(true)
    expect(isOfficeEditablePath('方案.doc')).toBe(false)
    expect(isOfficeEditablePath('方案.docx.bak')).toBe(false)
    expect(isOfficeEditablePath('docx/readme.txt')).toBe(false)
    expect(isOfficeEditablePath('')).toBe(false)
  })
})

describe('goToOffice：HashRouter 口径跳转', () => {
  it('把 hash 设成 #/office；已经在 /office 时不重复设', () => {
    goToOffice()
    expect(window.location.hash).toBe('#/office')

    window.location.hash = '#/chat'
    goToOffice()
    expect(window.location.hash).toBe('#/office')
  })
})

describe('openOfficeFromSession：打开 / 去重 / 失败不落标签', () => {
  it('成功：主进程只收 threadId + 相对路径；store 按 documentId 落标签并激活', async () => {
    bridge.office.openFromSession.mockResolvedValue(okResult('D:\\工作区\\docs\\方案.docx'))

    const result = await openOfficeFromSession('thread-1', 'docs/方案.docx')

    expect(bridge.office.openFromSession).toHaveBeenCalledWith('thread-1', 'docs/方案.docx')
    expect(result.alreadyOpen).toBe(false)
    const state = useOfficeTabsStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({
      id: result.tabId,
      kind: 'docx',
      title: '方案.docx',
      path: 'docs/方案.docx',
      documentId: 'doc-1',
      dirty: false
    })
    expect(state.activeTabId).toBe(result.tabId)
  })

  it('同一文件点两次：只激活同一标签，不重复开（第二次 alreadyOpen）', async () => {
    bridge.office.openFromSession
      .mockResolvedValueOnce(okResult('D:\\工作区\\docs\\方案.docx'))
      .mockResolvedValueOnce({
        ok: true,
        document: officeDocumentFixture({
          displayPath: 'docs/方案.docx',
          absolutePath: 'D:\\工作区\\docs\\方案.docx'
        }),
        alreadyOpen: true
      })

    const first = await openOfficeFromSession('thread-1', 'docs/方案.docx')
    const second = await openOfficeFromSession('thread-1', 'docs/方案.docx')

    expect(bridge.office.openFromSession).toHaveBeenCalledTimes(2)
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(1)
    expect(second.tabId).toBe(first.tabId)
    expect(second.alreadyOpen).toBe(true)
  })

  it('分类失败（未授权 / 非 docx / 文件没了）：抛主进程那道人话，store 不落标签', async () => {
    bridge.office.openFromSession.mockResolvedValue({
      ok: false,
      code: 'unreadable',
      message: '读不了这个文件：它可能已损坏、无权限，或不是普通文件'
    })

    await expect(openOfficeFromSession('thread-1', 'docs/方案.docx')).rejects.toThrow(
      '读不了这个文件'
    )
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(0)
  })

  it('Office 通道缺失：给人话错误，不假装打开', async () => {
    clearKyclawBridge()

    await expect(openOfficeFromSession('thread-1', 'docs/方案.docx')).rejects.toThrow(
      'Office 通道不可用'
    )
  })
})

describe('officeTabForPreview：同一文件匹配（绝对路径优先，跨工作区不误报）', () => {
  const root = 'D:\\工作区'

  it('没有标签 / 非 docx 标签 / 别的文件：都不命中', () => {
    expect(officeTabForPreview([], root, 'docs/方案.docx')).toBeUndefined()

    // 别的类型标签（pptx）不参与匹配
    useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'D:\\工作区\\汇报.pptx' })
    expect(officeTabForPreview(useOfficeTabsStore.getState().tabs, root, 'docs/方案.docx')).toBe(
      undefined
    )

    useOfficeTabsStore.getState().openDocument(
      officeDocumentFixture({
        documentId: 'doc-9',
        displayPath: 'D:\\工作区\\别的.docx',
        absolutePath: 'D:\\工作区\\别的.docx'
      })
    )
    expect(officeTabForPreview(useOfficeTabsStore.getState().tabs, root, 'docs/方案.docx')).toBe(
      undefined
    )
  })

  it('选择器打开的标签（displayPath 是绝对路径）：命中同一个文件', () => {
    const tabId = useOfficeTabsStore.getState().openDocument(
      officeDocumentFixture({
        displayPath: 'D:\\工作区\\docs\\方案.docx',
        absolutePath: 'D:\\工作区\\docs\\方案.docx'
      })
    )

    expect(
      officeTabForPreview(useOfficeTabsStore.getState().tabs, root, 'docs/方案.docx')?.id
    ).toBe(tabId)
  })

  it('会话打开的标签（displayPath 是相对路径）：相对/绝对双候选都能命中', () => {
    const tabId = useOfficeTabsStore.getState().openDocument(
      officeDocumentFixture({
        displayPath: 'docs/方案.docx',
        absolutePath: 'D:\\工作区\\docs\\方案.docx'
      })
    )

    expect(
      officeTabForPreview(useOfficeTabsStore.getState().tabs, root, 'docs/方案.docx')?.id
    ).toBe(tabId)
  })

  it('经本模块入口打开的标签只认绝对路径：跨工作区同名相对路径不误报', async () => {
    bridge.office.openFromSession.mockResolvedValue(
      okResult('D:\\工作区A\\docs\\方案.docx', { displayPath: 'docs/方案.docx' })
    )
    await openOfficeFromSession('thread-a', 'docs/方案.docx')
    const tabs = useOfficeTabsStore.getState().tabs

    // 同根：命中
    expect(officeTabForPreview(tabs, 'D:\\工作区A', 'docs/方案.docx')?.id).toBe(tabs[0]?.id)
    // 另一个工作区里的同名相对路径：不误报（绝对路径对不上）
    expect(officeTabForPreview(tabs, 'D:\\工作区B', 'docs/方案.docx')).toBeUndefined()
  })

  it('预览的本身不是 docx 时不做匹配（不给假提示）', () => {
    useOfficeTabsStore.getState().openDocument(
      officeDocumentFixture({
        displayPath: 'docs/方案.docx',
        absolutePath: 'D:\\工作区\\docs\\方案.docx'
      })
    )

    expect(officeTabForPreview(useOfficeTabsStore.getState().tabs, root, 'docs/说明.txt')).toBe(
      undefined
    )
  })
})
describe('officeTabForPreview：M3-S4 读 OfficeTab.absolutePath（跨工作区同名不误报）', () => {
  it('会话入口打开的标签：absolutePath 落进标签，匹配按绝对路径而不是相对 displayPath', async () => {
    bridge.office.openFromSession.mockResolvedValue(
      okResult('D:\\工作区A\\docs\\方案.docx', { displayPath: 'docs/方案.docx' })
    )
    const opened = await openOfficeFromSession('thread-a', 'docs/方案.docx')
    expect(useOfficeTabsStore.getState().tabs[0]?.absolutePath).toBe('D:\\工作区A\\docs\\方案.docx')

    const tabs = useOfficeTabsStore.getState().tabs
    expect(officeTabForPreview(tabs, 'D:\\工作区A', 'docs/方案.docx')?.id).toBe(opened.tabId)
    // 另一个工作区里的同名相对路径：绝对路径对不上 → 不误报
    expect(officeTabForPreview(tabs, 'D:\\工作区B', 'docs/方案.docx')).toBeUndefined()
  })

  it('两个标签 displayPath 相同但 absolutePath 不同：按根各命中各的', () => {
    useOfficeTabsStore.getState().openDocument(
      officeDocumentFixture({
        documentId: 'doc-a',
        displayPath: 'docs/方案.docx',
        absolutePath: 'D:\\工作区A\\docs\\方案.docx'
      })
    )
    const tabB = useOfficeTabsStore.getState().openDocument(
      officeDocumentFixture({
        documentId: 'doc-b',
        displayName: '方案.docx',
        displayPath: 'docs/方案.docx',
        absolutePath: 'D:\\工作区B\\docs\\方案.docx'
      })
    )
    const tabs = useOfficeTabsStore.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(officeTabForPreview(tabs, 'D:\\工作区B', 'docs/方案.docx')?.id).toBe(tabB)
    expect(officeTabForPreview(tabs, 'D:\\工作区C', 'docs/方案.docx')).toBeUndefined()
  })

  it('rootPath 判不出（null）：有绝对路径身份也不误报（宁可漏提示）', () => {
    useOfficeTabsStore.getState().openDocument(
      officeDocumentFixture({
        displayPath: 'docs/方案.docx',
        absolutePath: 'D:\\工作区\\docs\\方案.docx'
      })
    )
    expect(officeTabForPreview(useOfficeTabsStore.getState().tabs, null, 'docs/方案.docx')).toBe(
      undefined
    )
  })
})
