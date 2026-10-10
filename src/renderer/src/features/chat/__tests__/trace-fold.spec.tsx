import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TraceFold } from '@renderer/features/chat/parts/TraceFold'

/**
 * 折叠容器契约（round 6，对照《对话UI-工具链与显示口径 v0.1》§4.1）：
 *   - 高度展开/收起走容器级 data-open（CSS 侧 grid-template-rows 0fr↔1fr，见 styles/__tests__/trace.spec.ts）；
 *   - 内容"开过一次"（everOpened）后常驻 DOM —— 收起不摘内容（禁条件渲染硬切，雷点 5）；
 *   - 没开过之前不上 DOM。
 */
describe('TraceFold：开过一次后内容常驻 DOM', () => {
  it('从未打开：内容不上 DOM', () => {
    render(
      <TraceFold open={false}>
        <span data-testid="fold-content">内容</span>
      </TraceFold>
    )

    expect(screen.getByTestId('trace-fold')).toHaveAttribute('data-open', 'false')
    expect(screen.queryByTestId('fold-content')).not.toBeInTheDocument()
  })

  it('打开后关闭：内容留在 DOM，data-open 转 false（折叠过渡有对象可动）', () => {
    const { rerender } = render(
      <TraceFold open={false}>
        <span data-testid="fold-content">内容</span>
      </TraceFold>
    )

    rerender(
      <TraceFold open>
        <span data-testid="fold-content">内容</span>
      </TraceFold>
    )
    expect(screen.getByTestId('trace-fold')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('fold-content')).toBeInTheDocument()

    rerender(
      <TraceFold open={false}>
        <span data-testid="fold-content">内容</span>
      </TraceFold>
    )
    expect(screen.getByTestId('trace-fold')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('fold-content')).toBeInTheDocument()
  })

  it('初始就打开：直接挂内容；点开再收起也不摘', () => {
    render(
      <TraceFold open>
        <span data-testid="fold-content">内容</span>
      </TraceFold>
    )
    expect(screen.getByTestId('trace-fold')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('fold-content')).toBeInTheDocument()
  })

  it('折叠体的 DOM 结构 = trace-fold > trace-fold-in（CSS 挂钩子）', () => {
    const { container } = render(
      <TraceFold open>
        <span>内容</span>
      </TraceFold>
    )
    const fold = container.querySelector('.trace-fold')
    expect(fold).not.toBeNull()
    expect(fold?.querySelector('.trace-fold-in')).not.toBeNull()
  })

  it('外部样式类可以叠加（行内展开区的缩进轴 pl-7 挂在外层）', () => {
    render(
      <TraceFold open className="pl-7">
        <span>内容</span>
      </TraceFold>
    )
    expect(screen.getByTestId('trace-fold')).toHaveClass('pl-7')
  })
})
