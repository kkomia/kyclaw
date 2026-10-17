import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

/** 装桥 + 让 office:read 默认回一份可显示文档（标签打开后 workspace 才有内容） */
function installOfficeBridge(
  document = officeDocumentFixture(),
  bytes = new Uint8Array([1, 2, 3])
): KyclawBridgeStubs {
  const bridge = installKyclawBridge()
  bridge.office.read.mockResolvedValue({ ok: true, document, bytes })
  return bridge
}

describe('OfficePage：空态与真实「打开文件」（M3-S2）', () => {
  it('空态：标题 + 说明 + 「打开文件」入口；没有聊天、会话列表或标签', () => {
    render(<OfficePage />)

    expect(screen.getByTestId('office-page')).toBeInTheDocument()
    expect(screen.getByTestId('office-page-title')).toHaveTextContent('Office')
    expect(screen.getByTestId('office-empty')).toHaveTextContent('还没有打开的文档')
    expect(screen.getByTestId('office-empty')).toHaveTextContent('标签不绑定会话')
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
    expect(screen.getByTestId('office-workspace')).toHaveTextContent('项目计划.docx')
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
  it('有标签态：workspace 跟当前激活标签走（dirty 状态也跟着变）', () => {
    installOfficeBridge()
    const docx = useOfficeTabsStore
      .getState()
      .openDocument(officeDocumentFixture({ documentId: 'doc-a', displayName: '方案.docx' }))
    useOfficeTabsStore.getState().markDirty(docx)
    const pptx = useOfficeTabsStore.getState().open({ kind: 'pptx', path: 'D:\\汇报.pptx' })

    render(<OfficePage />)

    // 当前是后开的 pptx（未修改）
    expect(screen.getByTestId('office-workspace')).toHaveTextContent('D:\\汇报.pptx')
    expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'false')
    expect(screen.getByTestId('office-dirty-status')).toHaveTextContent('已保存')
    expect(screen.getByTestId('office-dirty-status').querySelector('.rounded-full')).toBeNull()

    act(() => useOfficeTabsStore.getState().activate(docx))

    expect(screen.getByTestId('office-workspace')).toHaveTextContent('方案.docx')
    expect(screen.getByTestId('office-dirty-status')).toHaveAttribute('data-dirty', 'true')
    expect(screen.getByTestId('office-dirty-status')).toHaveTextContent('未保存修改')
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()
    expect(useOfficeTabsStore.getState().activeTabId).not.toBe(pptx)
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
): Array<{ type: string; requestId?: string; documentId?: string }> {
  const spy = vi.mocked(frameWindow.postMessage)
  return spy.mock.calls
    .map((call) => call[0] as { type: string; requestId?: string; documentId?: string })
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

  it('壳侧 Ctrl+S（焦点不在 iframe 里）经 office-actions 触发保存', async () => {
    const bridge = installOfficeBridge(
      officeDocumentFixture({ documentId: 'doc-key', displayName: '快捷键.docx' }),
      new Uint8Array([1])
    )
    bridge.office.openDialog.mockResolvedValue({
      ok: true,
      document: officeDocumentFixture({ documentId: 'doc-key', displayName: '快捷键.docx' }),
      alreadyOpen: false
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
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(() => expect(sentToSurface(frameWindow, 'doc:save')).toHaveLength(1))
  })
})
