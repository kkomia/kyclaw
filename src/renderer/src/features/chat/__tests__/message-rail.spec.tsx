import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageList } from '@renderer/features/chat/MessageList'
import { useShellStore } from '@renderer/lib/shell-store'

/**
 * 消息导览轨（round 7；round 17 重做）：
 *   - 少于 2 条用户消息不出轨；每个用户消息 = 一行 `[摘要文本 … 右端横线]`；
 *   - 收起态只显横线列（文本收成 0 宽）；hover / 聚焦展开，整块圆角底把全部横线包住；
 *   - 行内没有前导横条；当前项用文字色/字重 + 更长的横线区分；
 *   - 当前节点跟着滚动走（aria-current）；点行滚动定位（reduced-motion 时直跳）、点完即关；
 *   - 鼠标移出后延迟 300ms 关（宽限），重入撤销；键盘聚焦展开、Esc 关；
 *   - 工作台（workPanelOpen）打开时整条轨不渲染。
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
  useShellStore.setState({ workPanelOpen: false })
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

  it('贴右缘 right-2（滚动条已按 round 8 隐藏；8px 是给节点与 chat 区右缘之间的呼吸位）', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const rail = screen.getByTestId('message-rail')
    expect(rail).toHaveClass('absolute', 'right-2')
    expect(rail).not.toHaveClass('right-1')
  })

  it('round 21 定位基准：MessageList 外层不再自带 relative——轨道由 chat 页根（整幅）承接，不被钉在内容列右缘', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    // 定位父节点是 ChatFrame 的 chat-page（相对定位），本组件这一层不能带 relative
    expect(screen.getByTestId('message-list-frame')).not.toHaveClass('relative')
    expect(screen.getByTestId('message-rail')).toHaveClass('absolute', 'right-2')
  })

  it('消息列右侧走廊（round 14）：内容列 pr-14，正文不再钻到轨道下面', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    // 轨道占右缘 8px + 40px（横条列），正文停在 56px（pr-14）——任何宽度都不与正文重叠
    const column = screen.getByTestId('message-list').firstElementChild
    expect(column).toHaveClass('pr-14', 'pl-4')
    expect(column).not.toHaveClass('px-4')
  })

  it('round 17 结构：一行 = [摘要文本 … 右端横线]，行内无前导横条；横线全在面板容器内', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const panel = screen.getByTestId('rail-panel')
    // 横线（行按钮）全在容器里：圆角底包住所有横线，滚动/展开都不脱底
    for (const id of ['u1', 'u2', 'u3']) {
      expect(panel).toContainElement(screen.getByTestId(`rail-node-${id}`))
    }

    const row = screen.getByTestId('rail-node-u1')
    const children = Array.from(row.children)
    // 行首是文本（没有前导横条），横线在行右端（最后一个子元素）
    expect(children[0]).toHaveAttribute('data-testid', 'rail-item-u1')
    expect(children[children.length - 1].className).toContain('h-0.5')

    // 收起态：文本 0 宽、横线不带左间距（窄条）；展开态：文本长出、横线让出间距
    expect(screen.getByTestId('rail-item-u1')).toHaveClass('max-w-0')
    expect(children[children.length - 1]).toHaveClass('ml-0')

    fireEvent.mouseEnter(screen.getByTestId('message-rail'))
    expect(screen.getByTestId('rail-item-u1')).toHaveClass('max-w-56')
    expect(Array.from(screen.getByTestId('rail-node-u1').children)[1]).toHaveClass('ml-3')
  })

  it('工作台打开：整条轨不渲染（round 17 用户口径）；收起后恢复', () => {
    useShellStore.setState({ workPanelOpen: true })
    render(<MessageList messages={MESSAGES} status="ready" />)
    expect(screen.queryByTestId('message-rail')).not.toBeInTheDocument()

    act(() => {
      useShellStore.setState({ workPanelOpen: false })
    })
    expect(screen.getByTestId('message-rail')).toBeInTheDocument()
  })

  it('收起态只显横线列（round 17）：面板无 data-open、摘要文本收成 0 宽（不硬切）', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const panel = screen.getByTestId('rail-panel')
    expect(panel).not.toHaveAttribute('data-open')
    const text = screen.getByTestId('rail-item-u1')
    expect(text).toHaveClass('max-w-0', 'opacity-0')
  })

  it('消息区不显示滚动条（round 8 实拍）：隐条类挂在滚动容器上，列表其它行为不变', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const list = screen.getByTestId('message-list')
    expect(list).toHaveClass('[scrollbar-width:none]', '[&::-webkit-scrollbar]:hidden')
    expect(list).toHaveClass('overflow-y-auto') // 滚动能力不变
  })

  it('hover 展开摘要（文本从 0 宽长出）；摘要项 = 用户消息截断文本', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    fireEvent.mouseEnter(screen.getByTestId('message-rail'))
    const panel = screen.getByTestId('rail-panel')
    expect(panel).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('rail-item-u1')).toHaveClass('max-w-56', 'opacity-100')
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

  it('从横条移入浮窗走的是同一条宽限（round 14）：半程到达、越过程限也不关', () => {
    vi.useFakeTimers()
    try {
      render(<MessageList messages={MESSAGES} status="ready" />)
      const rail = screen.getByTestId('message-rail')
      const panel = (): HTMLElement => screen.getByTestId('rail-panel')

      fireEvent.mouseEnter(rail)
      fireEvent.mouseLeave(rail)
      act(() => {
        vi.advanceTimersByTime(150) // 半程：还没到点
      })
      expect(panel()).toHaveAttribute('data-open', 'true')

      fireEvent.mouseEnter(panel()) // 到达浮窗（重入 nav 子树）→ 撤销待关
      act(() => {
        vi.advanceTimersByTime(600) // 越过 300ms 宽限
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

  it('Esc 关（键盘路径保留）', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const rail = screen.getByTestId('message-rail')
    fireEvent.focusIn(screen.getByTestId('rail-node-u1'))
    expect(screen.getByTestId('rail-panel')).toHaveAttribute('data-open', 'true')

    fireEvent.keyDown(rail, { key: 'Escape' })
    expect(screen.getByTestId('rail-panel')).not.toHaveAttribute('data-open')
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
    // 当前项在文字上也区分（round 17：字重 + 墨色，不再靠前导横条）
    expect(screen.getByTestId('rail-item-u2')).toHaveClass('font-medium', 'text-ink')
    expect(screen.getByTestId('rail-item-u1')).toHaveClass('text-ink-secondary')
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
