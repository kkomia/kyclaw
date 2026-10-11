import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CodePreview } from '../CodePreview'
import { PptxPreview } from '../PptxPreview'
import { TablePreview } from '../TablePreview'

/**
 * round43 的三个新预览组件（办公 + 代码场景）：
 *   - TablePreview：多表切换、数字右对齐、截断标注；
 *   - PptxPreview：逐页文字卡、标题只认占位符、截断标注；
 *   - CodePreview：复用聊天区那套高亮（shiki），语言没打包就退回纯文本（在 modes 那侧挡住）。
 */
describe('TablePreview：xlsx / csv 的表', () => {
  const sheet = (
    name: string,
    rows: string[][],
    truncated = false
  ): Parameters<typeof TablePreview>[0]['sheets'][number] => ({
    name,
    rows,
    truncated
  })

  it('单表直接画（csv）：单元格原样，数字右对齐、文本不右对齐', () => {
    render(
      <TablePreview
        sheets={[
          sheet('名单', [
            ['姓名', '年龄'],
            ['张三', '28'],
            ['千分位', '1,200'],
            ['编号', '007']
          ])
        ]}
      />
    )

    const body = screen.getByTestId('file-preview-table')
    // 单表不摆切换控件
    expect(within(body).queryAllByTestId('table-sheet-tab')).toHaveLength(0)

    const cells = within(body).getAllByRole('cell')
    expect(cells).toHaveLength(8)
    expect(cells[0]).toHaveTextContent('姓名')
    expect(cells[3]).toHaveTextContent('28')
    expect(cells[3]).toHaveAttribute('data-numeric', 'true')
    expect(cells[3]).toHaveClass('text-right')
    expect(cells[0]).toHaveAttribute('data-numeric', 'false')
    expect(cells[0]).not.toHaveClass('text-right')
    // 千分位也算数字（排版只是右对齐，数据原样）
    expect(cells[5]).toHaveAttribute('data-numeric', 'true')
  })

  it('多表（xlsx）给切换控件：点第二张换内容，选中项标 aria-selected', () => {
    render(
      <TablePreview
        sheets={[
          sheet('汇总', [
            ['项目', '金额'],
            ['房租', '1200']
          ]),
          sheet('明细', [['备注'], ['第二张表的内容']])
        ]}
      />
    )

    const tabs = screen.getAllByTestId('table-sheet-tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['汇总', '明细'])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('file-preview-table')).toHaveTextContent('房租')

    fireEvent.click(tabs[1])
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(tabs[0]).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('file-preview-table')).toHaveTextContent('第二张表的内容')
    expect(screen.getByTestId('file-preview-table')).not.toHaveTextContent('房租')
  })

  it('截断：表自己的截断说"只显示了前面一部分"，空表给人话', () => {
    const { unmount } = render(<TablePreview sheets={[sheet('大表', [['x']], true)]} />)
    expect(screen.getByTestId('file-preview-table-truncated')).toHaveTextContent(
      '只显示了前面一部分'
    )
    unmount()

    render(<TablePreview sheets={[sheet('空表', [])]} />)
    expect(screen.getByTestId('file-preview-table-empty')).toHaveTextContent('这张表没有内容')
    expect(screen.queryByTestId('file-preview-table-truncated')).toBeNull()
  })

  it('isNumericCell 的口径：数字/小数/百分号/带符号右对齐，文本与空串不右对齐', () => {
    const numeric = ['0', '28', '1200', '1,200', '340.5', '-12', '+3', '88%', ' 42 ', '007']
    const text = ['', '  ', '张三', '12a', '1.2.3', '1,20', 'a,b', '2026-10-12']

    render(<TablePreview sheets={[sheet('形状', [numeric, text])]} />)

    const flags = within(screen.getByTestId('file-preview-table'))
      .getAllByRole('cell')
      .map((cell) => cell.getAttribute('data-numeric'))
    expect(flags.slice(0, numeric.length)).toEqual(numeric.map(() => 'true'))
    expect(flags.slice(numeric.length)).toEqual(text.map(() => 'false'))
  })
})

describe('PptxPreview：逐页文字卡', () => {
  it('每页一张卡（页码 + 标题 + 行），并如实说"仅文字提要"', () => {
    render(
      <PptxPreview
        slides={[
          { index: 1, lines: ['汇报'] },
          { index: 2, title: '进展', lines: ['第一条', '第二条'] }
        ]}
        truncated={false}
      />
    )

    const cards = screen.getAllByTestId('pptx-slide')
    expect(cards.map((card) => card.getAttribute('data-index'))).toEqual(['1', '2'])
    expect(cards[0]).toHaveTextContent('第 1 页')
    expect(within(cards[0]).queryByTestId('pptx-slide-title')).toBeNull()
    expect(cards[1]).toHaveTextContent('第 2 页')
    // 标题只认得出才画（占位符那条路）
    expect(within(cards[1]).getByTestId('pptx-slide-title')).toHaveTextContent('进展')
    expect(within(cards[1]).getByText('第一条')).toBeInTheDocument()
    expect(screen.getByTestId('file-preview-pptx-notice')).toHaveTextContent(
      '仅文字提要，版式不还原'
    )
    expect(screen.queryByTestId('file-preview-pptx-truncated')).toBeNull()
  })

  it('页数超上限：如实标注；一页都没有时给人话', () => {
    const { unmount } = render(
      <PptxPreview slides={[{ index: 1, lines: ['甲'] }]} truncated={true} />
    )
    expect(screen.getByTestId('file-preview-pptx-truncated')).toHaveTextContent(
      '只显示了前面一部分'
    )
    unmount()

    render(<PptxPreview slides={[]} truncated={false} />)
    expect(screen.getByTestId('file-preview-pptx-empty')).toHaveTextContent('没有文字')
  })

  it('标题与正文都没有的那一页单独说一句（不留白卡）', () => {
    render(<PptxPreview slides={[{ index: 3, lines: [] }]} truncated={false} />)
    expect(screen.getByTestId('pptx-slide')).toHaveTextContent('这一页没有文字')
  })
})

describe('CodePreview：复用聊天区那套高亮', () => {
  it('认得的语言真高亮（shiki 的 pre + --shiki-token-* 内联色）', async () => {
    render(<CodePreview text={'const answer: number = 42\n'} language="typescript" />)

    const block = await screen.findByTestId('code-block')
    expect(block).toHaveAttribute('data-language', 'typescript')
    await waitFor(() => expect(block).toHaveAttribute('data-highlighted', 'true'))

    const pre = block.querySelector('pre')
    expect(pre?.className).toContain('shiki')
    expect(pre?.innerHTML).toContain('var(--shiki-token-keyword)')
    expect(pre?.textContent).toContain('const answer: number = 42')
    expect(
      within(screen.getByTestId('file-preview-code')).getByTestId('code-copy')
    ).toBeInTheDocument()
  })

  it('空白原样保留（预览是只读的，不重排、不吃缩进）', async () => {
    const code = 'function f() {\n    return 1\n}\n'
    render(<CodePreview text={code} language="javascript" />)

    const block = await screen.findByTestId('code-block')
    expect(block.textContent).toContain('    return 1')
  })
})
