import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OfficeStatusBar, type OfficeStatusBarProps } from '../OfficeStatusBar'

/**
 * A4 状态栏（shell 真值）：
 *   - 左：文档名 + 类型（类型 = mono 技术标签）；
 *   - 右：页数（doc:loaded，无则「—」）、只读标记、保存态（已保存/未保存修改/保存中…/只读）。
 * 数据来源与 OfficePage 一致：tab.dirty / tab.readOnly + 保存状态机的 saving + pageCount。
 * 换词动效由共享 `office-save-swap.css` 提供（这里只断言 class/结构，不测动画时长）。
 */
function props(overrides: Partial<OfficeStatusBarProps> = {}): OfficeStatusBarProps {
  return {
    documentName: '数据仓管理系统建设技术方案.docx',
    kind: 'docx',
    pageCount: 0,
    dirty: false,
    saving: false,
    readOnly: false,
    ...overrides
  }
}

describe('OfficeStatusBar：字段与壳真值', () => {
  it('左边文档名 + 类型；页数空态为「—」；保存态默认已保存', () => {
    render(<OfficeStatusBar {...props()} />)

    const bar = screen.getByTestId('office-statusbar')
    expect(bar).toHaveAttribute('data-kind', 'docx')
    expect(bar).toHaveAttribute('data-dirty', 'false')
    expect(bar).toHaveAttribute('data-saving', 'false')
    expect(bar).toHaveAttribute('data-readonly', 'false')
    expect(bar).toHaveAttribute('aria-label', '文档状态栏')

    expect(screen.getByTestId('office-status-doc-title')).toHaveTextContent(
      '数据仓管理系统建设技术方案.docx'
    )
    expect(screen.getByTestId('office-status-doc-title')).toHaveAttribute(
      'title',
      '数据仓管理系统建设技术方案.docx'
    )
    // 类型是技术标签：mono 小写
    expect(screen.getByText('docx')).toHaveAttribute('title', 'Word 文档')

    const pages = screen.getByTestId('office-status-pages')
    expect(pages).toHaveTextContent('—')
    expect(pages).toHaveAttribute('data-pages', '0')
    expect(pages.className).toContain('font-mono')
    expect(pages.className).toContain('tabular-nums')

    const save = screen.getByTestId('office-status-save')
    expect(save).toHaveAttribute('data-state', 'saved')
    expect(save).toHaveTextContent('已保存')
    expect(save.querySelector('.office-save-swap')).not.toBeNull()
    expect(screen.queryByTestId('office-status-readonly')).not.toBeInTheDocument()
  })

  it('dirty → 未保存修改；saving（真实信号）→ 保存中…；两者都有 data-* 供探针', () => {
    const { rerender } = render(<OfficeStatusBar {...props({ dirty: true })} />)
    expect(screen.getByTestId('office-statusbar')).toHaveAttribute('data-dirty', 'true')
    expect(screen.getByTestId('office-status-save')).toHaveAttribute('data-state', 'dirty')
    expect(screen.getByTestId('office-status-save')).toHaveTextContent('未保存修改')

    rerender(<OfficeStatusBar {...props({ dirty: true, saving: true })} />)
    expect(screen.getByTestId('office-statusbar')).toHaveAttribute('data-saving', 'true')
    expect(screen.getByTestId('office-status-save')).toHaveAttribute('data-state', 'saving')
    expect(screen.getByTestId('office-status-save')).toHaveTextContent('保存中…')

    rerender(<OfficeStatusBar {...props()} />)
    expect(screen.getByTestId('office-status-save')).toHaveAttribute('data-state', 'saved')
    expect(screen.getByTestId('office-status-save')).toHaveTextContent('已保存')
  })

  it('只读：保存态显示「只读」，只读标记出现（testid 变量）且优先于 dirty', () => {
    render(<OfficeStatusBar {...props({ readOnly: true, dirty: true, saving: true })} />)

    expect(screen.getByTestId('office-statusbar')).toHaveAttribute('data-readonly', 'true')
    expect(screen.getByTestId('office-status-save')).toHaveAttribute('data-state', 'readonly')
    expect(screen.getByTestId('office-status-save')).toHaveTextContent('只读')
    expect(screen.getByTestId('office-status-readonly')).toHaveTextContent('只读')
  })

  it('页数来自 doc:loaded：共 N 页（mono + tabular-nums）', () => {
    render(<OfficeStatusBar {...props({ pageCount: 23 })} />)
    const pages = screen.getByTestId('office-status-pages')
    expect(pages).toHaveTextContent('共 23 页')
    expect(pages).toHaveAttribute('data-pages', '23')
    expect(pages.className).toContain('font-mono')
    expect(pages.className).toContain('tabular-nums')
  })

  it('非 docx 类型也显示类型短名（A5 多格式复用）', () => {
    render(<OfficeStatusBar {...props({ kind: 'xlsx', documentName: '预算.xlsx' })} />)
    expect(screen.getByTestId('office-statusbar')).toHaveAttribute('data-kind', 'xlsx')
    expect(screen.getByText('xlsx')).toHaveAttribute('title', 'Excel 表格')
  })
})
