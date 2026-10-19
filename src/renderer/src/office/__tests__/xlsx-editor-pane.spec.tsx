import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Ref } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { XlsxEditorPane, type XlsxEditorPaneHandle } from '../XlsxEditorPane'

/**
 * XlsxEditorPane 接线（不加载 wasm）：
 *   - 自定义 toolbar（不含 save/exportPng/print，D16 能力收口）+ 能力提示可见；
 *   - onSave（内置保存按钮/快捷键）→ 宿主 onSaveRequest，不下载 bytes；
 *   - save() 先 await version() 再同步 save()；XlsxSaveRefusedError 分类回 onError('save')；
 *   - reload 以新 file 重挂 XlsxEditor；onReady → onLoaded。
 */
const kernel = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  renderCount: 0,
  versionCalls: 0,
  saveCalls: 0,
  saveBytes: new Uint8Array([4, 5, 6]),
  saveError: null as Error | null,
  toolbarProps: null as Record<string, unknown> | null
}))

vi.mock('@betteroffice/xlsx-react', async () => {
  const React = await import('react')
  class MockXlsxSaveRefusedError extends Error {
    readonly code: 'input-pending' | 'input-failed'
    constructor(code: 'input-pending' | 'input-failed') {
      super(code)
      this.code = code
    }
  }
  const passthrough = ({ children }: { children?: unknown }): unknown =>
    React.createElement('div', null, children as never)
  const XlsxEditor = React.forwardRef(function XlsxEditorStub(
    props: Record<string, unknown>,
    ref: Ref<unknown>
  ) {
    kernel.props = props
    kernel.renderCount += 1
    React.useImperativeHandle(ref, () => ({}))
    return React.createElement('div', { 'data-testid': 'xlsx-editor-stub' }, props.toolbar as never)
  })
  const EditorToolbar = (props: Record<string, unknown>): unknown => {
    kernel.toolbarProps = props
    return React.createElement('div', null, props.children as never)
  }
  return {
    XlsxEditor,
    XlsxSaveRefusedError: MockXlsxSaveRefusedError,
    EditorToolbar: Object.assign(EditorToolbar, {
      Toolbar: passthrough,
      FormulaBar: () => null
    }),
    ToolbarCommand: () => null,
    ToolbarCommandButton: () => null,
    ToolbarCommandSelect: () => null,
    ToolbarGroup: passthrough
  }
})

vi.mock('@betteroffice/xlsx-i18n/zh-CN', () => ({
  default: { _lang: 'zh-CN' }
}))

// M4-X：pane 会先 initWasm（显式同源 URL）再挂 XlsxEditor；jsdom 里 mock 掉内核初始化
vi.mock('@betteroffice/xlsx', () => ({
  initWasm: vi.fn(async () => undefined)
}))

const SOURCE = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/office/XlsxEditorPane.tsx'),
  'utf8'
)

function renderPane(): {
  onSaveRequest: ReturnType<typeof vi.fn>
  onChanged: ReturnType<typeof vi.fn>
  onLoaded: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
  rerender: () => void
  waitReady: () => Promise<HTMLElement>
  ref: { current: XlsxEditorPaneHandle | null }
} {
  const onSaveRequest = vi.fn()
  const onChanged = vi.fn()
  const onLoaded = vi.fn()
  const onError = vi.fn()
  const ref = { current: null as XlsxEditorPaneHandle | null }
  const view = render(
    <XlsxEditorPane
      ref={ref}
      documentId="xlsx-1"
      name="预算.xlsx"
      bytes={new Uint8Array([1, 2, 3])}
      readOnly={false}
      theme="light"
      onChanged={onChanged}
      onSaveRequest={onSaveRequest}
      onLoaded={onLoaded}
      onError={onError}
    />
  )
  return {
    onSaveRequest,
    onChanged,
    onLoaded,
    onError,
    ref,
    waitReady: () => screen.findByTestId('xlsx-editor-stub'),
    rerender: () =>
      view.rerender(
        <XlsxEditorPane
          ref={ref}
          documentId="xlsx-1"
          name="预算.xlsx"
          bytes={new Uint8Array([1, 2, 3])}
          readOnly={false}
          theme="light"
          onChanged={onChanged}
          onSaveRequest={onSaveRequest}
          onLoaded={onLoaded}
          onError={onError}
        />
      )
  }
}

afterEach(() => {
  kernel.props = null
  kernel.renderCount = 0
  kernel.versionCalls = 0
  kernel.saveCalls = 0
  kernel.saveError = null
  kernel.toolbarProps = null
})

describe('XlsxEditorPane：M4-X 接线', () => {
  it('自定义 toolbar 不含 save/exportPng/print；能力提示可见（D16）', async () => {
    const pane = renderPane()
    await pane.waitReady()
    expect(screen.getByTestId('xlsx-editor-stub')).toBeInTheDocument()
    expect(screen.getByTestId('office-format-note')).toHaveTextContent('打印、导出与演示')
    const toolbarProps = kernel.props?.toolbar
    expect(toolbarProps).toBeTruthy()
    // 自定义 toolbar 的源码里不再出现这三个命令 id（默认工具栏有）
    expect(SOURCE).not.toMatch(/id=["']save["']/)
    expect(SOURCE).not.toMatch(/id=["']exportPng["']/)
    expect(SOURCE).not.toMatch(/id=["']print["']/)
    // 保留常用格式命令
    for (const id of ['fontFamily', 'fontSize', 'bold', 'numberFormat', 'merge']) {
      expect(SOURCE).toContain(`id="${id}"`)
    }
  })

  it('onSave → 宿主 onSaveRequest（不触发下载）', async () => {
    const pane = renderPane()
    await pane.waitReady()
    act(() => {
      ;(kernel.props?.onSave as () => void)()
    })
    expect(pane.onSaveRequest).toHaveBeenCalledTimes(1)
  })

  it('onChange → 宿主 onChanged；onReady(api) → onLoaded', async () => {
    const pane = renderPane()
    await pane.waitReady()
    act(() => {
      ;(kernel.props?.onChange as () => void)()
      ;(kernel.props?.onReady as (api: unknown) => void)({ version: vi.fn(), save: vi.fn() })
    })
    expect(pane.onChanged).toHaveBeenCalledTimes(1)
    expect(pane.onLoaded).toHaveBeenCalledTimes(1)
  })

  it('save()：先 await version() 再 api.save()，返回字节', async () => {
    const pane = renderPane()
    await pane.waitReady()
    const api = {
      version: vi.fn(async () => {
        kernel.versionCalls += 1
        return 'v1'
      }),
      save: vi.fn(() => {
        kernel.saveCalls += 1
        if (kernel.saveError !== null) throw kernel.saveError
        return kernel.saveBytes
      })
    }
    act(() => {
      ;(kernel.props?.onReady as (api: unknown) => void)(api)
    })
    let bytes: Uint8Array | null = null
    await act(async () => {
      bytes = (await pane.ref.current?.save()) ?? null
    })
    expect(kernel.versionCalls).toBe(1)
    expect(kernel.saveCalls).toBe(1)
    expect(bytes).toEqual(kernel.saveBytes)
  })

  it('save() 遇 XlsxSaveRefusedError → onError(save) 并回 null（不假装字节）', async () => {
    const pane = renderPane()
    await pane.waitReady()
    const { XlsxSaveRefusedError } = (await import('@betteroffice/xlsx-react')) as unknown as {
      XlsxSaveRefusedError: new (code: 'input-pending' | 'input-failed') => Error
    }
    const api = {
      version: vi.fn(async () => 'v1'),
      save: vi.fn(() => {
        throw new XlsxSaveRefusedError('input-pending')
      })
    }
    act(() => {
      ;(kernel.props?.onReady as (api: unknown) => void)(api)
    })
    let bytes: Uint8Array | null = new Uint8Array([9])
    await act(async () => {
      bytes = (await pane.ref.current?.save()) ?? null
    })
    expect(bytes).toBeNull()
    expect(pane.onError).toHaveBeenCalledWith('save', expect.stringContaining('输入'))
  })

  it('reload(bytes) 以新 file 重挂 XlsxEditor（render 次数 +1）', async () => {
    const pane = renderPane()
    await pane.waitReady()
    const before = kernel.renderCount
    await act(async () => {
      await pane.ref.current?.reload(new Uint8Array([8, 8]))
    })
    expect(kernel.renderCount).toBe(before + 1)
    expect(kernel.props?.file).toEqual(new Uint8Array([8, 8]))
  })

  it('PB-020：Ctrl+F 打开查找条；输入走 api.findText，命中走 selectCells（真查找通道）', async () => {
    const pane = renderPane()
    await pane.waitReady()
    const findText = vi.fn(async () => ({
      ok: true as const,
      version: 'v1',
      truncated: false,
      matches: [
        { cell: { sheetId: 'sheet-2', row: 4, col: 1, a1: 'B5' }, text: '预算' },
        { cell: { sheetId: 'sheet-2', row: 9, col: 2, a1: 'C10' }, text: '预算表' }
      ]
    }))
    const selectCells = vi.fn(() => true)
    const api = {
      version: vi.fn(async () => 'v1'),
      save: vi.fn(() => new Uint8Array([1])),
      findText,
      readCells: vi.fn(async () => ({
        ok: true as const,
        version: 'v1',
        calculation: { status: 'done' },
        ranges: [],
        sheets: [
          { sheetId: 'sheet-1', name: 'Sheet1', editable: true },
          { sheetId: 'sheet-2', name: 'Sheet2', editable: true }
        ]
      })),
      selectCells
    }
    act(() => {
      ;(kernel.props?.onReady as (value: unknown) => void)(api)
    })

    // Ctrl+F → 查找条出现（此前点击工具栏 searchMenus 无反应 = 没接 onSearchMenus）
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    const input = await screen.findByTestId('xlsx-find-input')
    fireEvent.change(input, { target: { value: '预算' } })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220))
    })

    expect(findText).toHaveBeenCalledWith({ text: '预算', limit: 1000 })
    // 自动跳到第 1 条：sheetId → 序号（sheet-2 = index 1），选中该格
    expect(selectCells).toHaveBeenCalledWith(1, {
      anchor: { row: 4, col: 1 },
      focus: { row: 4, col: 1 }
    })
    expect(screen.getByTestId('xlsx-find-count')).toHaveTextContent('1/2')
  })

  it('commands 模式工具栏不接收 legacy 专属 props（上游会 throw）+ 自查按钮能开查找条', async () => {
    const pane = renderPane()
    await pane.waitReady()

    // 上游 `fs` 名单（@betteroffice/xlsx-react 0.3.0）：commands 模式下传任一即
    // `A commands-mode EditorToolbar reads state and actions from the editor's commands; remove …`
    const legacyOnly = [
      'currentFormatting',
      'selectionShape',
      'onFormat',
      'onMerge',
      'onSearchMenus',
      'onUndo',
      'onRedo',
      'canUndo',
      'canRedo',
      'onPrint',
      'zoom',
      'onZoomChange',
      'fontFamilies',
      'fontSizes',
      'disabled'
    ]
    const passed = Object.keys(kernel.toolbarProps ?? {})
    expect(passed.filter((key) => legacyOnly.includes(key))).toEqual([])
    expect(kernel.toolbarProps?.mode).toBe('commands')

    // 查找入口是我们自己的按钮（上游 searchMenus 命令在 commands 模式无法回调宿主）
    fireEvent.click(screen.getByTestId('xlsx-find-button'))
    expect(await screen.findByTestId('xlsx-find-bar')).toBeInTheDocument()
  })
})
