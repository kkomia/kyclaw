import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  createFakeOfficeCommandAdapter,
  type FakeOfficeCommandAdapter
} from '../components/office-command-adapter'
import { OfficeRibbonView, type OfficeRibbonViewProps } from '../components/OfficeRibbonView'

/**
 * ribbon 纯表现层（A2）。用 A2-prep 的 fake adapter 驱动命令状态：
 * 不加载内核（`@betteroffice/docx-react` 只 mock 出 `ToolbarCommand` 供 control:'builtin' 用），
 * 覆盖：5 tab / 组标签 / 命令执行 / active / disabled / select / 折叠 / 横滚 / split 色板 / QAT。
 */
vi.mock('@betteroffice/docx-react', () => ({
  ToolbarCommand: () => null
}))

type RenderOverrides = Omit<Partial<OfficeRibbonViewProps>, 'adapter' | 'onRequestSave'>

function renderView(overrides: RenderOverrides = {}): {
  adapter: FakeOfficeCommandAdapter
  onRequestSave: ReturnType<typeof vi.fn>
} {
  const adapter = createFakeOfficeCommandAdapter()
  const onRequestSave = vi.fn()
  render(
    <OfficeRibbonView
      adapter={adapter}
      documentName="数据仓管理系统建设技术方案.docx"
      saveState="saved"
      readOnly={false}
      onRequestSave={onRequestSave}
      {...overrides}
    />
  )
  return { adapter, onRequestSave }
}

describe('OfficeRibbonView：结构与 QAT', () => {
  it('渲染 5 个 tab、组标签、文档名与 AI 占位按钮', () => {
    renderView()

    expect(screen.getByTestId('office-ribbon')).toBeInTheDocument()
    for (const id of ['home', 'insert', 'layout', 'review', 'view']) {
      expect(screen.getByTestId(`office-ribbon-tab-${id}`)).toBeInTheDocument()
    }
    // 默认「开始」：组标签常显（字体/段落/样式/文本…）
    for (const label of ['样式', '字体', '文本', '段落']) {
      expect(screen.getByRole('group', { name: label })).toBeInTheDocument()
    }
    expect(screen.getByTestId('office-ribbon-doc-title')).toHaveTextContent(
      '数据仓管理系统建设技术方案.docx'
    )
    expect(screen.getByTestId('office-ribbon-save-state')).toHaveTextContent('已保存')
    // AI 面板 v1 只做按钮（A3 接面板）：没有回调时诚实禁用
    expect(screen.getByTestId('office-ribbon-ai')).toBeDisabled()
  })

  it('上下文组（图片/表格）v1 默认隐藏，开关打开才渲染', () => {
    renderView()
    expect(screen.queryByTestId('office-ribbon-group-home-image-context')).not.toBeInTheDocument()
    expect(screen.queryByTestId('office-ribbon-group-home-table-context')).not.toBeInTheDocument()
  })

  it('打开 showContextGroups 后渲染图片/表格上下文组', () => {
    renderView({ showContextGroups: true })
    expect(screen.getByTestId('office-ribbon-group-home-image-context')).toBeInTheDocument()
    expect(screen.getByTestId('office-ribbon-group-home-table-context')).toBeInTheDocument()
  })

  it('QAT 保存走 onRequestSave（既有 onSaveRequest 通路），撤销/重做走命令适配层', () => {
    const { adapter, onRequestSave } = renderView()
    fireEvent.click(screen.getByTestId('office-qat-save'))
    expect(onRequestSave).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByTestId('office-qat-undo'))
    expect(adapter.calls).toEqual([{ id: 'undo', args: undefined }])
  })

  it('保存态 text swap：dirty / saving / saved 三态', () => {
    const adapter = createFakeOfficeCommandAdapter()
    const baseProps = {
      adapter,
      documentName: '数据仓管理系统建设技术方案.docx',
      readOnly: false,
      onRequestSave: vi.fn()
    }
    const { rerender } = render(<OfficeRibbonView {...baseProps} saveState="dirty" />)
    expect(screen.getByTestId('office-ribbon-save-state')).toHaveTextContent('未保存修改')
    rerender(<OfficeRibbonView {...baseProps} saveState="saving" />)
    expect(screen.getByTestId('office-ribbon-save-state')).toHaveTextContent('保存中…')
    expect(screen.getByTestId('office-ribbon-dirty-badge')).toHaveAttribute('data-dirty', 'true')
  })
})

describe('OfficeRibbonView：tab 切换与折叠', () => {
  it('切 tab 后只渲染该 tab 的分组；折叠按钮收起工具带，点 tab 自动展开', () => {
    renderView()
    fireEvent.click(screen.getByTestId('office-ribbon-tab-insert'))
    expect(screen.getByTestId('office-ribbon-group-insert-pages')).toBeInTheDocument()
    expect(screen.queryByTestId('office-ribbon-group-home-text')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('office-ribbon-collapse'))
    expect(screen.getByTestId('office-ribbon')).toHaveAttribute('data-collapsed', 'true')
    fireEvent.click(screen.getByTestId('office-ribbon-tab-home'))
    expect(screen.getByTestId('office-ribbon')).toHaveAttribute('data-collapsed', 'false')
  })

  it('工具带支持滚轮横滚（有溢出时拦截 wheel）', () => {
    renderView()
    const band = screen.getByTestId('office-ribbon-band')
    Object.defineProperty(band, 'scrollWidth', { configurable: true, value: 1200 })
    Object.defineProperty(band, 'clientWidth', { configurable: true, value: 600 })
    const wheel = new Event('wheel', { bubbles: true, cancelable: true }) as WheelEvent
    Object.defineProperty(wheel, 'deltaY', { configurable: true, value: 120 })
    band.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)

    // 没有溢出时不拦截（让页面/内层滚动区自己处理）
    Object.defineProperty(band, 'clientWidth', { configurable: true, value: 2000 })
    const noOverflowWheel = new Event('wheel', {
      bubbles: true,
      cancelable: true
    }) as WheelEvent
    Object.defineProperty(noOverflowWheel, 'deltaY', { configurable: true, value: 120 })
    band.dispatchEvent(noOverflowWheel)
    expect(noOverflowWheel.defaultPrevented).toBe(false)
  })
})

describe('OfficeRibbonView：命令状态（active / disabled / select / split）', () => {
  it('点击加粗执行 bold；active 来自命令 state', () => {
    const { adapter } = renderView()
    fireEvent.click(screen.getByTestId('office-ribbon-bold'))
    expect(adapter.calls).toEqual([{ id: 'bold', args: undefined }])

    act(() => adapter.setState('bold', { active: true }))
    expect(screen.getByTestId('office-ribbon-bold')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('office-ribbon-bold')).toHaveAttribute('aria-pressed', 'true')
  })

  it('disabled 由命令 state.enabled 驱动，点击不执行', () => {
    const { adapter } = renderView()
    act(() =>
      adapter.setState('italic', {
        enabled: false,
        disabledReason: { code: 'read-only', message: '只读' }
      })
    )
    const italic = screen.getByTestId('office-ribbon-italic')
    expect(italic).toBeDisabled()
    fireEvent.click(italic)
    expect(adapter.calls).toEqual([])
  })

  it('select 选项来自 command state.options，切换后按 option.args 执行', () => {
    const { adapter } = renderView()
    act(() =>
      adapter.setState('fontSize', {
        value: 12,
        options: [
          { label: '12', args: { points: 12 } },
          { label: '14', args: { points: 14 } }
        ]
      })
    )
    const select = screen.getByTestId('office-ribbon-font-size') as HTMLSelectElement
    expect(select.value).toBe('0')
    fireEvent.change(select, { target: { value: '1' } })
    expect(adapter.calls).toEqual([{ id: 'fontSize', args: { points: 14 } }])
  })

  it('颜色 split：打开色板，点色块按 { color } 执行并关闭', () => {
    const { adapter } = renderView()
    fireEvent.click(screen.getByTestId('office-ribbon-text-color'))
    const palette = screen.getByTestId('office-ribbon-color-palette')
    expect(palette).toBeInTheDocument()
    fireEvent.click(palette.querySelector('[aria-label="FF0000"]') as HTMLElement)
    expect(adapter.calls).toEqual([{ id: 'textColor', args: { color: 'FF0000' } }])
    expect(screen.queryByTestId('office-ribbon-color-palette')).not.toBeInTheDocument()
  })

  it('控制内置控件的三项（insertTable/tableAction/imageTransform）走 ToolbarCommand，不盲 execute', () => {
    const { adapter } = renderView()
    fireEvent.click(screen.getByTestId('office-ribbon-tab-insert'))
    expect(screen.getByTestId('office-ribbon-builtin-insertTable')).toBeInTheDocument()
    expect(adapter.calls).toEqual([])
  })
})

describe('OfficeRibbonView：视图宿主开关', () => {
  it('标尺/大纲/页边距参考线是宿主开关，回调 + active 由 props 驱动', () => {
    const onToggleHost = vi.fn()
    const adapter = createFakeOfficeCommandAdapter()
    render(
      <OfficeRibbonView
        adapter={adapter}
        documentName="数据仓管理系统建设技术方案.docx"
        saveState="saved"
        readOnly={false}
        onRequestSave={vi.fn()}
        hostToggles={{ ruler: true }}
        onToggleHost={onToggleHost}
      />
    )
    fireEvent.click(screen.getByTestId('office-ribbon-tab-view'))
    expect(screen.getByTestId('office-ribbon-ruler')).toHaveAttribute('data-active', 'true')
    fireEvent.click(screen.getByTestId('office-ribbon-ruler'))
    expect(onToggleHost).toHaveBeenCalledWith('ruler')
    fireEvent.click(screen.getByTestId('office-ribbon-outline'))
    expect(onToggleHost).toHaveBeenCalledWith('outline')
  })
})

describe('OfficeRibbonView：无障碍与只读', () => {
  it('tab 有 role=tab/aria-selected；只读时命令按钮禁用', () => {
    renderView({ readOnly: true })
    expect(screen.getByTestId('office-ribbon-tab-home')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('office-ribbon-bold')).toBeDisabled()
  })
})
