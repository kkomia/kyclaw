import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageList } from '@renderer/features/chat/MessageList'
import { useShellStore } from '@renderer/lib/shell-store'
import {
  railPanelHeight,
  railRowHeight,
  RAIL_FULL_ROWS,
  RAIL_MIN_ROWS,
  RAIL_ROW_HEIGHT_FULL,
  RAIL_ROW_HEIGHT_MIN
} from '@renderer/features/chat/message-rail-model'

/**
 * 消息导览轨（round 7；round 17 重做；round 87 行高按条数压缩）：
 *   - 少于 2 条用户消息不出轨；每个用户消息 = 一行 `[摘要文本 … 右端横线]`；
 *   - 收起态只显横线列（文本收成 0 宽）；hover / 聚焦展开，整块圆角底把全部横线包住；
 *   - 行内没有前导横条；当前项用文字色/字重 + 更长的横线区分；
 *   - 行高不再写死 28px：条数多了按 `railRowHeight` 压缩（最小 10px），压缩态 hover/聚焦
 *     把那一行展开回满行高 —— 一条一轮、可点数、点哪条跳哪轮三件事都不变；
 *   - 当前节点跟着滚动走（aria-current）；点行滚动定位（reduced-motion 时直跳）、点完即关；
 *   - 鼠标移出后延迟 300ms 关（宽限），重入撤销；键盘聚焦展开、Esc 关；
 *   - 工作台（workPanelOpen）打开时整条轨不渲染。
 * jsdom 没有布局：用 stub 的 getBoundingClientRect 摆"消息在容器里的位置"，测的是判定与行为；
 * 行高是算出来的常量，所以几何直接断言函数值与喂给 CSS 变量的值。
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

  it('消息列右侧走廊（round 14 原意保留）：宽窗内容列居中不占走廊；窄窗（<1080）由 chat-content 给回 56px', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    // task-114 宽度公式后：内容列 max = 内容宽 + 32、左右各 16 对称居中（宽窗离导轨很远）；
    // 窄窗由 chat-width.css 的 @media (max-width:1080px) .chat-content { padding-right:56px }
    // 让出右侧走廊（轨占右缘 8 + ~43），正文不会钻到轨道下面。
    const column = screen.getByTestId('message-list').firstElementChild
    expect(column).toHaveClass('chat-content', 'mx-auto', 'px-4')
    expect(column).toHaveClass('max-w-[calc(var(--chat-content-width)+32px)]')
    expect(screen.getByTestId('message-rail')).toHaveClass('absolute', 'right-2')
  })

  it('round 17 结构 + round 22 对齐：一行 = [文本容器(flex-1，左对齐) … 右端横线]；横线全在面板容器内', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const panel = screen.getByTestId('rail-panel')
    // 横线（行按钮）全在容器里：圆角底包住所有横线，滚动/展开都不脱底
    for (const id of ['u1', 'u2', 'u3']) {
      expect(panel).toContainElement(screen.getByTestId(`rail-node-${id}`))
    }

    const row = screen.getByTestId('rail-node-u1')
    const children = Array.from(row.children)
    // 行内顺序 = [文本容器, 横线]：没有前导横条；文本容器 flex-1 撑满 → 横线固定贴行右端
    expect(children).toHaveLength(2)
    expect(children[0]).toHaveClass('flex-1', 'min-w-0', 'justify-start')
    expect(children[0]).toContainElement(screen.getByTestId('rail-item-u1'))
    expect(children[children.length - 1]).toHaveAttribute('data-testid', 'rail-line-u1')

    // round 22（用户口径"文字做左对齐，不要右对齐"）：行不再 justify-end；文本左对齐、右侧截断省略号
    expect(row).not.toHaveClass('justify-end')
    expect(screen.getByTestId('rail-item-u1')).toHaveClass('text-left', 'truncate')

    // 收起态：文本 0 宽；横线位置固定（不靠 ml 让位）
    expect(screen.getByTestId('rail-item-u1')).toHaveClass('max-w-0')
    expect(screen.getByTestId('rail-line-u1').className).not.toMatch(/\bml-/)

    fireEvent.mouseEnter(screen.getByTestId('message-rail'))
    expect(screen.getByTestId('rail-item-u1')).toHaveClass('max-w-56')
  })

  it('round 87：行高不再写死 h-7 —— 高度走面板上的 CSS 变量（布局数学只有一处来源）', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const row = screen.getByTestId('rail-node-u1')
    expect(row).not.toHaveClass('h-7')
    expect(row).toHaveClass('h-(--rail-row)', 'hover:h-(--rail-row-open)')

    // 3 条 = 未压缩档：常态与展开态同值（28px），hover 不改变高度
    const panel = screen.getByTestId('rail-panel')
    expect(panel.style.getPropertyValue('--rail-row')).toBe('28px')
    expect(panel.style.getPropertyValue('--rail-row-open')).toBe('28px')
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

describe('消息导览轨 · 行高随条数压缩（round 87 / 用户反馈 018）', () => {
  /** 长会话：N 条用户消息 + 每条后面跟一条助手消息 */
  function longMessages(count: number): UIMessage[] {
    return Array.from({ length: count }, (_, index) => [
      user(`u${index + 1}`, `第 ${index + 1} 问`),
      assistant(`a${index + 1}`, '答')
    ]).flat()
  }

  it('几何只住在 railRowHeight 一处：阈值与最小行高钉住', () => {
    // 未压缩档（≤18 条）＝满行高 28px：与 round 87 之前一模一样
    expect(railRowHeight(2)).toBe(RAIL_ROW_HEIGHT_FULL)
    expect(railRowHeight(RAIL_FULL_ROWS)).toBe(RAIL_ROW_HEIGHT_FULL)
    expect(railRowHeight(RAIL_FULL_ROWS)).toBe(28)

    // 压缩档（>18 条）单调不增，到 60 条落到最小 10px
    expect(railRowHeight(30)).toBeLessThan(RAIL_ROW_HEIGHT_FULL)
    expect(railRowHeight(RAIL_MIN_ROWS)).toBe(RAIL_ROW_HEIGHT_MIN)
    expect(railRowHeight(RAIL_MIN_ROWS)).toBe(10)
    expect(railRowHeight(120)).toBe(RAIL_ROW_HEIGHT_MIN)
    expect(railRowHeight(1000)).toBe(RAIL_ROW_HEIGHT_MIN)
    for (let count = 1; count <= 200; count++) {
      expect(railRowHeight(count)).toBeLessThanOrEqual(railRowHeight(count - 1))
      // 触达下限：任何条数下每个可点行都不小于 8px（"点哪条跳哪轮"不许被压没）
      expect(railRowHeight(count)).toBeGreaterThanOrEqual(8)
    }
  })

  it('整条轨的总高不再随轮次线性长：~22 轮不再是天花板', () => {
    /** 900px 视口的面板上限（70vh）——round 87 之前 ~22 轮就撞上它 */
    const CEILING = 630
    // 22 轮（以前刚好顶到天花板）现在仍塞得进，不用滚动
    expect(railPanelHeight(22)).toBeLessThanOrEqual(CEILING)
    // 40 轮比线性时代（40×28+8）矮掉三成以上
    expect(railPanelHeight(40)).toBeLessThan(40 * RAIL_ROW_HEIGHT_FULL * 0.7)
    // 60 轮仍塞得进天花板（到这一档为止完全不用滚动）
    expect(railPanelHeight(RAIL_MIN_ROWS)).toBeLessThanOrEqual(CEILING)
    // 100 轮：降到线性时代（2808px）的 4 成以下
    expect(railPanelHeight(100)).toBeLessThan(100 * RAIL_ROW_HEIGHT_FULL * 0.4)
  })

  it('压缩态：行高喂给 CSS 变量、展开态保留满行高；一条一轮、可点数不变', () => {
    render(<MessageList messages={longMessages(40)} status="ready" />)

    const panel = screen.getByTestId('rail-panel')
    const compressed = railRowHeight(40)
    expect(compressed).toBeLessThan(RAIL_ROW_HEIGHT_FULL)
    expect(panel.style.getPropertyValue('--rail-row')).toBe(`${compressed}px`)
    // hover / 聚焦把那一行展开回满行高（读清摘要），常态仍是压缩后的高度
    expect(panel.style.getPropertyValue('--rail-row-open')).toBe(`${RAIL_ROW_HEIGHT_FULL}px`)

    // 一条一轮：40 条用户消息 = 40 个可点节点；点哪条跳哪轮的能力没被压缩掉
    const nodes = screen.getAllByTestId(/^rail-node-u\d+$/)
    expect(nodes).toHaveLength(40)
    for (const node of nodes) {
      expect(node.tagName).toBe('BUTTON')
      expect(node).toHaveClass('h-(--rail-row)')
    }
  })
})

describe('消息导览轨 · 长会话：高度有界 + 每一轮都到得了（round 87 / 用户反馈 018）', () => {
  /** 长会话：N 条用户消息 + 每条后面跟一条助手消息 */
  function longMessages(count: number): UIMessage[] {
    return Array.from({ length: count }, (_, index) => [
      user(`u${index + 1}`, `第 ${index + 1} 问：这一轮在聊什么`),
      assistant(`a${index + 1}`, '答')
    ]).flat()
  }

  it(
    '300 轮：一轮不丢（300 个可点节点），行高压到下限、盒子高度仍封在 70vh',
    { timeout: 40_000 },
    () => {
      render(<MessageList messages={longMessages(300)} status="ready" />)

      // 一轮一个节点：压缩显示不丢轮次（这是用户明说的"必须保留的能力"）
      const nodes = screen.getAllByTestId(/^rail-node-u\d+$/)
      expect(nodes).toHaveLength(300)
      expect(nodes[299]).toHaveAttribute('data-rail-node', 'u300')

      // 行高到 60 轮就压到下限，再长也不变（不是 8px×N 的线性下降）
      expect(railRowHeight(300)).toBe(RAIL_ROW_HEIGHT_MIN)
      const panel = screen.getByTestId('rail-panel')
      expect(panel.style.getPropertyValue('--rail-row')).toBe(`${RAIL_ROW_HEIGHT_MIN}px`)
      // 每一行仍是一个按钮、仍是那一档行高（可点数不变）
      expect(nodes[0]).toHaveClass('h-(--rail-row)')

      // 盒子有界：整条轨的**可视高度**由 max-h-70vh 封住，内容超了在里面滚（外面的版面不涨）
      const rail = screen.getByTestId('message-rail')
      expect(rail).toHaveClass('max-h-[70vh]', 'overflow-y-auto')
    }
  )

  it('↑/↓（Home/End）在轨内走位：焦点落到哪一行就滚进视野（几百轮不用 Tab 到尾）', () => {
    render(<MessageList messages={longMessages(300)} status="ready" />)
    const rail = screen.getByTestId('message-rail')
    const first = screen.getByTestId('rail-node-u1')
    const second = screen.getByTestId('rail-node-u2')
    const last = screen.getByTestId('rail-node-u300')
    const scrolled: HTMLElement[] = []
    for (const node of [first, second, last]) {
      node.scrollIntoView = (): void => {
        scrolled.push(node)
      }
    }

    first.focus()
    fireEvent.keyDown(rail, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(second)
    expect(scrolled).toEqual([second])

    fireEvent.keyDown(rail, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(first)

    // End 一步到末轮、Home 一步回首轮（不丢轮次、也不许越界）
    fireEvent.keyDown(rail, { key: 'End' })
    expect(document.activeElement).toBe(last)
    expect(scrolled).toContain(last)
    fireEvent.keyDown(rail, { key: 'Home' })
    expect(document.activeElement).toBe(first)
  })

  it('走位不会越界：首行按 ↑ 仍在首行、末行按 ↓ 仍在末行', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)
    const rail = screen.getByTestId('message-rail')
    const first = screen.getByTestId('rail-node-u1')
    const last = screen.getByTestId('rail-node-u3')

    first.focus()
    fireEvent.keyDown(rail, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(first)

    last.focus()
    fireEvent.keyDown(rail, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(last)
  })

  it('当前节点滚进轨内视野：对话往下滚，轨里那一段自己跟过来（block: nearest）', () => {
    render(<MessageList messages={longMessages(40)} status="ready" />)

    const container = screen.getByTestId('message-list')
    const node = screen.getByTestId('rail-node-u30')
    const railNodeScroll = vi.fn()
    node.scrollIntoView = railNodeScroll

    // 第 30 轮的用户消息顶边滚过容器上沿 → 它成为当前节点
    for (let index = 1; index <= 40; index++) {
      const element = container.querySelector<HTMLElement>(`[data-testid="message-u${index}"]`)
      if (element !== null) stubRect(element, index <= 30 ? -10 : 400)
    }
    act(() => container.dispatchEvent(new Event('scroll')))

    expect(node).toHaveAttribute('aria-current', 'true')
    expect(railNodeScroll).toHaveBeenCalledWith({ block: 'nearest' })
  })

  it('行上带轮次号（展开态看得见"第几轮"），title 也点明轮次', () => {
    render(<MessageList messages={MESSAGES} status="ready" />)

    const node = screen.getByTestId('rail-node-u2')
    expect(node).toHaveAttribute('title', '第 2 轮 · 第二问：再把依赖列出来')
    expect(screen.getByTestId('rail-item-u2')).toHaveTextContent('2.')
    expect(screen.getByTestId('rail-item-u2')).toHaveTextContent('第二问：再把依赖列出来')
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
