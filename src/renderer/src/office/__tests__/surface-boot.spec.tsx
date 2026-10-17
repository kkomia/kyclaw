import { act, render, screen, waitFor } from '@testing-library/react'
import { forwardRef, useImperativeHandle } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SURFACE_PROTOCOL_VERSION } from '../bridge-protocol'

/**
 * 面侧启动组件（M3-S1 握手 → S2 收字节 → S3 编辑器/保存链路）。
 *
 * jsdom 里 window.parent === window，parent.postMessage 会被 window.postMessage 接住：
 * 用 spy 抓面发出的消息、手动派发"父页来的"消息，验握手的协议形状与 S3 消息路由。
 *
 * 编辑器内核（@betteroffice/docx-react）与字体注册在这里 mock 掉：本 spec 只验消息/状态机，
 * 真实编辑器的真机验收在 e2e/_r020-office-docx-save.spec.ts（jsdom 里也跑不动 wasm）。
 */
const editorMock = vi.hoisted(() => ({
  saveBytes: new Uint8Array([1, 2, 3, 4]) as Uint8Array | null,
  saveCalls: 0,
  reloads: [] as Uint8Array[],
  lastProps: null as null | {
    documentId: string
    name: string
    readOnly: boolean
    theme: string
    onChanged: () => void
    onSaveRequest: () => void
    onLoaded: (pages: number) => void
    onError: (phase: string, message: string) => void
  }
}))

const fontsMock = vi.hoisted(() => ({
  ensureSurfaceFonts: vi.fn(async () => ({
    faces: 22,
    registrations: 46,
    fetchedBytes: 27_383_772,
    fontSetSize: 47,
    ms: 100,
    cjk: true
  }))
}))

vi.mock('../DocxEditorPane', () => ({
  DocxEditorPane: forwardRef<unknown, Record<string, unknown>>(
    function MockDocxEditorPane(props, ref) {
      editorMock.lastProps = props as typeof editorMock.lastProps
      useImperativeHandle(ref, () => ({
        save: async () => {
          editorMock.saveCalls += 1
          return editorMock.saveBytes
        },
        reload: async (bytes: Uint8Array) => {
          editorMock.reloads.push(bytes)
        }
      }))
      return <div data-testid="surface-docx-editor" data-document-id={props.documentId as string} />
    }
  )
}))

vi.mock('../fonts', () => fontsMock)

import { SurfaceBoot } from '../SurfaceBoot'
import { createSurfaceNonce } from '../bridge-protocol'

afterEach(() => {
  vi.restoreAllMocks()
  delete document.documentElement.dataset.surfaceTheme
  document.documentElement.removeAttribute('style')
  document.body.removeAttribute('style')
})

beforeEach(() => {
  editorMock.saveBytes = new Uint8Array([1, 2, 3, 4])
  editorMock.saveCalls = 0
  editorMock.reloads = []
  editorMock.lastProps = null
  fontsMock.ensureSurfaceFonts.mockClear()
})

/** 以"来自父页"的形态派发一条消息（jsdom 顶层页的 parent 就是自己） */
function dispatchFromParent(data: unknown): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: window }))
}

interface SentMessage {
  type: string
  nonce?: string
  [key: string]: unknown
}

/** 面发出的消息列表（按发出的顺序） */
function sentMessages(postMessage: ReturnType<typeof vi.spyOn>): SentMessage[] {
  return postMessage.mock.calls.map((call) => call[0] as SentMessage)
}

/** 完成握手：拿到 hello 的 nonce，回一条 init */
async function handshake(
  postMessage: ReturnType<typeof vi.spyOn>,
  theme: 'light' | 'dark' = 'light'
): Promise<string> {
  await waitFor(() => expect(postMessage).toHaveBeenCalled())
  const hello = sentMessages(postMessage).find((message) => message.type === 'surface:hello')
  if (hello?.nonce === undefined) throw new Error('没有 hello nonce')
  act(() => {
    dispatchFromParent({ type: 'surface:init', nonce: hello.nonce, locale: 'zh-CN', theme })
  })
  await waitFor(() =>
    expect(screen.getByTestId('surface-boot-state')).toHaveAttribute('data-state', 'ready')
  )
  return hello.nonce
}

const DOC = {
  type: 'doc:open',
  documentId: 'doc-1',
  name: '方案.docx',
  sha256: 'a'.repeat(64),
  readOnly: false,
  bytes: new Uint8Array([9, 9, 9])
}

describe('SurfaceBoot：握手状态机', () => {
  it('先发 surface:hello（带版本与非空 nonce），收到匹配 nonce 的 init 后显示 surface ready', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)

    const nonce = await handshake(postMessage, 'dark')
    expect(sentMessages(postMessage)[0]?.type).toBe('surface:hello')
    expect(sentMessages(postMessage)[0]?.version).toBe(SURFACE_PROTOCOL_VERSION)
    expect(screen.getByTestId('surface-boot-state')).toHaveTextContent('surface ready')
    expect(document.documentElement.dataset.surfaceTheme).toBe('dark')
    const ready = sentMessages(postMessage).find((message) => message.type === 'surface:ready')
    expect(ready?.nonce).toBe(nonce)
  })

  it('nonce 不匹配的 init 被忽略（防伪造 init）', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    await waitFor(() => expect(postMessage).toHaveBeenCalled())

    act(() => {
      dispatchFromParent({
        type: 'surface:init',
        nonce: 'forged-nonce',
        locale: 'zh-CN',
        theme: 'light'
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByTestId('surface-boot-state')).toHaveAttribute('data-state', 'booting')
    expect(sentMessages(postMessage).some((message) => message.type === 'surface:ready')).toBe(
      false
    )
  })

  it('运行中主题切换：父页用同一 nonce 再发 init → 面重新应用（不回到 booting）', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage, 'light')
    expect(document.documentElement.dataset.surfaceTheme).toBe('light')

    act(() => {
      dispatchFromParent({ type: 'surface:init', nonce, locale: 'zh-CN', theme: 'dark' })
    })
    await waitFor(() => expect(document.documentElement.dataset.surfaceTheme).toBe('dark'))
    expect(screen.getByTestId('surface-theme')).toHaveAttribute('data-theme', 'dark')
    expect(screen.getByTestId('surface-boot-state')).toHaveAttribute('data-state', 'ready')
  })

  it('createSurfaceNonce 每次都不同且非空', () => {
    const a = createSurfaceNonce()
    const b = createSurfaceNonce()
    expect(a.length).toBeGreaterThan(0)
    expect(a).not.toBe(b)
  })
})

describe('SurfaceBoot：doc:open → 字体 → 编辑器', () => {
  it('收到 doc:open 后先注册本地字体，字体就绪再挂编辑器；布局完成回 doc:loaded', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage)

    act(() => {
      dispatchFromParent({ ...DOC, nonce })
    })

    // 字体注册前：显示加载态，不挂编辑器
    expect(screen.getByTestId('surface-fonts-loading')).toBeInTheDocument()
    await waitFor(() => expect(fontsMock.ensureSurfaceFonts).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('surface-docx-editor')).toBeInTheDocument())
    expect(screen.getByTestId('surface-doc-open')).toHaveAttribute('data-state', 'loaded')
    expect(screen.getByTestId('surface-docx-editor')).toHaveAttribute('data-document-id', 'doc-1')
    expect(editorMock.lastProps?.name).toBe('方案.docx')
    expect(editorMock.lastProps?.readOnly).toBe(false)

    // 编辑器首次布局完成 → doc:loaded（页数）
    act(() => editorMock.lastProps?.onLoaded(3))
    const loaded = sentMessages(postMessage).find((message) => message.type === 'doc:loaded')
    expect(loaded).toMatchObject({ documentId: 'doc-1', pages: 3 })
    expect(screen.getByTestId('surface-editor-state')).toHaveAttribute('data-state', 'ready')
  })

  it('编辑 → doc:changed（revision 单调）；编辑器保存请求 → doc:save-request', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage)
    act(() => dispatchFromParent({ ...DOC, nonce }))
    await waitFor(() => expect(screen.getByTestId('surface-docx-editor')).toBeInTheDocument())

    act(() => {
      editorMock.lastProps?.onChanged()
      editorMock.lastProps?.onChanged()
    })
    const changes = sentMessages(postMessage).filter((message) => message.type === 'doc:changed')
    expect(changes.map((message) => message.revision)).toEqual([1, 2])
    expect(changes[0]).toMatchObject({ documentId: 'doc-1', nonce })

    act(() => editorMock.lastProps?.onSaveRequest())
    expect(
      sentMessages(postMessage).find((message) => message.type === 'doc:save-request')
    ).toMatchObject({ documentId: 'doc-1' })
  })

  it('壳 doc:save → 面 flush+save 并回 doc:save-bytes（requestId 原样带回）', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage)
    act(() => dispatchFromParent({ ...DOC, nonce }))
    await waitFor(() => expect(screen.getByTestId('surface-docx-editor')).toBeInTheDocument())

    act(() => {
      dispatchFromParent({ type: 'doc:save', nonce, requestId: 'req-1' })
    })
    await waitFor(() => expect(editorMock.saveCalls).toBe(1))
    const saveBytes = sentMessages(postMessage).find((message) => message.type === 'doc:save-bytes')
    expect(saveBytes).toMatchObject({ requestId: 'req-1', documentId: 'doc-1' })
    expect((saveBytes?.bytes as Uint8Array).byteLength).toBe(4)
    expect(screen.getByTestId('surface-save-stats')).toHaveAttribute('data-save-count', '1')
  })

  it('save() 回 null 时回 doc:error(phase=save)（不假装保存字节存在）', async () => {
    editorMock.saveBytes = null
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage)
    act(() => dispatchFromParent({ ...DOC, nonce }))
    await waitFor(() => expect(screen.getByTestId('surface-docx-editor')).toBeInTheDocument())

    act(() => {
      dispatchFromParent({ type: 'doc:save', nonce, requestId: 'req-x' })
    })
    await waitFor(() =>
      expect(
        sentMessages(postMessage).some(
          (message) => message.type === 'doc:error' && message.phase === 'save'
        )
      ).toBe(true)
    )
    expect(sentMessages(postMessage).some((message) => message.type === 'doc:save-bytes')).toBe(
      false
    )
  })

  it('doc:reload → loadDocumentBuffer；doc:close → 卸载编辑器；伪造 nonce 的消息一律丢弃', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage)
    act(() => dispatchFromParent({ ...DOC, nonce }))
    await waitFor(() => expect(screen.getByTestId('surface-docx-editor')).toBeInTheDocument())

    // 伪造 nonce：不改状态
    act(() => {
      dispatchFromParent({ type: 'doc:close', nonce: 'forged', documentId: 'doc-1' })
      dispatchFromParent({ type: 'doc:reload', nonce: 'forged', bytes: new Uint8Array([1]) })
    })
    await Promise.resolve()
    expect(screen.getByTestId('surface-docx-editor')).toBeInTheDocument()
    expect(editorMock.reloads).toHaveLength(0)

    act(() => {
      dispatchFromParent({ type: 'doc:reload', nonce, bytes: new Uint8Array([7, 7]) })
    })
    await waitFor(() => expect(editorMock.reloads).toHaveLength(1))
    expect(Array.from(editorMock.reloads[0] ?? [])).toEqual([7, 7])

    act(() => {
      dispatchFromParent({ type: 'doc:close', nonce, documentId: 'doc-1' })
    })
    await waitFor(() => expect(screen.queryByTestId('surface-docx-editor')).not.toBeInTheDocument())
    expect(screen.getByTestId('surface-doc-open')).toHaveAttribute('data-state', 'empty')
  })
})
describe('SurfaceBoot：M3-S4 面内快捷键转发', () => {
  /** 打开一个文档并等编辑器可交互 */
  async function openDoc(nonce: string): Promise<void> {
    act(() => dispatchFromParent({ ...DOC, nonce }))
    await waitFor(() => expect(screen.getByTestId('surface-docx-editor')).toBeInTheDocument())
    act(() => editorMock.lastProps?.onLoaded(1))
    await waitFor(() =>
      expect(screen.getByTestId('surface-editor-state')).toHaveAttribute('data-state', 'ready')
    )
  }

  it('Ctrl+S/W/Tab 在 capture 阶段拦下并只发动作名；Shift+Tab 反向；不带 Ctrl 不发', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage)
    await openDoc(nonce)

    // Ctrl+S：preventDefault（dispatchEvent 返回 false）+ 发 surface:shortcut save
    const saveEvent = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })
    expect(window.dispatchEvent(saveEvent)).toBe(false)
    // Ctrl+W：close
    expect(
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, cancelable: true })
      )
    ).toBe(false)
    // Ctrl+Tab：next-tab；Ctrl+Shift+Tab：prev-tab
    expect(
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, cancelable: true })
      )
    ).toBe(false)
    expect(
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          ctrlKey: true,
          shiftKey: true,
          cancelable: true
        })
      )
    ).toBe(false)

    const shortcuts = sentMessages(postMessage).filter(
      (message) => message.type === 'surface:shortcut'
    )
    expect(shortcuts.map((message) => message.action)).toEqual([
      'save',
      'close',
      'next-tab',
      'prev-tab'
    ])
    expect(shortcuts[0]?.nonce).toBe(nonce)

    // 没有 Ctrl 的 S/W、Ctrl+Shift+W（不归我们管）、Ctrl+Alt+S 都不发
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', cancelable: true }))
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'W', ctrlKey: true, shiftKey: true, cancelable: true })
    )
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', ctrlKey: true, altKey: true, cancelable: true })
    )
    expect(
      sentMessages(postMessage).filter((message) => message.type === 'surface:shortcut')
    ).toHaveLength(4)
  })

  it('握手未完成 / 还没有文档时不抢键（不 preventDefault、不发消息）', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    await waitFor(() => expect(postMessage).toHaveBeenCalled())

    const beforeReady = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      cancelable: true
    })
    expect(window.dispatchEvent(beforeReady)).toBe(true)

    const nonce = await handshake(postMessage)
    // 已 ready 但没有 doc：仍不转发
    const noDoc = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })
    expect(window.dispatchEvent(noDoc)).toBe(true)
    expect(nonce.length).toBeGreaterThan(0)
    expect(
      sentMessages(postMessage).filter((message) => message.type === 'surface:shortcut')
    ).toHaveLength(0)
  })
})
