import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearKyclawBridge,
  installKyclawBridge,
  officeDocumentFixture,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { OfficePage } from '../OfficePage'
import { resetOfficeTabsStore, useOfficeTabsStore } from '../office-tabs-store'
import { resetOfficeUiStore, useOfficeUiStore } from '../office-ui-store'

beforeEach(() => {
  resetOfficeTabsStore()
  resetOfficeUiStore()
  useSessionsStore.setState({ activeId: null })
  document.documentElement.removeAttribute('data-theme')
})

afterEach(() => {
  clearKyclawBridge()
  document.documentElement.removeAttribute('data-theme')
})

/** PB-023：Office 文档是 ZIP 容器；测试字节补上 ZIP 魔数（真实读取路径会先校验） */
function withZipMagic(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length)
  out.set([0x50, 0x4b, 0x03, 0x04])
  out.set(bytes, 4)
  return out
}

/** 装桥 + 让 office:read 默认回一份可显示文档（标签打开后 workspace 才有内容） */
function installOfficeBridge(
  document = officeDocumentFixture(),
  bytes = new Uint8Array([1, 2, 3])
): KyclawBridgeStubs {
  const bridge = installKyclawBridge()
  bridge.office.read.mockResolvedValue({ ok: true, document, bytes: withZipMagic(bytes) })
  return bridge
}

describe('OfficePage：空态与真实「打开文件」（M3-S2）', () => {
  it('空态：标题 + 说明 + 「打开文件」入口；没有聊天、会话列表或标签', () => {
    render(<OfficePage />)

    expect(screen.getByTestId('office-page')).toBeInTheDocument()
    expect(screen.getByTestId('office-page-title')).toHaveTextContent('Office')
    expect(screen.getByTestId('office-empty')).toHaveTextContent('还没有打开的文档')
    expect(screen.getByTestId('office-empty')).toHaveTextContent('标签不绑定会话')
    // task-100：空态标题走全站统一模板（衬线 22/30 × --ui-scale）
    expect(
      within(screen.getByTestId('office-empty')).getByRole('heading', { level: 2 })
    ).toHaveClass('ui-empty-title')
    expect(screen.getByTestId('office-open')).toHaveAccessibleName('打开文件')
    expect(screen.queryByTestId('office-tabs')).not.toBeInTheDocument()
    expect(screen.queryByTestId('office-workspace')).not.toBeInTheDocument()
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-list')).not.toBeInTheDocument()
    // 示例列表/示例弹窗已删：点「打开文件」走的是主进程原生选择器
    expect(screen.queryByTestId('office-mock-files')).not.toBeInTheDocument()
  })

  it('「打开文件」→ office.openDialog → openDocument：标签出现、字节经 office.read 取回', async () => {
    const bridge = installOfficeBridge(
      officeDocumentFixture({ documentId: 'doc-42', displayName: '项目计划.docx' }),
      new Uint8Array([7, 8, 9])
    )
    bridge.office.openDialog.mockResolvedValue({
      ok: true,
      document: officeDocumentFixture({ documentId: 'doc-42', displayName: '项目计划.docx' }),
      alreadyOpen: false
    })

    render(<OfficePage />)
    fireEvent.click(screen.getByTestId('office-open'))

    await waitFor(() => expect(screen.getByTestId('office-workspace')).toBeInTheDocument())
    expect(bridge.office.openDialog).toHaveBeenCalledTimes(1)
    // task-100 第三轮：文档名一屏可见只留标签页 + ribbon；workspace 内不再留隐藏重复文本
    // （debug strip 默认 hidden 且正常态不渲染标题文本，只保留 aria-label/title 语义）
    expect(screen.getByTestId('office-workspace')).not.toHaveTextContent('项目计划.docx')
    expect(screen.getByTestId('office-doc-title')).toHaveAttribute('aria-label', '项目计划.docx')
    expect(screen.getByTestId('office-workspace')).toHaveAttribute('data-document-id', 'doc-42')
    expect(screen.getByTestId('office-surface-iframe')).toBeInTheDocument()
    expect(screen.getByTestId('office-surface-status')).toHaveAttribute('data-state', 'loading')
    expect(screen.queryByTestId('office-editor-placeholder')).not.toBeInTheDocument()
    // 打开后立刻读字节并交给面（S2：doc:open 由 OfficeSurface 在 ready 后投递）
    expect(bridge.office.read).toHaveBeenCalledWith('doc-42')
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(1)
    expect(useOfficeTabsStore.getState().tabs[0]?.kind).toBe('docx')
  })

  it('取消是一等结果：不报错、不开标签', async () => {
    const bridge = installKyclawBridge()
    bridge.office.openDialog.mockResolvedValue({
      ok: false,
      code: 'cancelled',
      message: '已取消'
    })
    render(<OfficePage />)

    fireEvent.click(screen.getByTestId('office-open'))
    await waitFor(() => expect(bridge.office.openDialog).toHaveBeenCalledTimes(1))

    expect(screen.getByTestId('office-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('office-open-error')).not.toBeInTheDocument()
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(0)
  })

  it('分类失败（如太大/读不了）→ 空态里显示主进程的人话', async () => {
    const bridge = installKyclawBridge()
    bridge.office.openDialog.mockResolvedValue({
      ok: false,
      code: 'too-large',
      message: '这个文件太大（超过 64MB），当前版本打不开'
    })
    render(<OfficePage />)

    fireEvent.click(screen.getByTestId('office-open'))

    const error = await screen.findByTestId('office-open-error')
    expect(error).toHaveTextContent('文件太大')
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(0)
  })

  it('主进程 reject（如授权错误）→ 也显示在空态里，不吞掉', async () => {
    const bridge = installKyclawBridge()
    bridge.office.openDialog.mockRejectedValue(new Error('这个会话还没有工作区'))
    render(<OfficePage />)

    fireEvent.click(screen.getByTestId('office-open'))

    const error = await screen.findByTestId('office-open-error')
    expect(error).toHaveTextContent('还没有工作区')
  })

  it('顶栏「＋」的 pickerOpen 标志 → 同一动作（原生选择器），不再渲染示例弹窗', async () => {
    const bridge = installOfficeBridge()
    bridge.office.openDialog.mockResolvedValue({
      ok: true,
      document: officeDocumentFixture(),
      alreadyOpen: false
    })
    render(<OfficePage />)

    act(() => useOfficeUiStore.getState().openPicker())

    await waitFor(() => expect(bridge.office.openDialog).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('office-workspace')).toBeInTheDocument())
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useOfficeUiStore.getState().pickerOpen).toBe(false)
  })
})

describe('OfficePage：有标签态（dirty / 主题 / 读失败）', () => {
  it('多 workspace 常驻：所有标签都挂载、非激活 hidden+inert；切标签只换可见性（dirty 跟标签）', () => {
    installOfficeBridge()
    const docx = useOfficeTabsStore
      .getState()
      .openDocument(officeDocumentFixture({ documentId: 'doc-a', displayName: '方案.docx' }))
    useOfficeTabsStore.getState().markDirty(docx)
    const pptx = useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'D:\\汇报.pptx' })

    render(<OfficePage />)

    const panels = Array.from(document.querySelectorAll<HTMLElement>('[data-office-panel]'))
    expect(panels).toHaveLength(2)
    const docxPanel = panels.find((panel) => panel.dataset.officePanel === docx)
    const pptxPanel = panels.find((panel) => panel.dataset.officePanel === pptx)
    expect(docxPanel).toBeDefined()
    expect(pptxPanel).toBeDefined()
    // 两个 panel id 唯一（aria-controls 才能各指各的）
    expect(docxPanel?.id).not.toBe(pptxPanel?.id)
    expect(docxPanel?.id).toBe(`office-panel-${docx}`)

    // 当前是后开的 pptx（未修改）：pptx panel 可见、docx panel hidden+inert（但仍在 DOM）
    expect(pptxPanel).toHaveAttribute('data-active', 'true')
    expect(pptxPanel).not.toHaveAttribute('hidden')
    expect(pptxPanel).not.toHaveAttribute('inert')
    expect(docxPanel).toHaveAttribute('data-active', 'false')
    expect(docxPanel).toHaveAttribute('hidden')
    expect(docxPanel).toHaveAttribute('inert')
    expect(within(pptxPanel as HTMLElement).getByTestId('office-workspace')).toHaveTextContent(
      'D:\\汇报.pptx'
    )
    expect(within(pptxPanel as HTMLElement).getByTestId('office-dirty-status')).toHaveAttribute(
      'data-dirty',
      'false'
    )

    act(() => useOfficeTabsStore.getState().activate(docx))

    // 切标签只是显隐：两个 workspace 还都在，没有重建
    expect(document.querySelectorAll('[data-office-panel]')).toHaveLength(2)
    expect(docxPanel).toHaveAttribute('data-active', 'true')
    expect(docxPanel).not.toHaveAttribute('hidden')
    expect(pptxPanel).toHaveAttribute('hidden')
    expect(within(docxPanel as HTMLElement).getByTestId('office-workspace')).toHaveTextContent(
      '方案.docx'
    )
    expect(within(docxPanel as HTMLElement).getByTestId('office-dirty-status')).toHaveAttribute(
      'data-dirty',
      'true'
    )
    expect(within(docxPanel as HTMLElement).getByTestId('office-dirty-status')).toHaveTextContent(
      '未保存修改'
    )
    expect(useOfficeTabsStore.getState().activeTabId).toBe(docx)
  })

  it('active=false（模块被隐藏）：不开自动选择器、根节点标记 data-active=false', () => {
    const bridge = installOfficeBridge()
    render(<OfficePage active={false} />)

    expect(screen.getByTestId('office-page')).toHaveAttribute('data-active', 'false')
    act(() => useOfficeUiStore.getState().openPicker())
    expect(bridge.office.openDialog).not.toHaveBeenCalled()
  })

  it('深色主题传给 OfficeSurface；运行中切主题（data-theme 变化）也跟着更新', async () => {
    installOfficeBridge()
    useOfficeTabsStore
      .getState()
      .openDocument(officeDocumentFixture({ documentId: 'doc-theme', displayName: '深色.docx' }))
    document.documentElement.dataset.theme = 'dark'

    render(<OfficePage />)

    await waitFor(() =>
      expect(screen.getByTestId('office-surface')).toHaveAttribute('data-theme', 'dark')
    )

    act(() => {
      document.documentElement.dataset.theme = 'light'
    })
    await waitFor(() =>
      expect(screen.getByTestId('office-surface')).toHaveAttribute('data-theme', 'light')
    )
  })

  it('office:read 失败（文件没了/被释放）→ 面照常握手，页面底部显示分类人话', async () => {
    const bridge = installKyclawBridge()
    bridge.office.read.mockResolvedValue({
      ok: false,
      code: 'unreadable',
      message: '读不了这个文件：它可能已损坏、无权限，或不是普通文件'
    })
    useOfficeTabsStore
      .getState()
      .openDocument(officeDocumentFixture({ documentId: 'doc-gone', displayName: '没了.docx' }))

    render(<OfficePage />)

    expect(await screen.findByTestId('office-doc-error')).toHaveTextContent('读不了这个文件')
    expect(screen.getByTestId('office-workspace')).toHaveAttribute('data-document-state', 'error')
  })

  it('切换会话不改 Office 标签（标签不绑当前会话）', () => {
    installOfficeBridge()
    const docx = useOfficeTabsStore
      .getState()
      .openDocument(officeDocumentFixture({ documentId: 'doc-s', displayName: '方案.docx' }))
    render(<OfficePage />)

    useSessionsStore.setState({ activeId: 'thread-2' })

    expect(useOfficeTabsStore.getState().tabs.map((tab) => tab.id)).toEqual([docx])
    expect(screen.getByTestId('office-workspace')).toHaveTextContent('方案.docx')
  })

  it('关掉最后一个标签回到空态', async () => {
    const pdf = useOfficeTabsStore.getState().open({ kind: 'pdf', path: 'D:\\产品说明.pdf' })
    render(<OfficePage />)

    act(() => {
      useOfficeTabsStore.getState().close(pdf)
    })

    await waitFor(() => expect(screen.getByTestId('office-empty')).toBeInTheDocument())
    expect(screen.queryByTestId('office-workspace')).not.toBeInTheDocument()
  })
})

/** 派发一条"来自面"的消息（jsdom 里 iframe 的 contentWindow 就是 about:blank 窗口） */
function dispatchFromSurface(frameWindow: Window, data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: frameWindow }))
}

/** 完成与面的握手 + 文档加载（驱动 OfficeSurface 的消息面，让壳拿到 editorReady） */
async function bootEditorSurface(documentId: string): Promise<Window> {
  const iframe = screen.getByTestId('office-surface-iframe') as HTMLIFrameElement
  const frameWindow = iframe.contentWindow
  if (frameWindow === null) throw new Error('iframe 没有 contentWindow')
  vi.spyOn(frameWindow, 'postMessage')
  act(() => dispatchFromSurface(frameWindow, { type: 'surface:hello', nonce: 'n-1', version: 1 }))
  act(() => dispatchFromSurface(frameWindow, { type: 'surface:ready', nonce: 'n-1' }))
  await waitFor(() =>
    expect(screen.getByTestId('office-surface')).toHaveAttribute('data-state', 'ready')
  )
  act(() =>
    dispatchFromSurface(frameWindow, {
      type: 'doc:loaded',
      nonce: 'n-1',
      documentId,
      pages: 2
    })
  )
  await waitFor(() =>
    expect(screen.getByTestId('office-workspace')).toHaveAttribute('data-editor-state', 'ready')
  )
  return frameWindow
}

/** 取面收到的某类消息 */
function sentToSurface(
  frameWindow: Window,
  type: string
): Array<{
  type: string
  requestId?: string
  documentId?: string
  ok?: boolean
  code?: string
  message?: string
}> {
  const spy = vi.mocked(frameWindow.postMessage)
  return spy.mock.calls
    .map(
      (call) =>
        call[0] as {
          type: string
          requestId?: string
          documentId?: string
          ok?: boolean
          code?: string
          message?: string
        }
    )
    .filter((message) => message.type === type)
}

describe('OfficePage：M3-S3 保存链路（按钮 / Ctrl+S / 脏徽标 / 错误条）', () => {
  it('编辑 → 脏；保存按钮 → doc:save → doc:save-bytes → office:save 成功 → 已保存', async () => {
    const bridge = installOfficeBridge(
      officeDocumentFixture({ documentId: 'doc-save', displayName: '保存.docx' }),
      new Uint8Array([1, 2, 3])
    )
    bridge.office.openDialog.mockResolvedValue({
      ok: true,
      document: officeDocumentFixture({ documentId: 'doc-save', displayName: '保存.docx' }),
      alreadyOpen: false
    })
    bridge.office.save.mockResolvedValue({
      ok: true,
      documentId: 'doc-save',
      mtimeMs: 2,
      sha256: 'b'.repeat(64),
      size: 4,
      savedAt: 1
    })
    render(<OfficePage />)
    fireEvent.click(screen.getByTestId('office-open'))
    await waitFor(() => expect(screen.getByTestId('office-workspace')).toBeInTheDocument())
    const frameWindow = await bootEditorSurface('doc-save')

    // 面报用户编辑 → 壳推进 editSeq → store 投影变脏
    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:changed',
        nonce: 'n-1',
        documentId: 'doc-save',
        revision: 1
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true')
    )
    expect(screen.getByTestId('office-dirty-status')).toHaveTextContent('未保存修改')
    expect(screen.getByTestId('office-save')).toBeEnabled()

    fireEvent.click(screen.getByTestId('office-save'))
    // 壳先向面要字节（generate）
    await waitFor(() => expect(sentToSurface(frameWindow, 'doc:save')).toHaveLength(1))
    expect(bridge.office.save).not.toHaveBeenCalled()
    const saveMessage = sentToSurface(frameWindow, 'doc:save')[0]
    if (saveMessage?.requestId === undefined) throw new Error('doc:save 没有 requestId')

    // 面回字节 → 壳写盘 → 成功后清脏
    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:save-bytes',
        nonce: 'n-1',
        requestId: saveMessage.requestId,
        documentId: 'doc-save',
        bytes: new Uint8Array([1, 2, 3, 4])
      })
    )
    await waitFor(() => expect(bridge.office.save).toHaveBeenCalledTimes(1))
    expect(bridge.office.save).toHaveBeenCalledWith({
      documentId: 'doc-save',
      expectedSha256: 'a'.repeat(64),
      bytes: new Uint8Array([1, 2, 3, 4])
    })
    await waitFor(() =>
      expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'false')
    )
    expect(screen.getByTestId('office-dirty-status')).toHaveTextContent('已保存')
    expect(screen.getByTestId('office-save')).toBeDisabled()
    expect(screen.queryByTestId('office-save-error')).not.toBeInTheDocument()
  })

  it('保存失败（write-locked）：dirty 保持 + 错误条 + 重试入口', async () => {
    const bridge = installOfficeBridge(
      officeDocumentFixture({ documentId: 'doc-lock', displayName: '占用.docx' }),
      new Uint8Array([1])
    )
    bridge.office.openDialog.mockResolvedValue({
      ok: true,
      document: officeDocumentFixture({ documentId: 'doc-lock', displayName: '占用.docx' }),
      alreadyOpen: false
    })
    bridge.office.save.mockResolvedValue({
      ok: false,
      code: 'write-locked',
      message: '文件被其他程序占用，可以先另存为再替换'
    })
    render(<OfficePage />)
    fireEvent.click(screen.getByTestId('office-open'))
    await waitFor(() => expect(screen.getByTestId('office-workspace')).toBeInTheDocument())
    const frameWindow = await bootEditorSurface('doc-lock')

    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:changed',
        nonce: 'n-1',
        documentId: 'doc-lock',
        revision: 1
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true')
    )
    fireEvent.click(screen.getByTestId('office-save'))
    await waitFor(() => expect(sentToSurface(frameWindow, 'doc:save')).toHaveLength(1))
    const requestId = sentToSurface(frameWindow, 'doc:save')[0]?.requestId
    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:save-bytes',
        nonce: 'n-1',
        requestId,
        documentId: 'doc-lock',
        bytes: new Uint8Array([2])
      })
    )

    const error = await screen.findByTestId('office-save-error')
    expect(error).toHaveTextContent('文件被其他程序占用')
    expect(screen.getByTestId('office-save-retry')).toBeInTheDocument()
    expect(screen.getByTestId('office-save-as')).toBeInTheDocument()
    // 失败绝不清脏
    expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true')
    expect(screen.getByTestId('office-dirty-status')).toHaveTextContent('未保存修改')
  })

  it('A4.5 面发起保存（doc:save-request）→ 壳写盘成功→ 回 doc:save-result（requestId 原样带回）', async () => {
    const bridge = installOfficeBridge(
      officeDocumentFixture({ documentId: 'doc-a45-ok', displayName: '回执.docx' }),
      new Uint8Array([1, 2, 3])
    )
    bridge.office.openDialog.mockResolvedValue({
      ok: true,
      document: officeDocumentFixture({ documentId: 'doc-a45-ok', displayName: '回执.docx' }),
      alreadyOpen: false
    })
    bridge.office.save.mockResolvedValue({
      ok: true,
      documentId: 'doc-a45-ok',
      mtimeMs: 2,
      sha256: 'b'.repeat(64),
      size: 4,
      savedAt: 1
    })
    render(<OfficePage />)
    fireEvent.click(screen.getByTestId('office-open'))
    await waitFor(() => expect(screen.getByTestId('office-workspace')).toBeInTheDocument())
    const frameWindow = await bootEditorSurface('doc-a45-ok')

    // 面内 QAT 保存 = doc:save-request（带 requestId）；壳照既有保存入口跑保存状态机
    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:save-request',
        nonce: 'n-1',
        requestId: 'surface-save-1',
        documentId: 'doc-a45-ok'
      })
    )
    await waitFor(() => expect(sentToSurface(frameWindow, 'doc:save')).toHaveLength(1))
    const generate = sentToSurface(frameWindow, 'doc:save')[0]
    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:save-bytes',
        nonce: 'n-1',
        requestId: generate?.requestId,
        documentId: 'doc-a45-ok',
        bytes: new Uint8Array([9, 9])
      })
    )
    await waitFor(() => expect(bridge.office.save).toHaveBeenCalledTimes(1))

    // 写盘落定 → 壳把结果回执给面（同一 requestId）→ 面内 QAT 才允许进「已保存」
    await waitFor(() => expect(sentToSurface(frameWindow, 'doc:save-result')).toHaveLength(1))
    expect(sentToSurface(frameWindow, 'doc:save-result')[0]).toMatchObject({
      type: 'doc:save-result',
      requestId: 'surface-save-1',
      ok: true
    })
  })

  it('A4.5 面发起保存失败（write-locked）→ 回 doc:save-result ok:false + 壳的分类与人话', async () => {
    const bridge = installOfficeBridge(
      officeDocumentFixture({ documentId: 'doc-a45-fail', displayName: '占用.docx' }),
      new Uint8Array([1])
    )
    bridge.office.openDialog.mockResolvedValue({
      ok: true,
      document: officeDocumentFixture({ documentId: 'doc-a45-fail', displayName: '占用.docx' }),
      alreadyOpen: false
    })
    bridge.office.save.mockResolvedValue({
      ok: false,
      code: 'write-locked',
      message: '文件被其他程序占用，可以先另存为再替换'
    })
    render(<OfficePage />)
    fireEvent.click(screen.getByTestId('office-open'))
    await waitFor(() => expect(screen.getByTestId('office-workspace')).toBeInTheDocument())
    const frameWindow = await bootEditorSurface('doc-a45-fail')

    // 先有真实编辑（dirty），失败后必须仍脏
    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:changed',
        nonce: 'n-1',
        documentId: 'doc-a45-fail',
        revision: 1
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true')
    )

    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:save-request',
        nonce: 'n-1',
        requestId: 'surface-save-2',
        documentId: 'doc-a45-fail'
      })
    )
    await waitFor(() => expect(sentToSurface(frameWindow, 'doc:save')).toHaveLength(1))
    const generate = sentToSurface(frameWindow, 'doc:save')[0]
    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:save-bytes',
        nonce: 'n-1',
        requestId: generate?.requestId,
        documentId: 'doc-a45-fail',
        bytes: new Uint8Array([2])
      })
    )

    await waitFor(() => expect(sentToSurface(frameWindow, 'doc:save-result')).toHaveLength(1))
    expect(sentToSurface(frameWindow, 'doc:save-result')[0]).toMatchObject({
      type: 'doc:save-result',
      requestId: 'surface-save-2',
      ok: false,
      code: 'write-locked'
    })
    // 壳自己的错误面同时出现（失败不丢脏）
    expect(await screen.findByTestId('office-save-error')).toHaveTextContent('文件被其他程序占用')
    expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true')
  })

  it('A4.5 壳侧保存（保存按钮）成功后也回执给面：QAT 与状态栏一致', async () => {
    const bridge = installOfficeBridge(
      officeDocumentFixture({ documentId: 'doc-a45-shell', displayName: '壳保存.docx' }),
      new Uint8Array([1, 2, 3])
    )
    bridge.office.openDialog.mockResolvedValue({
      ok: true,
      document: officeDocumentFixture({
        documentId: 'doc-a45-shell',
        displayName: '壳保存.docx'
      }),
      alreadyOpen: false
    })
    bridge.office.save.mockResolvedValue({
      ok: true,
      documentId: 'doc-a45-shell',
      mtimeMs: 2,
      sha256: 'b'.repeat(64),
      size: 4,
      savedAt: 1
    })
    render(<OfficePage />)
    fireEvent.click(screen.getByTestId('office-open'))
    await waitFor(() => expect(screen.getByTestId('office-workspace')).toBeInTheDocument())
    const frameWindow = await bootEditorSurface('doc-a45-shell')

    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:changed',
        nonce: 'n-1',
        documentId: 'doc-a45-shell',
        revision: 1
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true')
    )

    // 壳侧入口（保存按钮）发起的保存：面没有在途请求，回执用壳生成的 id → 面直接采信
    fireEvent.click(screen.getByTestId('office-save'))
    await waitFor(() => expect(sentToSurface(frameWindow, 'doc:save')).toHaveLength(1))
    const generate = sentToSurface(frameWindow, 'doc:save')[0]
    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:save-bytes',
        nonce: 'n-1',
        requestId: generate?.requestId,
        documentId: 'doc-a45-shell',
        bytes: new Uint8Array([7])
      })
    )
    await waitFor(() => expect(bridge.office.save).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(sentToSurface(frameWindow, 'doc:save-result')).toHaveLength(1))
    const result = sentToSurface(frameWindow, 'doc:save-result')[0]
    expect(result).toMatchObject({ ok: true })
    expect(typeof result?.requestId).toBe('string')
    expect((result?.requestId as string).length).toBeGreaterThan(0)
  })

  it('面内 Ctrl+S（surface:shortcut）→ 壳统一分发 → doc:save → 保存成功清脏', async () => {
    const bridge = installOfficeBridge(
      officeDocumentFixture({ documentId: 'doc-key', displayName: '快捷键.docx' }),
      new Uint8Array([1])
    )
    bridge.office.openDialog.mockResolvedValue({
      ok: true,
      document: officeDocumentFixture({ documentId: 'doc-key', displayName: '快捷键.docx' }),
      alreadyOpen: false
    })
    bridge.office.save.mockResolvedValue({
      ok: true,
      documentId: 'doc-key',
      mtimeMs: 2,
      sha256: 'b'.repeat(64),
      size: 4,
      savedAt: 1
    })
    render(<OfficePage />)
    fireEvent.click(screen.getByTestId('office-open'))
    await waitFor(() => expect(screen.getByTestId('office-workspace')).toBeInTheDocument())
    const frameWindow = await bootEditorSurface('doc-key')

    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:changed',
        nonce: 'n-1',
        documentId: 'doc-key',
        revision: 1
      })
    )
    await waitFor(() =>
      expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true')
    )

    // 焦点在面内时由 SurfaceBoot 转发 surface:shortcut（这里直接从 iframe 来源派发）
    act(() =>
      dispatchFromSurface(frameWindow, { type: 'surface:shortcut', nonce: 'n-1', action: 'save' })
    )
    await waitFor(() => expect(sentToSurface(frameWindow, 'doc:save')).toHaveLength(1))
    const requestId = sentToSurface(frameWindow, 'doc:save')[0]?.requestId
    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:save-bytes',
        nonce: 'n-1',
        requestId,
        documentId: 'doc-key',
        bytes: new Uint8Array([1, 2, 3, 4])
      })
    )
    await waitFor(() => expect(bridge.office.save).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'false')
    )
  })
})

describe('OfficePage：M3-S5-3 容量策略（dormant / 打开闸门 / 整面重载）', () => {
  /** 按 documentId 回对应文档的桥（多标签用例共用；read 调用次数用来断言"休眠的不读"） */
  function installMultiDocBridge(): KyclawBridgeStubs {
    const bridge = installKyclawBridge()
    bridge.office.read.mockImplementation(async (documentId) => ({
      ok: true as const,
      document: officeDocumentFixture({ documentId, displayName: `${documentId}.docx` }),
      bytes: new Uint8Array([1, 2, 3])
    }))
    return bridge
  }

  interface OpenedDoc {
    tabId: string
    documentId: string
  }

  /** 依次打开 count 个 docx（调用方先开 fake Date；递增时间让 LRU 顺序确定：越早打开越先休眠） */
  function openDocs(count: number, prefix: string): OpenedDoc[] {
    const docs: OpenedDoc[] = []
    for (let index = 0; index < count; index += 1) {
      const documentId = `${prefix}-${index}`
      let tabId = ''
      vi.setSystemTime(1_000 + index * 10)
      act(() => {
        tabId = useOfficeTabsStore
          .getState()
          .openDocument(officeDocumentFixture({ documentId, displayName: `${documentId}.docx` }))
      })
      docs.push({ tabId, documentId })
    }
    return docs
  }

  it('挂载计划：4 个 docx 只挂 3 个 workspace + 1 个 dormant 占位；休眠标签不发 office:read', async () => {
    const bridge = installMultiDocBridge()
    vi.useFakeTimers({ toFake: ['Date'] })
    const docs = openDocs(4, 'doc')
    vi.useRealTimers()

    render(<OfficePage />)

    await waitFor(() => expect(screen.getAllByTestId('office-workspace')).toHaveLength(3))
    expect(screen.getAllByTestId('office-workspace-dormant')).toHaveLength(1)
    // 最久未激活的第一篇休眠；active（最后一篇）恒挂载
    expect(screen.getByTestId('office-workspace-dormant')).toHaveAttribute(
      'data-document-id',
      docs[0].documentId
    )
    // 休眠标签**绝不**读字节（一个字节都不取）
    const readIds = bridge.office.read.mock.calls.map((call) => call[0])
    expect(readIds).not.toContain(docs[0].documentId)
    expect(readIds.slice().sort()).toEqual(
      [docs[1].documentId, docs[2].documentId, docs[3].documentId].sort()
    )
    // store 里也已同步成 dormant（布局 effect 批量 setDormant）
    const dormantTab = useOfficeTabsStore.getState().tabs.find((tab) => tab.id === docs[0].tabId)
    expect(dormantTab?.dormant).toBe(true)
  })

  it('dirty 永不 dormant：最久未激活但脏的标签仍挂载（S5-2 退出保存不会指向已卸载编辑器）', async () => {
    const bridge = installMultiDocBridge()
    vi.useFakeTimers({ toFake: ['Date'] })
    const docs = openDocs(4, 'doc')
    vi.useRealTimers()
    // 把最久未激活的第一篇标脏：dirty 是强制挂载项，任何容量策略都不能卸载它
    act(() => useOfficeTabsStore.getState().markDirty(docs[0].tabId, true))
    render(<OfficePage />)

    await waitFor(() => expect(screen.getAllByTestId('office-workspace')).toHaveLength(3))
    // 第一篇仍以 workspace（而不是 dormant 占位）出现，且读字节
    const firstPanel = document.querySelector(`[data-office-panel="${docs[0].tabId}"]`)
    expect(firstPanel?.querySelector('[data-testid="office-workspace"]')).not.toBeNull()
    expect(firstPanel?.querySelector('[data-testid="office-workspace-dormant"]')).toBeNull()
    expect(bridge.office.read).toHaveBeenCalledWith(docs[0].documentId)
    // 让位的是另一篇 clean 标签
    expect(screen.getAllByTestId('office-workspace-dormant')).toHaveLength(1)
    expect(screen.getByTestId('office-workspace-dormant')).not.toHaveAttribute(
      'data-document-id',
      docs[0].documentId
    )
  })

  it('激活休眠标签：重新挂载并从磁盘重读字节（dormant 占位让位）', async () => {
    const bridge = installMultiDocBridge()
    vi.useFakeTimers({ toFake: ['Date'] })
    const docs = openDocs(4, 'doc')
    vi.useRealTimers()
    render(<OfficePage />)
    await waitFor(() => expect(screen.getByTestId('office-workspace-dormant')).toBeInTheDocument())
    const target = useOfficeTabsStore.getState().tabs.find((tab) => tab.id === docs[0].tabId)
    if (target === undefined) throw new Error('缺标签')
    bridge.office.read.mockClear()

    fireEvent.click(screen.getByTestId('office-workspace-dormant-activate'))

    await waitFor(() => expect(bridge.office.read).toHaveBeenCalledWith(docs[0].documentId))
    await waitFor(() => expect(screen.getAllByTestId('office-workspace')).toHaveLength(3))
    // 第一篇已恢复，改由最久未激活的第二篇休眠（active 恒挂载：doc-0 + doc-2 + doc-3）
    expect(screen.getByTestId('office-workspace-dormant')).toHaveAttribute(
      'data-document-id',
      docs[1].documentId
    )
    // 恢复的 workspace 有自己的隔离面
    expect(screen.getAllByTestId('office-surface-iframe')).toHaveLength(3)
  })

  it('打开闸门：已 5 个标签时再打开 → 不弹选择器、不读字节、展示人话', async () => {
    const bridge = installMultiDocBridge()
    bridge.office.openDialog.mockResolvedValue({
      ok: true,
      document: officeDocumentFixture({ documentId: 'doc-extra', displayName: '多出来的.docx' }),
      alreadyOpen: false
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    openDocs(5, 'doc')
    vi.useRealTimers()
    render(<OfficePage />)
    await waitFor(() => expect(screen.getAllByTestId('office-workspace')).toHaveLength(3))
    bridge.office.read.mockClear()

    // 走「顶栏＋」同一个标志入口（OfficePage 的 effect 消费 pickerOpen 后发起打开）
    act(() => useOfficeUiStore.getState().openPicker())

    const error = await screen.findByTestId('office-open-error')
    expect(error).toHaveTextContent('最多同时打开 5 个标签')
    expect(bridge.office.openDialog).not.toHaveBeenCalled()
    expect(useOfficeTabsStore.getState().tabs).toHaveLength(5)
    expect(bridge.office.read).not.toHaveBeenCalled()
  })

  it('整面重载：复用次数到上限且无 dirty → 失活时卸掉 iframe，再激活重读重建', async () => {
    const bridge = installMultiDocBridge()
    vi.useFakeTimers({ toFake: ['Date'] })
    const docs = openDocs(2, 'doc')
    vi.useRealTimers()
    render(<OfficePage />)
    await waitFor(() => expect(screen.getAllByTestId('office-surface-iframe')).toHaveLength(2))

    // 交替切标签 60 次：两个 workspace 各累计 ~30 次复用（> OFFICE_SURFACE_MAX_REUSE=24）
    for (let index = 0; index < 60; index += 1) {
      act(() =>
        useOfficeTabsStore.getState().activate(index % 2 === 0 ? docs[0].tabId : docs[1].tabId)
      )
    }
    // 最后一次激活第二篇 → 第一篇失活且复用超限：其隔离面被卸载（延迟一拍）
    await waitFor(() =>
      expect(screen.getAllByTestId('office-surface-unloaded').length).toBeGreaterThanOrEqual(1)
    )

    bridge.office.read.mockClear()
    act(() => useOfficeTabsStore.getState().activate(docs[0].tabId))
    await waitFor(() => expect(bridge.office.read).toHaveBeenCalledWith(docs[0].documentId))
    // 重新激活的这块面重读磁盘后重建 iframe（另一块刚失活、同样超限 → 轮到它被卸载，属预期）
    const panelOf = (tabId: string): HTMLElement | null =>
      document.querySelector(`[data-office-panel="${tabId}"]`)
    await waitFor(() => {
      const panel = panelOf(docs[0].tabId)
      expect(panel?.querySelector('[data-testid="office-surface-iframe"]')).not.toBeNull()
      expect(panel?.querySelector('[data-testid="office-surface-unloaded"]')).toBeNull()
    })
  })
})

describe('PB-023：打开错误与保存错误分开（错误横幅 + 重试/关闭）', () => {
  async function openAndBoot(documentId: string): Promise<{
    bridge: KyclawBridgeStubs
    frameWindow: Window
  }> {
    const bridge = installOfficeBridge(
      officeDocumentFixture({ documentId, displayName: '坏文件.docx' }),
      new Uint8Array([1, 2, 3])
    )
    bridge.office.openDialog.mockResolvedValue({
      ok: true,
      document: officeDocumentFixture({ documentId, displayName: '坏文件.docx' }),
      alreadyOpen: false
    })
    render(<OfficePage />)
    fireEvent.click(screen.getByTestId('office-open'))
    await waitFor(() => expect(screen.getByTestId('office-workspace')).toBeInTheDocument())
    return { bridge, frameWindow: await bootEditorSurface(documentId) }
  }

  it('open 错误 → 文档错误横幅（原始摘要 + 重试/关闭），不进保存错误条', async () => {
    const { frameWindow } = await openAndBoot('doc-bad-open')

    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:error',
        nonce: 'n-1',
        documentId: 'doc-bad-open',
        phase: 'open',
        message: 'bad zip: Could not find EOCD'
      })
    )

    const banner = await screen.findByTestId('office-doc-error')
    expect(banner).toHaveTextContent('bad zip: Could not find EOCD')
    expect(screen.getByTestId('office-doc-error-retry')).toBeInTheDocument()
    expect(screen.getByTestId('office-doc-error-close')).toBeInTheDocument()
    // 打开错误不得混入保存错误条
    expect(screen.queryByTestId('office-save-error')).not.toBeInTheDocument()
  })

  it('save 错误 → 保存错误条（重试/另存为），不进文档错误横幅', async () => {
    const { frameWindow } = await openAndBoot('doc-bad-save')

    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:error',
        nonce: 'n-1',
        documentId: 'doc-bad-save',
        phase: 'save',
        message: '写盘失败'
      })
    )

    await waitFor(() =>
      expect(screen.getByTestId('office-save-error')).toHaveTextContent('写盘失败')
    )
    expect(screen.queryByTestId('office-doc-error')).not.toBeInTheDocument()
  })

  it('点「重试」→ 清文档错误并重挂隔离面（重新读盘）', async () => {
    const { bridge, frameWindow } = await openAndBoot('doc-retry-open')
    act(() =>
      dispatchFromSurface(frameWindow, {
        type: 'doc:error',
        nonce: 'n-1',
        documentId: 'doc-retry-open',
        phase: 'open',
        message: '坏 zip'
      })
    )
    await screen.findByTestId('office-doc-error')

    fireEvent.click(screen.getByTestId('office-doc-error-retry'))

    await waitFor(() => expect(screen.queryByTestId('office-doc-error')).not.toBeInTheDocument())
    // 面被卸掉后重新读盘（初次 1 次 + 重试 1 次）
    await waitFor(() => expect(bridge.office.read.mock.calls.length).toBeGreaterThanOrEqual(2))
  })

  it('点「关闭」→ 标签关闭回到空态', async () => {
    await openAndBoot('doc-close-on-error')
    act(() =>
      dispatchFromSurface(
        (screen.getByTestId('office-surface-iframe') as HTMLIFrameElement).contentWindow as Window,
        {
          type: 'doc:error',
          nonce: 'n-1',
          documentId: 'doc-close-on-error',
          phase: 'open',
          message: '坏 zip'
        }
      )
    )
    await screen.findByTestId('office-doc-error')
    fireEvent.click(screen.getByTestId('office-doc-error-close'))
    await waitFor(() => expect(screen.getByTestId('office-empty')).toBeInTheDocument())
  })

  it('PB-023 返工：非 ZIP 字节（坏文件）→ 立即文档错误，不进加载', async () => {
    const document = officeDocumentFixture({ documentId: 'doc-bad-zip', displayName: '坏.xlsx' })
    const bridge = installKyclawBridge()
    bridge.office.read.mockResolvedValue({
      ok: true,
      document,
      // 16B 坏 zip 的典型：不是 PK 开头
      bytes: new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])
    })
    bridge.office.openDialog.mockResolvedValue({ ok: true, document, alreadyOpen: false })
    render(<OfficePage />)
    fireEvent.click(screen.getByTestId('office-open'))

    const banner = await screen.findByTestId('office-doc-error')
    expect(banner).toHaveTextContent('不是有效的 Office 文档')
    expect(screen.getByTestId('office-doc-error-retry')).toBeInTheDocument()
    expect(screen.getByTestId('office-doc-error-close')).toBeInTheDocument()
    // 文档没有进入「已加载」态（错误来自读盘前的 ZIP 校验，不等引擎）
    expect(screen.getByTestId('office-workspace')).toHaveAttribute('data-document-state', 'error')
  })

  it('PB-023 返工：进入文档后 10s 未 doc:loaded → 打开超时错误（三格式兜底）', async () => {
    const timerSpy = vi.spyOn(window, 'setTimeout')
    const document = officeDocumentFixture({ documentId: 'doc-slow', displayName: '慢.docx' })
    installOfficeBridge(document)
    useOfficeTabsStore.getState().openDocument(document)
    render(<OfficePage />)

    // 等读盘落定（loaded 后才会排 10s 看门狗）
    await waitFor(() =>
      expect(screen.getByTestId('office-workspace')).toHaveAttribute(
        'data-document-state',
        'loaded'
      )
    )
    const watchdog = timerSpy.mock.calls.find((call) => call[1] === 10_000)
    expect(watchdog).toBeDefined()
    act(() => {
      ;(watchdog?.[0] as () => void)()
    })
    await waitFor(() =>
      expect(screen.getByTestId('office-doc-error')).toHaveTextContent('打开超时')
    )
  })
})
