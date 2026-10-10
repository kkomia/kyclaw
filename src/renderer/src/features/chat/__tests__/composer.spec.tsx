import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Composer } from '@renderer/features/chat/Composer'

/**
 * 输入卡（UI 返工 R1）：UI 参考 §4.6 的实测数值（宽 768 / 圆角 24 / 发送钮 36）+
 * 实况页结构（单行输入 + 一行工具条，输入区自适应、封顶后内部滚动），以及键盘/按钮行为。
 * 组件只把 onSend / onStop 抛给上层——队列与截断重发在 ChatPage（chat-flow.spec）。
 */
function setup(props: Partial<Parameters<typeof Composer>[0]> = {}): {
  onSend: ReturnType<typeof vi.fn>
  onStop: ReturnType<typeof vi.fn>
} {
  const onSend = vi.fn()
  const onStop = vi.fn()
  render(<Composer onSend={onSend} onStop={onStop} {...props} />)
  return { onSend, onStop }
}

function type(text: string): void {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
}

describe('输入卡结构与尺寸（UI 参考 §4.6 + 实况页 a84af355）', () => {
  it('max 768 / 圆角 24 / 输入区自适应（48–170）/ 工具条 48 / 发送钮 36', () => {
    setup()

    expect(screen.getByTestId('composer')).toHaveClass(
      'max-w-(--chat-input-max-width)',
      'rounded-input'
    )
    expect(screen.getByTestId('composer-input')).toHaveClass(
      'field-sizing-content',
      'min-h-(--composer-input-min-height)',
      'max-h-(--composer-input-max-height)',
      'overflow-y-auto'
    )
    expect(screen.getByTestId('composer-footer')).toHaveClass('h-(--composer-toolbar-height)')
    expect(screen.getByTestId('composer-send')).toHaveClass('size-9')
  })

  it('焦点指示由卡片给（跟圆角），输入框自己不再画方框（雷点 6）', () => {
    setup()

    // 输入框本身没有圆角：它自己画的 inset 环会压在卡片圆角上（深色下就是那个白色直角框）
    expect(screen.getByTestId('composer')).toHaveClass('focus-ring-container')
    expect(screen.getByTestId('composer-input')).toHaveClass('focus-visible:shadow-none')
  })

  it('默认单行紧凑：没有横幅带、也没有键盘提示小字（雷点 2：不靠小字补设计）', () => {
    setup()

    expect(screen.queryByTestId('composer-banner')).not.toBeInTheDocument()
    expect(screen.getByTestId('composer')).not.toHaveTextContent('Enter')
    expect(screen.getByTestId('composer-input')).toHaveAttribute('rows', '1')
  })

  it('空输入时发送钮禁用，有内容才可点', () => {
    const { onSend } = setup()

    const send = screen.getByTestId('composer-send')
    expect(send).toBeDisabled()
    fireEvent.click(send)
    expect(onSend).not.toHaveBeenCalled()

    type('有内容了')
    expect(send).toBeEnabled()
  })
})

describe('输入卡键盘行为', () => {
  it('Enter 发送并清空输入（首尾空白去掉）', () => {
    const { onSend } = setup()
    type('  你好  ')

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('你好')
    expect(screen.getByTestId('composer-input')).toHaveValue('')
  })

  it('Shift+Enter 只换行，不发送', () => {
    const { onSend } = setup()
    type('第一行')

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', shiftKey: true })

    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveValue('第一行')
  })

  it('输入法合成中的回车不算发送（中文选词不误发）', () => {
    const { onSend } = setup()
    type('你好')

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter', isComposing: true })

    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-input')).toHaveValue('你好')
  })

  it('纯空白不发送', () => {
    const { onSend } = setup()
    type('   ')

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onSend).not.toHaveBeenCalled()
  })
})

describe('输入卡流式态', () => {
  it('流式中：发送钮变停止钮，点击走 onStop', () => {
    const { onStop, onSend } = setup({ busy: true })

    expect(screen.queryByTestId('composer-send')).not.toBeInTheDocument()
    const stop = screen.getByTestId('composer-stop')
    expect(stop).toHaveClass('size-9')

    fireEvent.click(stop)
    expect(onStop).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('流式中敲字回车：照样交给上层（由上层排队），输入框清空', () => {
    const { onSend } = setup({ busy: true })
    type('接着问一句')

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    expect(onSend).toHaveBeenCalledWith('接着问一句')
    expect(screen.getByTestId('composer-input')).toHaveValue('')
  })

  it('排队条数为 0 时不显示排队提示，有排队时显示条数', () => {
    const { unmount } = render(<Composer onSend={vi.fn()} onStop={vi.fn()} />)
    expect(screen.queryByTestId('composer-queue')).not.toBeInTheDocument()
    unmount()

    render(<Composer busy queuedCount={2} onSend={vi.fn()} onStop={vi.fn()} />)
    expect(screen.getByTestId('composer-queue')).toHaveTextContent('已排队 2 条')
  })
})
