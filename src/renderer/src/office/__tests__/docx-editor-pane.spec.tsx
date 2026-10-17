import type { ReactNode, Ref } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocxEditorPane } from '../DocxEditorPane'
import { officeDefaultZoom, OFFICE_ZOOM_RESIZE_DEBOUNCE_MS } from '../components/office-zoom'

/**
 * DocxEditorPane 的 A2 接线断言（不加载真实内核）：
 *   - `toolbar` 槽被 `OfficeRibbon` 占住（默认 File/Format/Insert/Help + 默认工具条消失）；
 *   - `showZoomControl=false`、`showOutlineButton=false`、`showFileOpen=false`、zh-CN i18n、默认 zoom；
 *   - QAT 保存走 `onSaveRequest`；QAT 保存态 text swap 与编辑/保存事件同步；
 *   - 视图 tab 的宿主开关会落到 DocxEditor 的 showRuler/showOutline/showMarginGuides props。
 */
const kernel = vi.hoisted(() => {
  const calls: Array<{ id: string; args?: unknown }> = []
  const zoomCalls: number[] = []
  const state = {
    active: false,
    enabled: true,
    disabledReason: null,
    value: null,
    options: [] as unknown[]
  }
  const source = {
    getDescriptor: (): null => null,
    getState: (): typeof state => ({ ...state, options: [...state.options] }),
    execute: async (id: string, args?: unknown): Promise<{ status: string }> => {
      calls.push({ id, args })
      return { status: 'executed' }
    },
    subscribe: (): (() => void) => () => undefined
  }
  return {
    calls,
    zoomCalls,
    setZoom: (zoom: number): void => {
      zoomCalls.push(zoom)
    },
    source,
    props: null as Record<string, unknown> | null
  }
})

vi.mock('@betteroffice/docx-react', async () => {
  const React = await import('react')
  const DocxEditor = React.forwardRef(function DocxEditorStub(
    props: Record<string, unknown>,
    ref: Ref<unknown>
  ) {
    kernel.props = props
    React.useImperativeHandle(ref, () => ({
      setZoom: kernel.setZoom,
      whenLayoutComplete: async (): Promise<number> => 1,
      flushPendingInput: async (): Promise<void> => undefined,
      save: async (): Promise<ArrayBuffer | null> => null,
      loadDocumentBuffer: async (): Promise<void> => undefined
    }))
    return React.createElement(
      'div',
      { 'data-testid': 'docx-editor-stub' },
      props.toolbar as ReactNode
    )
  })
  return {
    DocxEditor,
    useDocxCommands: (): unknown => kernel.source,
    ToolbarCommand: (): null => null
  }
})

vi.mock('@betteroffice/docx-i18n/zh-CN', () => ({
  default: { _lang: 'zh-CN' },
  zhCN: { _lang: 'zh-CN' }
}))

function renderPane(saveState: 'saved' | 'dirty' | 'saving' = 'saved'): {
  onSaveRequest: ReturnType<typeof vi.fn>
  onChanged: ReturnType<typeof vi.fn>
  rerenderWithSaveState: (state: 'saved' | 'dirty' | 'saving') => void
} {
  const onSaveRequest = vi.fn()
  const onChanged = vi.fn()
  const pane = (state: 'saved' | 'dirty' | 'saving'): React.JSX.Element => (
    <DocxEditorPane
      documentId="doc-1"
      name="数据仓管理系统建设技术方案.docx"
      bytes={new Uint8Array([1, 2, 3])}
      readOnly={false}
      theme="light"
      saveState={state}
      onChanged={onChanged}
      onSaveRequest={onSaveRequest}
      onLoaded={vi.fn()}
      onError={vi.fn()}
    />
  )
  const rendered = render(pane(saveState))
  return {
    onSaveRequest,
    onChanged,
    rerenderWithSaveState: (state) => rendered.rerender(pane(state))
  }
}

function editorProps(): Record<string, unknown> {
  expect(kernel.props).not.toBeNull()
  return kernel.props as Record<string, unknown>
}

afterEach(() => {
  vi.useRealTimers()
  kernel.calls.length = 0
  kernel.zoomCalls.length = 0
})

describe('DocxEditorPane × OfficeRibbon（A2 接线）', () => {
  it('用 toolbar 槽替换默认 chrome，并关掉内核自带的 zoom/outline 控件', () => {
    renderPane()
    expect(screen.getByTestId('office-ribbon')).toBeInTheDocument()

    const props = editorProps()
    expect(props.toolbar).toBeTruthy()
    expect(props.showZoomControl).toBe(false)
    expect(props.showOutlineButton).toBe(false)
    expect(props.showFileOpen).toBe(false)
    expect(props.downloadOnSave).toBe(false)
    expect(props.documentNameEditable).toBe(false)
    expect(props.colorMode).toBe('light')
    expect(props.readOnly).toBe(false)
    // zh-CN i18n 与默认 zoom（用户定调：1280 下纸面视觉宽 ≈860）
    expect(props.i18n).toBeDefined()
    expect(props.initialZoom).toBe(officeDefaultZoom(window.innerWidth))
    // 视图开关默认全关（用户 A0 定稿的画布形态；可在视图 tab 打开）
    expect(props.showRuler).toBe(false)
    expect(props.showOutline).toBe(false)
    expect(props.showMarginGuides).toBe(false)
  })

  it('QAT 保存 → onSaveRequest（面不再自己猜保存态，没有乐观计时器）；保存态由 props 驱动', () => {
    vi.useFakeTimers()
    const { onSaveRequest, onChanged, rerenderWithSaveState } = renderPane()

    expect(screen.getByTestId('office-ribbon-save-state')).toHaveTextContent('已保存')
    const onChange = editorProps().onChange as () => void
    act(() => onChange())
    expect(onChanged).toHaveBeenCalledTimes(1)
    // 面自己不改保存态（真相在壳）：props 还是 saved 就仍显示已保存
    expect(screen.getByTestId('office-ribbon-save-state')).toHaveTextContent('已保存')

    fireEvent.click(screen.getByTestId('office-qat-save'))
    expect(onSaveRequest).toHaveBeenCalledTimes(1)
    // 没有 1.5s 乐观窗口：时间推进不会让状态自己变成「已保存」
    act(() => {
      vi.advanceTimersByTime(1500)
    })
    expect(screen.getByTestId('office-ribbon-save-state')).toHaveTextContent('已保存')

    // 壳事件驱动的三个状态：saving / dirty / saved 都是 props
    rerenderWithSaveState('saving')
    expect(screen.getByTestId('office-ribbon-save-state')).toHaveTextContent('保存中…')
    rerenderWithSaveState('dirty')
    expect(screen.getByTestId('office-ribbon-save-state')).toHaveTextContent('未保存修改')
    rerenderWithSaveState('saved')
    expect(screen.getByTestId('office-ribbon-save-state')).toHaveTextContent('已保存')
  })

  it('Ctrl+S 通路（DocxEditor onSaveRequest）返回 false，且同样打给 onSaveRequest', () => {
    const { onSaveRequest } = renderPane()
    const saveRequest = editorProps().onSaveRequest as () => boolean
    let result: boolean | undefined
    act(() => {
      result = saveRequest()
    })
    expect(result).toBe(false)
    expect(onSaveRequest).toHaveBeenCalledTimes(1)
  })

  it('视图 tab 的宿主开关落到 DocxEditor props（showRuler/showOutline/showMarginGuides）', () => {
    renderPane()
    fireEvent.click(screen.getByTestId('office-ribbon-tab-view'))

    fireEvent.click(screen.getByTestId('office-ribbon-ruler'))
    expect(editorProps().showRuler).toBe(true)
    fireEvent.click(screen.getByTestId('office-ribbon-outline'))
    expect(editorProps().showOutline).toBe(true)
    fireEvent.click(screen.getByTestId('office-ribbon-margin-guides'))
    expect(editorProps().showMarginGuides).toBe(true)
  })

  it('QAT 撤销/重做通过命令适配层直连内核命令（不是假入口）', () => {
    renderPane()
    fireEvent.click(screen.getByTestId('office-qat-undo'))
    fireEvent.click(screen.getByTestId('office-qat-redo'))
    expect(kernel.calls).toEqual([
      { id: 'undo', args: undefined },
      { id: 'redo', args: undefined }
    ])
  })
})

describe('DocxEditorPane × 默认 fit-width（A4 resize 校准）', () => {
  const initialInnerWidth = window.innerWidth

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: initialInnerWidth
    })
  })

  it('窗口 resize 后按 fit-width 重算 zoom：120ms 防抖只调一次内核 setZoom', () => {
    vi.useFakeTimers()
    renderPane()
    expect(editorProps().initialZoom).toBe(officeDefaultZoom(initialInnerWidth))

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 720 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    // 拖拽窗口：防抖窗口内不调内核（避免动画队列抖动）
    expect(kernel.zoomCalls).toEqual([])

    act(() => {
      vi.advanceTimersByTime(OFFICE_ZOOM_RESIZE_DEBOUNCE_MS)
    })
    expect(kernel.zoomCalls).toEqual([officeDefaultZoom(720)])

    // 连续 resize 只跟最后一帧
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
    act(() => {
      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))
    })
    act(() => {
      vi.advanceTimersByTime(OFFICE_ZOOM_RESIZE_DEBOUNCE_MS)
    })
    expect(kernel.zoomCalls).toEqual([officeDefaultZoom(720), officeDefaultZoom(900)])
  })

  it('宽度没变（算出的 zoom 相同）不重复调用 setZoom', () => {
    vi.useFakeTimers()
    renderPane()
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: initialInnerWidth + 1
    })
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    act(() => {
      vi.advanceTimersByTime(OFFICE_ZOOM_RESIZE_DEBOUNCE_MS)
    })
    // 1600 级窗口都取 preferred 档（1.054），+1px 不产生新 zoom
    expect(kernel.zoomCalls).toEqual([])
  })
})
