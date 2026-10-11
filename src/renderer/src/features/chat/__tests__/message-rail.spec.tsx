import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageList } from '@renderer/features/chat/MessageList'

/**
 * 消息导览轨（round 7，用户实拍 #10 图2/图3；round 8 加驻留宽限）：
 *   - 少于 2 条用户消息不出轨；节点 = 用户消息；
 *   - 默认只显示短横（面板 data-open 缺省）；hover / 聚焦弹摘要列表；
 *   - 当前节点跟着滚动走（横线加长 + aria-current）；点击滚动定位（reduced-motion 时直跳）；
 *   - 鼠标移出后**延迟 300ms 关**（穿过节点列与浮窗之间的空隙来得及），重入撤销；点项立即关。
 * jsdom 没有布局：用 stub 的 getBoundingClientRect 摆"消息在容器里的位置"，测的是判定与行为。
 */

function user(id: string, text: string): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

function assistant(id: string, text: string): UIMessage {
  return { id, role: 'assistant', parts: [{ type: 'text', text }] }
}

const MESSAGES: UIMessage[] = [
  user('u1', '第一问：帮我看看这个项目文件'),
  assistant('a1', '好，先读一下。'),
  user('u2', '第二问：再把依赖列出来'),
  assistant('a2', '列完了。'),
  user('u3', '第三问：最后总结一句')
]

function rect(top: number): DOMRect {
  return {
    top,
    bottom: top + 60,
    left: 0,
    right: 400,
    width: 400,
    height: 60,
    x: 0,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

function stubRect(element: HTMLElement, top: number): void {
  element.getBoundingClientRect = () => rect(top)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('消息导览轨 · 结构', () => {
  it('少于 2 条用户消息：不出轨（单节点没有导览意义）', () => {
    render(
      <MessageList messages={[user('u1', '只问一句'), assistant('a1', '答')]} status="ready" />
    )

    expect(screen.queryByTestId('message-rail')).not.toBeInTheDocument()
  })

  it('节点 = 用户消息（助手不算）；aria-label 是压成一行的摘要', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    expect(screen.getByTestId('message-rail')).toBeInTheDocument()
    expect(screen.getByTestId('rail-node-u1')).toBeInTheDocument()
    expect(screen.getByTestId('rail-node-u2')).toBeInTheDocument()
    expect(screen.getByTestId('rail-node-u3')).toBeInTheDocument()
    expect(screen.queryByTestId('rail-node-a1')).not.toBeInTheDocument()
    expect(screen.getByTestId('rail-node-u1')).toHaveAttribute(
      'aria-label',
      '第一问：帮我看看这个项目文件'
    )
  })

  it('贴右缘 right-2（滚动条已按 round 8 隐藏；8px 是给节点与内容列之间的呼吸位）', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const rail = screen.getByTestId('message-rail')
    expect(rail).toHaveClass('absolute', 'right-2')
    expect(rail).not.toHaveClass('right-1')
  })

  it('默认收起：摘要列表在 DOM 里但没有展开标记（不硬切，走 opacity 过渡）', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const panel = screen.getByTestId('rail-panel')
    expect(panel).not.toHaveAttribute('data-open')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(panel).toHaveClass('opacity-0')
  })

  it('消息区不显示滚动条（round 8 实拍）：隐条类挂在滚动容器上，列表其它行为不变', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const list = screen.getByTestId('message-list')
    expect(list).toHaveClass('[scrollbar-width:none]', '[&::-webkit-scrollbar]:hidden')
    expect(list).toHaveClass('overflow-y-auto') // 滚动能力不变
  })

  it('hover 展开摘要列表；摘要项 = 用户消息截断文本', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    fireEvent.mouseEnter(screen.getByTestId('message-rail'))
    const panel = screen.getByTestId('rail-panel')
    expect(panel).toHaveAttribute('data-open', 'true')
    expect(panel).toHaveClass('opacity-100')
    expect(screen.getByTestId('rail-item-u2')).toHaveTextContent('第二问：再把依赖列出来')
  })

  it('鼠标移出后先撑着（宽限内），到点才关（round 8 用户实拍：以前立刻就没了）', () => {
    vi.useFakeTimers()
    try {
      render(<MessageList messages={MESSAGES} status="ready" />)
      const rail = screen.getByTestId('message-rail')
      const panel = (): HTMLElement => screen.getByTestId('rail-panel')

      fireEvent.mouseEnter(rail)
      expect(panel()).toHaveAttribute('data-open', 'true')

      fireEvent.mouseLeave(rail)
      // 还在宽限里：鼠标正穿过节点列与浮窗之间的空隙，浮窗必须还活着
      expect(panel()).toHaveAttribute('data-open', 'true')

      act(() => {
        vi.advanceTimersByTime(300)
      })
      expect(panel()).not.toHaveAttribute('data-open')
    } finally {
      vi.useRealTimers()
    }
  })

  it('宽限内够到浮窗（重入轨）→ 撤销关闭，浮窗保持展开', () => {
    vi.useFakeTimers()
    try {
      render(<MessageList messages={MESSAGES} status="ready" />)
      const rail = screen.getByTestId('message-rail')
      const panel = (): HTMLElement => screen.getByTestId('rail-panel')

      fireEvent.mouseEnter(rail)
      fireEvent.mouseLeave(rail) // 跨出空隙：待关
      // 到达浮窗：浮窗是 nav 的子节点，浏览器里这次"重新进入"会再触发 nav 的 onMouseEnter
      fireEvent.mouseEnter(screen.getByTestId('rail-panel'))

      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(panel()).toHaveAttribute('data-open', 'true')
    } finally {
      vi.useRealTimers()
    }
  })

  it('点摘要项：即使有待关的宽限也立即关（不等定时器）', () => {
    vi.useFakeTimers()
    try {
      render(<MessageList messages={MESSAGES} status="ready" />)
      const rail = screen.getByTestId('message-rail')
      const panel = (): HTMLElement => screen.getByTestId('rail-panel')

      fireEvent.mouseEnter(rail)
      fireEvent.mouseLeave(rail) // 有待关的定时器
      fireEvent.click(screen.getByTestId('rail-item-u2'))
      expect(panel()).not.toHaveAttribute('data-open')

      // 定时器被撤掉/到期也不会再动状态（保持关）
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(panel()).not.toHaveAttribute('data-open')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('消息导览轨 · 当前节点与跳转', () => {
  it('当前节点 = 滚过视口上沿的最后一条用户消息；滚动后跟着换', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const container = screen.getByTestId('message-list')
    stubRect(container, 100)
    stubRect(screen.getByTestId('message-u1'), 120) // 20 ≤ 32 → 过了
    stubRect(screen.getByTestId('message-u2'), 400) // 还没到
    stubRect(screen.getByTestId('message-u3'), 700)

    fireEvent.scroll(container)
    expect(screen.getByTestId('rail-node-u1')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('rail-node-u3')).not.toHaveAttribute('aria-current')

    stubRect(screen.getByTestId('message-u2'), 110)
    fireEvent.scroll(container)
    expect(screen.getByTestId('rail-node-u2')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('rail-item-u2')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('rail-node-u1')).not.toHaveAttribute('aria-current')
  })

  it('点节点：滚动定位（smooth + 顶对齐），面板收起、当前节点切换', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    fireEvent.mouseEnter(screen.getByTestId('message-rail'))
    const target = screen.getByTestId('message-u3')
    const scrollIntoView = vi.fn()
    target.scrollIntoView = scrollIntoView

    fireEvent.click(screen.getByTestId('rail-node-u3'))

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
    expect(screen.getByTestId('rail-node-u3')).toHaveAttribute('aria-current', 'true')
    expect(screen.getByTestId('rail-panel')).not.toHaveAttribute('data-open')
  })

  it('reduced-motion：跳转不带平滑动画（behavior: auto）', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null
      }))
    )
    render(<MessageList messages={MESSAGES} status="ready" />)

    const target = screen.getByTestId('message-u2')
    const scrollIntoView = vi.fn()
    target.scrollIntoView = scrollIntoView

    fireEvent.click(screen.getByTestId('rail-node-u2'))

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
  })
})

describe('消息导览轨 · 键盘路径', () => {
  it('Tab 进轨（节点拿到焦点）→ 面板展开；轨内换焦点不收起；Tab 出轨 → 收起', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const rail = screen.getByTestId('message-rail')
    const panel = (): HTMLElement => screen.getByTestId('rail-panel')
    expect(panel()).not.toHaveAttribute('data-open')

    // Tab 到节点 = 焦点落到轨里的按钮（React 的 onFocus 走 focusin）
    fireEvent.focusIn(screen.getByTestId('rail-node-u2'))
    expect(panel()).toHaveAttribute('data-open', 'true')

    // 轨内继续 Tab（节点 → 摘要项）：焦点没出轨，面板保持展开
    fireEvent.focusOut(screen.getByTestId('rail-node-u2'), {
      relatedTarget: screen.getByTestId('rail-item-u2')
    })
    fireEvent.focusIn(screen.getByTestId('rail-item-u2'))
    expect(panel()).toHaveAttribute('data-open', 'true')

    // Tab 出轨：焦点去了轨外的元素 → 收起
    fireEvent.focusOut(rail, { relatedTarget: document.body })
    expect(panel()).not.toHaveAttribute('data-open')
  })
})
