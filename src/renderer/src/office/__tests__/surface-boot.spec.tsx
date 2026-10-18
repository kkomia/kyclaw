import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    saveState: string
    onChanged: () => void
    onSaveRequest: () => void
    onLoaded: (pages: number) => void
    onError: (phase: string, message: string) => void
  }
}))

const fontsMock = vi.hoisted(() => ({
  stats: {
    fonts: Array.from({ length: 6 }, (_, index) => ({
      family: `Face${String(index)}`,
      bytes: new Uint8Array([index + 1])
    })),
    faces: 6,
    uniqueFaces: 5,
    bytes: 10_467_004,
    ms: 42
  },
  ensureSurfaceFonts: vi.fn(async () => ({
    faces: 22,
    registrations: 46,
    fetchedBytes: 27_383_772,
    fontSetSize: 47,
    ms: 100,
    cjk: true
  })),
  loadPptxFonts: vi.fn(async () => fontsMock.stats)
}))

const pptxMock = vi.hoisted(() => ({
  saveBytes: new Uint8Array([8, 9]) as Uint8Array | null,
  saveCalls: 0,
  reloads: [] as Uint8Array[],
  lastProps: null as null | {
    documentId: string
    name: string
    readOnly: boolean
    theme: string
    fonts: readonly unknown[]
    onChanged: () => void
    onSaveRequest: () => void
    onLoaded: () => void
  }
}))

const xlsxMock = vi.hoisted(() => ({
  saveBytes: new Uint8Array([5, 6, 7]) as Uint8Array | null,
  saveCalls: 0,
  reloads: [] as Uint8Array[],
  lastProps: null as null | {
    documentId: string
    name: string
    readOnly: boolean
    theme: string
    onChanged: () => void
    onSaveRequest: () => void
    onLoaded: () => void
  }
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

vi.mock('../XlsxEditorPane', () => ({
  XlsxEditorPane: forwardRef<unknown, Record<string, unknown>>(
    function MockXlsxEditorPane(props, ref) {
      xlsxMock.lastProps = props as typeof xlsxMock.lastProps
      useImperativeHandle(ref, () => ({
        save: async () => {
          xlsxMock.saveCalls += 1
          return xlsxMock.saveBytes
        },
        reload: async (bytes: Uint8Array) => {
          xlsxMock.reloads.push(bytes)
        }
      }))
      return <div data-testid="surface-xlsx-editor" data-document-id={props.documentId as string} />
    }
  )
}))

vi.mock('../PptxEditorPane', () => ({
  PptxEditorPane: forwardRef<unknown, Record<string, unknown>>(
    function MockPptxEditorPane(props, ref) {
      pptxMock.lastProps = props as typeof pptxMock.lastProps
      useImperativeHandle(ref, () => ({
        save: async () => {
          pptxMock.saveCalls += 1
          return pptxMock.saveBytes
        },
        reload: async (bytes: Uint8Array) => {
          pptxMock.reloads.push(bytes)
        }
      }))
      return <div data-testid="surface-pptx-editor" data-document-id={props.documentId as string} />
    }
  )
}))

vi.mock('../fonts', () => fontsMock)

import { SurfaceBoot } from '../SurfaceBoot'
import { createSurfaceNonce } from '../bridge-protocol'

afterEach(() => {
  vi.useRealTimers()
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
  xlsxMock.saveBytes = new Uint8Array([5, 6, 7])
  xlsxMock.saveCalls = 0
  xlsxMock.reloads = []
  xlsxMock.lastProps = null
  pptxMock.saveBytes = new Uint8Array([8, 9])
  pptxMock.saveCalls = 0
  pptxMock.reloads = []
  pptxMock.lastProps = null
  fontsMock.ensureSurfaceFonts.mockClear()
  fontsMock.loadPptxFonts.mockClear()
  fontsMock.loadPptxFonts.mockImplementation(async () => fontsMock.stats)
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
  kind: 'docx',
  name: '方案.docx',
  sha256: 'a'.repeat(64),
  readOnly: false,
  bytes: new Uint8Array([9, 9, 9])
}

const DOC_XLSX = {
  type: 'doc:open',
  documentId: 'sheet-1',
  kind: 'xlsx',
  name: '预算.xlsx',
  sha256: 'b'.repeat(64),
  readOnly: false,
  bytes: new Uint8Array([7, 7, 7, 7])
}

const DOC_PPTX = {
  type: 'doc:open',
  documentId: 'slides-1',
  kind: 'pptx',
  name: '答辩.pptx',
  sha256: 'c'.repeat(64),
  readOnly: false,
  bytes: new Uint8Array([6, 6, 6])
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
  it('面挂载即注册本地字体（不等 doc:open）；字体就绪回 surface:fonts-ready，收到文档后直接挂编辑器', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)

    // task-76：字体注册从挂载就开始（不再等文档），并回一条 fonts-ready 给壳
    await waitFor(() => expect(fontsMock.ensureSurfaceFonts).toHaveBeenCalledTimes(1))
    const fontsReady = sentMessages(postMessage).find(
      (message) => message.type === 'surface:fonts-ready'
    )
    expect(fontsReady).toMatchObject({
      type: 'surface:fonts-ready',
      prewarm: false,
      stats: { faces: 22, registrations: 46, fetchedBytes: 27_383_772 }
    })

    const nonce = await handshake(postMessage)
    act(() => {
      dispatchFromParent({ ...DOC, nonce })
    })
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

  it('M4-X：doc:open kind=xlsx → 挂 XlsxEditorPane（不等字体），loaded 后 ready', async () => {
    // 字体尚未就绪也不该阻塞 XLSX（canvas 用浏览器字体）
    fontsMock.ensureSurfaceFonts.mockImplementationOnce(() => new Promise(() => {}))
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage)

    act(() => {
      dispatchFromParent({ ...DOC_XLSX, nonce })
    })
    await waitFor(() => expect(screen.getByTestId('surface-xlsx-editor')).toBeInTheDocument())
    // PB-019：xlsx 通常 <150ms 就绪 → 瞬时路径不渲染骨架（防闪）
    expect(screen.queryByTestId('surface-fonts-loading')).not.toBeInTheDocument()
    expect(screen.queryByTestId('surface-docx-editor')).not.toBeInTheDocument()
    expect(screen.getByTestId('surface-doc-open')).toHaveAttribute('data-bytes', '4')

    // xlsx pane 的 onLoaded 没有页数参数 → doc:loaded pages=0
    act(() => xlsxMock.lastProps?.onLoaded())
    const loaded = sentMessages(postMessage).find((message) => message.type === 'doc:loaded')
    expect(loaded).toMatchObject({ documentId: 'sheet-1', pages: 0 })
    expect(screen.getByTestId('surface-editor-state')).toHaveAttribute('data-state', 'ready')
    // PB-019：就绪后骨架 150ms 淡出（离场短于入场），之后 DOM 移除
    await waitFor(() =>
      expect(screen.queryByTestId('surface-fonts-loading')).not.toBeInTheDocument()
    )
  })

  it('PB-023 返工：xlsx 打开后既不 ready 也不报错 → 8s 看门狗转错误态（doc:error phase=open）', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    const timerSpy = vi.spyOn(window, 'setTimeout')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage)
    act(() => {
      dispatchFromParent({ ...DOC_XLSX, nonce })
    })
    await waitFor(() => expect(screen.getByTestId('surface-xlsx-editor')).toBeInTheDocument())

    // 不调用 onLoaded：模拟损坏文件/引擎静默失败；看门狗定时器必须已排上
    const watchdog = timerSpy.mock.calls.find((call) => call[1] === 8000)
    expect(watchdog).toBeDefined()
    act(() => {
      ;(watchdog?.[0] as () => void)()
    })

    await waitFor(() => expect(screen.getByTestId('surface-editor-error')).toBeInTheDocument())
    expect(screen.getByTestId('surface-editor-state')).toHaveAttribute('data-state', 'error')
    const errorMessage = sentMessages(postMessage).find((message) => message.type === 'doc:error')
    expect(errorMessage).toMatchObject({ phase: 'open' })
    // 骨架同步撤掉
    expect(screen.queryByTestId('surface-fonts-loading')).not.toBeInTheDocument()
  })

  it('M4-P：doc:open kind=pptx → 等 loadPptxFonts 成功后挂 PptxEditorPane（6 面稳定引用）', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage)
    act(() => {
      dispatchFromParent({ ...DOC_PPTX, nonce })
    })
    // 字体加载完成前不挂编辑器
    expect(screen.queryByTestId('surface-pptx-editor')).not.toBeInTheDocument()
    await waitFor(() => expect(fontsMock.loadPptxFonts).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('surface-pptx-editor')).toBeInTheDocument())
    expect(pptxMock.lastProps?.fonts).toBe(fontsMock.stats.fonts)
    expect(pptxMock.lastProps?.fonts).toHaveLength(6)
    expect(screen.getByTestId('surface-pptx-fonts')).toHaveAttribute(
      'data-pptx-fonts-state',
      'ready'
    )
    expect(screen.getByTestId('surface-pptx-fonts')).toHaveAttribute('data-pptx-fonts-faces', '6')
    expect(screen.getByTestId('surface-pptx-fonts')).toHaveAttribute('data-pptx-fonts-unique', '5')
    expect(screen.getByTestId('surface-pptx-fonts')).toHaveAttribute(
      'data-pptx-fonts-bytes',
      '10467004'
    )
    act(() => pptxMock.lastProps?.onLoaded())
    expect(
      sentMessages(postMessage).find((message) => message.type === 'doc:loaded')
    ).toMatchObject({ documentId: 'slides-1', pages: 0 })
  })

  it('M4-P：loadPptxFonts 失败 → 不挂编辑器（绝不空数组挂），错误态可重试', async () => {
    fontsMock.loadPptxFonts.mockImplementationOnce(async () => {
      throw new Error('pptx 本地字体加载超时')
    })
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage)
    act(() => {
      dispatchFromParent({ ...DOC_PPTX, nonce })
    })
    await waitFor(() => expect(screen.getByTestId('surface-pptx-fonts-error')).toBeInTheDocument())
    expect(screen.queryByTestId('surface-pptx-editor')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('surface-pptx-fonts-retry'))
    await waitFor(() => expect(screen.getByTestId('surface-pptx-editor')).toBeInTheDocument())
  })

  it('M4-X/P：doc:open 缺 kind / 未知 kind 一律丢弃', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage)
    act(() => {
      dispatchFromParent({ ...DOC, kind: 'pdf', nonce })
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryByTestId('surface-docx-editor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('surface-xlsx-editor')).not.toBeInTheDocument()
    expect(screen.queryByTestId('surface-pptx-editor')).not.toBeInTheDocument()
  })

  it('预热面（?officePrewarm=1）发出的 fonts-ready 带 prewarm:true（壳据此释放 hidden iframe）', async () => {
    window.history.replaceState({}, '', '/?officePrewarm=1')
    const postMessage = vi.spyOn(window, 'postMessage')
    try {
      render(<SurfaceBoot />)
      await waitFor(() =>
        expect(
          sentMessages(postMessage).some((message) => message.type === 'surface:fonts-ready')
        ).toBe(true)
      )
      const fontsReady = sentMessages(postMessage).find(
        (message) => message.type === 'surface:fonts-ready'
      )
      expect(fontsReady?.prewarm).toBe(true)
      expect(fontsReady?.stats).toBeTruthy()
    } finally {
      window.history.replaceState({}, '', '/')
    }
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
    // A4.5：编辑 = 未保存（QAT 状态由壳事件驱动，面只标脏）
    expect(editorMock.lastProps?.saveState).toBe('dirty')

    act(() => editorMock.lastProps?.onSaveRequest())
    const saveRequest = sentMessages(postMessage).find(
      (message) => message.type === 'doc:save-request'
    )
    expect(saveRequest).toMatchObject({ documentId: 'doc-1', nonce })
    // A4.5：保存请求带 requestId（壳按它回执），面进 saving
    expect(typeof saveRequest?.requestId).toBe('string')
    expect((saveRequest?.requestId as string).length).toBeGreaterThan(0)
    expect(editorMock.lastProps?.saveState).toBe('saving')
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
describe('SurfaceBoot：A4.5 保存结果回传（doc:save-result 事件驱动）', () => {
  /** 握手 + 开文档 + 布局完成（可交互） */
  async function openReadyDoc(): Promise<{
    postMessage: ReturnType<typeof vi.spyOn>
    nonce: string
  }> {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    const nonce = await handshake(postMessage)
    act(() => dispatchFromParent({ ...DOC, nonce }))
    await waitFor(() => expect(screen.getByTestId('surface-docx-editor')).toBeInTheDocument())
    act(() => editorMock.lastProps?.onLoaded(1))
    await waitFor(() =>
      expect(screen.getByTestId('surface-editor-state')).toHaveAttribute('data-state', 'ready')
    )
    return { postMessage, nonce }
  }

  function saveRequests(postMessage: ReturnType<typeof vi.spyOn>): SentMessage[] {
    return sentMessages(postMessage).filter((message) => message.type === 'doc:save-request')
  }

  it('回执 ok → 已保存；失败 → 未保存 + 只用壳给的人话（面不自己造）', async () => {
    const { postMessage, nonce } = await openReadyDoc()

    act(() => editorMock.lastProps?.onSaveRequest())
    const first = saveRequests(postMessage).at(-1)
    expect(editorMock.lastProps?.saveState).toBe('saving')

    act(() =>
      dispatchFromParent({
        type: 'doc:save-result',
        nonce,
        requestId: first?.requestId,
        ok: true
      })
    )
    expect(editorMock.lastProps?.saveState).toBe('saved')
    expect(screen.getByTestId('surface-save-stats')).toHaveAttribute('data-save-state', 'saved')
    expect(screen.queryByTestId('surface-save-error')).not.toBeInTheDocument()

    // 失败：QAT 回未保存 + 错误行显示壳给的人话（不是面自己编的）
    act(() => editorMock.lastProps?.onSaveRequest())
    const second = saveRequests(postMessage).at(-1)
    act(() =>
      dispatchFromParent({
        type: 'doc:save-result',
        nonce,
        requestId: second?.requestId,
        ok: false,
        code: 'write-locked',
        message: '文件被其他程序占用，可以先另存为再替换'
      })
    )
    expect(editorMock.lastProps?.saveState).toBe('dirty')
    expect(screen.getByTestId('surface-save-error')).toHaveTextContent(
      '文件被其他程序占用，可以先另存为再替换'
    )
    expect(screen.getByTestId('surface-save-stats')).toHaveAttribute('data-save-state', 'dirty')
  })

  it('保存期间又编辑：回执 ok 也仍显示未保存（与壳 save-machine 的 seq 口径一致）', async () => {
    const { postMessage, nonce } = await openReadyDoc()

    act(() => editorMock.lastProps?.onSaveRequest())
    const request = saveRequests(postMessage).at(-1)
    // 保存请求已发出后用户继续编辑
    act(() => editorMock.lastProps?.onChanged())
    expect(editorMock.lastProps?.saveState).toBe('dirty')

    act(() =>
      dispatchFromParent({
        type: 'doc:save-result',
        nonce,
        requestId: request?.requestId,
        ok: true
      })
    )
    // 写盘只覆盖到"发起那一刻"的内容，期间的新编辑仍是未保存
    expect(editorMock.lastProps?.saveState).toBe('dirty')
  })

  it('旧 requestId 的回执忽略：只认最新那一次保存', async () => {
    const { postMessage, nonce } = await openReadyDoc()

    act(() => editorMock.lastProps?.onSaveRequest())
    const first = saveRequests(postMessage).at(-1)
    act(() => editorMock.lastProps?.onSaveRequest())
    const second = saveRequests(postMessage).at(-1)
    expect(second?.requestId).not.toBe(first?.requestId)

    // 旧请求的回执：不落定（仍在保存中）
    act(() =>
      dispatchFromParent({
        type: 'doc:save-result',
        nonce,
        requestId: first?.requestId,
        ok: true
      })
    )
    expect(editorMock.lastProps?.saveState).toBe('saving')

    // 最新请求的回执才生效
    act(() =>
      dispatchFromParent({
        type: 'doc:save-result',
        nonce,
        requestId: second?.requestId,
        ok: true
      })
    )
    expect(editorMock.lastProps?.saveState).toBe('saved')
  })

  it('15s 没有回执：回未保存 + 「保存未确认」（绝不假装已保存）；晚到的真实回执仍采信', async () => {
    const { postMessage, nonce } = await openReadyDoc()
    vi.useFakeTimers()

    act(() => editorMock.lastProps?.onSaveRequest())
    expect(editorMock.lastProps?.saveState).toBe('saving')

    act(() => vi.advanceTimersByTime(15_000))
    expect(editorMock.lastProps?.saveState).toBe('dirty')
    expect(screen.getByTestId('surface-save-error')).toHaveTextContent('保存未确认')

    // 壳的写盘其实成功了、回执只是晚到：仍按真实结果落定
    const request = saveRequests(postMessage).at(-1)
    act(() =>
      dispatchFromParent({
        type: 'doc:save-result',
        nonce,
        requestId: request?.requestId,
        ok: true
      })
    )
    expect(editorMock.lastProps?.saveState).toBe('saved')
  })

  it('壳侧发起的保存（面没有在途请求）：回执同样采信（QAT 与状态栏一致）', async () => {
    const { nonce } = await openReadyDoc()

    act(() =>
      dispatchFromParent({
        type: 'doc:save-result',
        nonce,
        requestId: 'shell-initiated-1',
        ok: false,
        code: 'conflict',
        message: '文件在打开后被其他程序改过，需要先决定怎么处理'
      })
    )
    expect(editorMock.lastProps?.saveState).toBe('dirty')
    expect(screen.getByTestId('surface-save-error')).toHaveTextContent('文件在打开后被其他程序改过')

    act(() =>
      dispatchFromParent({
        type: 'doc:save-result',
        nonce,
        requestId: 'shell-initiated-2',
        ok: true
      })
    )
    expect(editorMock.lastProps?.saveState).toBe('saved')
  })

  it('伪造 nonce / 畸形回执丢弃（不改保存态、不抛）', async () => {
    const { nonce } = await openReadyDoc()

    act(() =>
      dispatchFromParent({
        type: 'doc:save-result',
        nonce: 'forged',
        requestId: 'x',
        ok: false,
        message: '假失败'
      })
    )
    act(() =>
      dispatchFromParent({
        type: 'doc:save-result',
        nonce,
        requestId: 'x',
        ok: 'yes'
      })
    )
    expect(editorMock.lastProps?.saveState).toBe('saved')
    expect(screen.queryByTestId('surface-save-error')).not.toBeInTheDocument()
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

    // Ctrl+S：preventDefault（dispatchEvent 返回 false）+ 走面自己的保存入口（A4.5：带 requestId，
    // 不再转 surface:shortcut —— 这样壳的写盘回执能回给 QAT）
    const saveEvent = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true })
    expect(window.dispatchEvent(saveEvent)).toBe(false)
    expect(
      sentMessages(postMessage).filter((message) => message.type === 'doc:save-request')
    ).toHaveLength(1)
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
    // A4.5：Ctrl+S 不再是 surface:shortcut 动作（走保存回执链路）
    expect(shortcuts.map((message) => message.action)).toEqual(['close', 'next-tab', 'prev-tab'])
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
    ).toHaveLength(3)
    // 这些也不该触发保存请求（只发了一条：上面那个 Ctrl+S）
    expect(
      sentMessages(postMessage).filter((message) => message.type === 'doc:save-request')
    ).toHaveLength(1)
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

  it('PB-019：未就绪 ≥150ms 才显示骨架（docx 字体慢路径，升格面同样显示）', async () => {
    // 让字体链一直 pending：未就绪会超过 150ms
    fontsMock.ensureSurfaceFonts.mockImplementationOnce(() => new Promise(() => {}))
    window.history.replaceState({}, '', '/?officePrewarm=1')
    try {
      const postMessage = vi.spyOn(window, 'postMessage')
      render(<SurfaceBoot />)
      await waitFor(() => expect(postMessage).toHaveBeenCalled())
      const nonce = await handshake(postMessage)
      act(() => {
        dispatchFromParent({ ...DOC, nonce })
      })
      // <150ms：还没到显示阈值（瞬时路径不闪）
      expect(screen.queryByTestId('surface-fonts-loading')).not.toBeInTheDocument()
      // ≥150ms：骨架出现（预热/升格面也一样，pptx 在升格面里等 6 面时必须有加载态）
      await waitFor(
        () => expect(screen.getByTestId('surface-fonts-loading')).toBeInTheDocument(),
        { timeout: 2000 }
      )
      expect(screen.getByTestId('surface-fonts-loading')).toHaveAttribute(
        'data-surface-loading-stage',
        '3'
      )
      expect(screen.getByText('正在准备中文字体')).toBeInTheDocument()
      expect(screen.getByText(/46 个字面/)).toBeInTheDocument()
    } finally {
      window.history.replaceState({}, '', '/')
    }
  })

  it('PB-019：<150ms 就绪 → 不渲染骨架（瞬时路径防闪）', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    await waitFor(() => expect(postMessage).toHaveBeenCalled())
    const nonce = await handshake(postMessage)
    act(() => {
      dispatchFromParent({ ...DOC_XLSX, nonce })
    })
    act(() => xlsxMock.lastProps?.onLoaded())
    // 过了 150ms 阈值也不应出现骨架（就绪早于阈值）
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(screen.queryByTestId('surface-fonts-loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('surface-editor-state')).toHaveAttribute('data-state', 'ready')
  })

  it("PB-019：init.motion='reduced' 写 [data-motion]，缺省为 full", async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    await waitFor(() => expect(postMessage).toHaveBeenCalled())
    const nonce = await handshake(postMessage)
    expect(document.documentElement.dataset.motion).toBe('full')
    act(() => {
      dispatchFromParent({
        type: 'surface:init',
        nonce,
        locale: 'zh-CN',
        theme: 'light',
        motion: 'reduced'
      })
    })
    expect(document.documentElement.dataset.motion).toBe('reduced')
    // 主题切换重发 init（不带 motion）→ 回落 full（旧壳兼容语义）
    act(() => {
      dispatchFromParent({
        type: 'surface:init',
        nonce,
        locale: 'zh-CN',
        theme: 'dark'
      })
    })
    expect(document.documentElement.dataset.motion).toBe('full')
  })

  it('PB-019 E8：编辑器报错（损坏文档）→ 骨架立刻撤掉，不盖错误条/重试', async () => {
    const postMessage = vi.spyOn(window, 'postMessage')
    render(<SurfaceBoot />)
    await waitFor(() => expect(postMessage).toHaveBeenCalled())
    const nonce = await handshake(postMessage)
    act(() => {
      dispatchFromParent({ ...DOC_XLSX, nonce })
    })
    await waitFor(() => expect(screen.getByTestId('surface-xlsx-editor')).toBeInTheDocument())
    // 一直不 onLoaded → 等过 150ms 阈值，骨架出现
    await waitFor(
      () => expect(screen.getByTestId('surface-fonts-loading')).toBeInTheDocument(),
      { timeout: 2000 }
    )
    // 解析失败：编辑器报错 → 骨架必须立刻消失（不等最短展示），错误态与重试可见
    act(() => xlsxMock.lastProps?.onError?.('open', 'bad zip: invalid Zip archive'))
    await waitFor(() =>
      expect(screen.queryByTestId('surface-fonts-loading')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('surface-editor-state')).toHaveAttribute('data-state', 'error')
    // 报错消息已经转给壳
    expect(sentMessages(postMessage).some((message) => message.type === 'doc:error')).toBe(true)
    // 画布上的可视错误条 + 重试（调试条里的 surface-error 在非 debug 下不可见）
    const errorBar = screen.getByTestId('surface-editor-error')
    expect(errorBar).toBeInTheDocument()
    expect(errorBar).toHaveTextContent('bad zip')
    expect(screen.getByTestId('surface-editor-error-retry')).toBeInTheDocument()
    // 点重试 → 清错误、编辑器重新挂载（同一份字节再试一次）
    act(() => screen.getByTestId('surface-editor-error-retry').click())
    expect(screen.queryByTestId('surface-editor-error')).not.toBeInTheDocument()
    expect(screen.getByTestId('surface-editor-state')).toHaveAttribute('data-state', 'loading')
  })
})
