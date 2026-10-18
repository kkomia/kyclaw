import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { Message } from '@renderer/features/chat/Message'
import { TurnProcess, type TurnProcessEntry } from '../parts/TurnProcess'
import { formatTurnDuration, TURN_PROCESS_MAX_ROWS } from '../parts/turn-process-metrics'

/**
 * 工具过程统一大容器（task-52：用户原话「工具调用过程 现在通过统一大的内容约束到里面滚动输出…
 * 大滚动固定长度」）：
 *   - 一轮里连续的思考 + 工具调用收进**一个容器**（头部摘要「执行 N 次思考，调用 M 次工具」+ 状态）；
 *   - 正文 = 固定上限高度的内部滚动区（`--turn-process-max-height`，默认 360px），容器总高不随输出增长；
 *   - 流式新行自动跟到底、用户上滚后不抢（给「回到底部」）；
 *   - 进行中默认展开、跑完自动收起、用户手动开合优先；
 *   - 超过 200 行只渲染最近 200 行 + 一行「更早的已折叠」；
 *   - 错误 / 审批 / AskUser 卡片不进容器（它们是必须看见的交互件，在原位）。
 */
const TURN_PROCESS_CSS = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/features/chat/turn-process.css'),
  'utf8'
)

function assistantMessage(parts: unknown[], id = 'a1'): UIMessage {
  return { id, role: 'assistant', parts } as unknown as UIMessage
}

function toolEntry(index: number, state = 'output-available'): TurnProcessEntry {
  return {
    index,
    streaming: false,
    settled: false,
    part: {
      type: 'tool-read',
      toolCallId: `c${String(index)}`,
      state,
      input: { path: `f${String(index)}.txt` },
      output: '内容'
    } as unknown as UIMessage['parts'][number]
  }
}

/** jsdom 没有布局：给元素挂上假的滚动几何（scrollTop 可写，测跟随逻辑够用） */
function fakeScrollGeometry(
  element: HTMLElement,
  geometry: { scrollHeight: number; clientHeight: number }
): void {
  Object.defineProperty(element, 'scrollHeight', {
    value: geometry.scrollHeight,
    configurable: true
  })
  Object.defineProperty(element, 'clientHeight', {
    value: geometry.clientHeight,
    configurable: true
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('结构与分组：思考 + 工具收进一个容器', () => {
  it('Message 里 reasoning + tool 是同一个 turn-process；头部摘要与状态正确', () => {
    render(
      <Message
        message={assistantMessage([
          { type: 'reasoning', text: '查一下文件。' },
          {
            type: 'tool-read',
            toolCallId: 'c1',
            state: 'output-available',
            input: { path: 'a.txt' },
            output: '内容'
          }
        ])}
        streaming
      />
    )

    const container = screen.getByTestId('turn-process')
    expect(screen.getAllByTestId('turn-process')).toHaveLength(1)
    expect(within(container).getByTestId('turn-process-summary')).toHaveTextContent(
      '执行 1 次思考，调用 1 次工具'
    )
    expect(within(container).getByTestId('turn-process-status')).toHaveTextContent('进行中')
    // 兼容旧契约：trace-block / trace-toggle 仍在（data-open 语义不变）
    expect(within(container).getByTestId('trace-block')).toHaveAttribute('data-open', 'true')
    // 思考段与工具行都在这一个容器里
    expect(within(container).getByTestId('reasoning-part')).toBeInTheDocument()
    expect(within(container).getByTestId('tool-card')).toBeInTheDocument()
    // 正文滚动区
    expect(within(container).getByTestId('turn-process-body')).toHaveClass('turn-process-body')
  })

  it('多轮/多条消息不串：每条消息各一个容器，各自计数', () => {
    render(
      <>
        <Message
          message={assistantMessage([toolEntry(0).part as unknown], 'a1')}
          streaming={false}
        />
        <Message
          message={assistantMessage(
            [
              toolEntry(0).part as unknown,
              toolEntry(1).part as unknown,
              toolEntry(2).part as unknown
            ],
            'a2'
          )}
          streaming={false}
        />
      </>
    )

    const containers = screen.getAllByTestId('turn-process')
    expect(containers).toHaveLength(2)
    expect(within(containers[0]).getByTestId('turn-process-summary')).toHaveTextContent(
      '调用 1 次工具'
    )
    expect(within(containers[1]).getByTestId('turn-process-summary')).toHaveTextContent(
      '调用 3 次工具'
    )
  })

  it('错误 / 审批 / AskUser 卡片不进容器（容器里只有思考行与工具行）', () => {
    render(
      <Message
        message={assistantMessage([
          {
            type: 'tool-ask_user',
            toolCallId: 'c9',
            state: 'input-available',
            input: { question: '选哪个？' }
          }
        ])}
        streaming
      />
    )

    const container = screen.getByTestId('turn-process')
    expect(within(container).getByTestId('tool-card')).toBeInTheDocument()
    // 必须看见的交互件（审批/AskUser/错误卡）不在容器里 —— 它们由 Dock/错误区独立渲染
    expect(within(container).queryByTestId('ask-user-card')).toBeNull()
    expect(within(container).queryByTestId('approval-card')).toBeNull()
    expect(within(container).queryByTestId('error-card')).toBeNull()
  })
})

describe('固定长度：高度常量与内部滚动（CSS 契约）', () => {
  it('--turn-process-max-height = min(400px,50vh)（DSH 源码口径），正文 max-height + overflow-y:auto + 不传染外层滚动', () => {
    expect(TURN_PROCESS_CSS).toContain('--turn-process-max-height: min(400px, 50vh)')
    const bodyBlock = /\.turn-process-body \{([\s\S]*?)\}/.exec(TURN_PROCESS_CSS)?.[1] ?? ''
    expect(bodyBlock).toContain('max-height: var(--turn-process-max-height, min(400px, 50vh))')
    expect(bodyBlock).toContain('overflow-y: auto')
    expect(bodyBlock).toContain('overscroll-behavior: contain')
    // 常量不写死在组件里：组件里不出现裸 360 的 max-height
    expect(TURN_PROCESS_CSS).not.toMatch(/\b[0-9]+ms\b/)
    expect(TURN_PROCESS_CSS).toContain('@media (prefers-reduced-motion: reduce)')
  })
})

describe('流式滚动策略：自动跟随 + 用户上滚不抢', () => {
  it('停在底部：新增行自动跟到底（scrollTop = scrollHeight）', () => {
    const entries = [toolEntry(0), toolEntry(1)]
    const { rerender } = render(<TurnProcess entries={entries} running />)
    const body = screen.getByTestId('turn-process-body')
    fakeScrollGeometry(body, { scrollHeight: 1000, clientHeight: 360 })
    body.scrollTop = 0

    rerender(<TurnProcess entries={[...entries, toolEntry(2)]} running />)
    expect(body.scrollTop).toBe(1000)
  })

  it('用户上滚后不抢滚动，出现「回到底部」；点一下回到最新', () => {
    const entries = [toolEntry(0), toolEntry(1), toolEntry(2)]
    const { rerender } = render(<TurnProcess entries={entries} running />)
    const body = screen.getByTestId('turn-process-body')
    fakeScrollGeometry(body, { scrollHeight: 1000, clientHeight: 360 })

    body.scrollTop = 100
    fireEvent.scroll(body)
    const backButton = screen.getByTestId('turn-process-back-to-bottom')
    expect(backButton).toHaveTextContent('回到底部')

    rerender(<TurnProcess entries={[...entries, toolEntry(3)]} running />)
    expect(body.scrollTop).toBe(100) // 上滚位置没被新行抢走

    fireEvent.click(backButton)
    expect(body.scrollTop).toBe(1000)
    expect(screen.queryByTestId('turn-process-back-to-bottom')).not.toBeInTheDocument()
  })
})

describe('开合策略：进行中展开 / 完成收起 / 手动优先', () => {
  it('进行中默认展开；跑完自动收起；手动开过则保持开', () => {
    const entries = [toolEntry(0)]
    const { rerender } = render(<TurnProcess entries={entries} running />)
    const block = screen.getByTestId('trace-block')
    expect(block).toHaveAttribute('data-open', 'true')

    rerender(<TurnProcess entries={entries} running={false} />)
    expect(block).toHaveAttribute('data-open', 'false')

    fireEvent.click(screen.getByTestId('trace-toggle')) // 手动开
    expect(block).toHaveAttribute('data-open', 'true')
    rerender(<TurnProcess entries={[...entries, toolEntry(1)]} running={false} />)
    expect(block).toHaveAttribute('data-open', 'true')
  })

  it('跑完时用户手动收起过：保持收起（override 优先于自动档）', () => {
    const entries = [toolEntry(0)]
    const { rerender } = render(<TurnProcess entries={entries} running />)
    fireEvent.click(screen.getByTestId('trace-toggle')) // 手动收
    rerender(<TurnProcess entries={entries} running={false} />)
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'false')
  })

  it('有待审批的调用：默认展开（让用户看得见卡在哪一步）', () => {
    const pendingEntry: TurnProcessEntry = {
      index: 0,
      streaming: false,
      settled: false,
      part: {
        type: 'tool-write',
        toolCallId: 'c0',
        state: 'approval-requested',
        input: { path: 'a.txt', content: '内容' },
        approval: { id: 'run-1::c0' }
      } as unknown as UIMessage['parts'][number]
    }
    render(<TurnProcess entries={[pendingEntry]} running={false} />)
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-pending', 'true')
  })
})

describe('用时：进行中计时、完成冻结（X 分 Y 秒）', () => {
  it('61 秒后完成：显示「用时 1 分 1 秒」', () => {
    vi.useFakeTimers()
    const entries = [toolEntry(0)]
    const { rerender } = render(<TurnProcess entries={entries} running />)
    act(() => {
      vi.advanceTimersByTime(61_000)
    })
    rerender(<TurnProcess entries={entries} running={false} />)
    expect(screen.getByTestId('turn-process-status')).toHaveTextContent('用时 1 分 1 秒')
  })

  it('历史消息（挂载即已完成、没走进行中）：无用时 → 不渲染 meta', () => {
    render(<TurnProcess entries={[toolEntry(0)]} running={false} />)
    // task-115：正常完成不再写「已完成」；没有用时就不占位
    expect(screen.queryByTestId('turn-process-status')).not.toBeInTheDocument()
  })

  it('formatTurnDuration 口径：<60 秒只给秒，≥60 秒给分', () => {
    expect(formatTurnDuration(0)).toBe('0 秒')
    expect(formatTurnDuration(5_400)).toBe('5 秒')
    expect(formatTurnDuration(60_000)).toBe('1 分 0 秒')
    expect(formatTurnDuration(125_000)).toBe('2 分 5 秒')
  })
})

describe('性能上限：超过 200 行只渲染最近 200 行', () => {
  it('210 行 → 渲染 200 个工具行 +「更早的 10 行已折叠」', () => {
    const entries = Array.from({ length: TURN_PROCESS_MAX_ROWS + 10 }, (_, index) =>
      toolEntry(index)
    )
    render(<TurnProcess entries={entries} running />)

    expect(screen.getAllByTestId('tool-card')).toHaveLength(TURN_PROCESS_MAX_ROWS)
    expect(screen.getByTestId('turn-process-more')).toHaveTextContent('更早的 10 行已折叠')
    expect(screen.getByTestId('turn-process-more')).toHaveTextContent(
      `只保留最近 ${String(TURN_PROCESS_MAX_ROWS)} 行`
    )
  })
})

describe('task-82 · 汇总行固定顶部 + hairline 分隔', () => {
  it('顺序：汇总行 header 在可滚动 body 之前，摘要行不被 body 包住（滚动不会被卷走）', () => {
    render(<TurnProcess entries={[toolEntry(0)]} running />)
    const header = screen.getByTestId('turn-process-header')
    const body = screen.getByTestId('turn-process-body')
    expect(header.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(body.contains(header)).toBe(false)
    expect(within(header).getByTestId('turn-process-summary')).toBeInTheDocument()
  })

  it('展开且有条目：出现 1px hairline 分隔（data-has-divider + CSS token）', () => {
    render(<TurnProcess entries={[toolEntry(0)]} running />)
    const header = screen.getByTestId('turn-process-header')
    expect(header).toHaveAttribute('data-has-divider', 'true')
    expect(header).toHaveClass('turn-process-header--divider')
    expect(TURN_PROCESS_CSS).toMatch(
      /\.turn-process-header--divider\s*\{[^}]*border-bottom:\s*var\(--hairline-width\)\s*solid\s*var\(--border-hairline\)/
    )
    // reduced 不引入动画
    expect(TURN_PROCESS_CSS).not.toMatch(/\.turn-process-header[^}]*animation:/)
  })

  it('无过程条目：不渲染分隔线（不占空线）', () => {
    render(<TurnProcess entries={[]} running={false} />)
    const header = screen.getByTestId('turn-process-header')
    expect(header).not.toHaveClass('turn-process-header--divider')
    expect(header).not.toHaveAttribute('data-has-divider')
  })
})

describe('task-104/105 · 内滚跟随 + 折叠态汇总行', () => {
  it('运行中内容高度增长：仍贴底则跟随到底（不只认 entries.length）', () => {
    const { rerender } = render(<TurnProcess entries={[toolEntry(0)]} running />)
    const body = screen.getByTestId('turn-process-body')
    fakeScrollGeometry(body, { scrollHeight: 800, clientHeight: 400 })
    body.scrollTop = 400
    body.dispatchEvent(new Event('scroll', { bubbles: true }))

    rerender(<TurnProcess entries={[toolEntry(0)]} running />)
    fakeScrollGeometry(body, { scrollHeight: 1400, clientHeight: 400 })
    rerender(<TurnProcess entries={[toolEntry(0)]} running />)
    expect(body.scrollTop).toBe(1400)
  })

  it('用户上滚后内容增长：暂停跟随（scrollTop 不被拉回）', () => {
    const { rerender } = render(<TurnProcess entries={[toolEntry(0), toolEntry(1)]} running />)
    const body = screen.getByTestId('turn-process-body')
    fakeScrollGeometry(body, { scrollHeight: 800, clientHeight: 400 })
    body.scrollTop = 0
    body.dispatchEvent(new Event('scroll', { bubbles: true }))
    rerender(<TurnProcess entries={[toolEntry(0), toolEntry(1), toolEntry(2)]} running />)
    expect(body.scrollTop).toBeLessThan(100)
  })

  it('完成/折叠态：有正文时汇总行与正文之间仍有 1px hairline；汇总行 b2 14', () => {
    render(<TurnProcess entries={[toolEntry(0)]} running={false} hasAnswer />)
    const header = screen.getByTestId('turn-process-header')
    expect(header).toHaveAttribute('data-has-divider', 'true')
    expect(header).toHaveClass('turn-process-header--divider')
    expect(screen.getByTestId('trace-toggle')).toHaveClass('text-b2')
  })

  it('折叠态但无正文/无条目：不出线', () => {
    render(<TurnProcess entries={[]} running={false} hasAnswer={false} />)
    expect(screen.getByTestId('turn-process-header')).not.toHaveClass(
      'turn-process-header--divider'
    )
  })
})

describe('PB-001 · 多消息轮：正文落在下一条 assistant 消息时，汇总行仍要出线', () => {
  /**
   * 用户实报的场景：工具轮常常「上一条 assistant 只有工具调用、正文在下一条 assistant 消息」。
   * `hasAnswer` 只看本条消息 → 折叠态 border-bottom 0px（用户：「执行完毕之后 执行工具汇总行
   * 没有横线与正文隔开」）。本用例按真实 DOM（两条 Message 同轮）钉住修复。
   *
   * 已知取舍（用户 2026-10-18 拍板 A 方案）：结束态无条件出线，所以「整轮完全没有正文」
   * 时结束时也会有一条线——这是有意为之，不是回归。
   */
  it('上一条只有工具调用、下一条只有正文：上一条折叠态仍出 1px hairline', () => {
    render(
      <>
        <Message
          message={assistantMessage(
            [
              {
                type: 'tool-read',
                toolCallId: 'c1',
                state: 'output-available',
                input: { path: 'a.txt' },
                output: '内容'
              }
            ],
            'a1'
          )}
        />
        <Message message={assistantMessage([{ type: 'text', text: '正文在下一轮消息里。' }], 'a2')} />
      </>
    )

    const headers = screen.getAllByTestId('turn-process-header')
    expect(headers).toHaveLength(1) // 正文那条消息没有过程块
    expect(headers[0]).toHaveAttribute('data-has-divider', 'true')
    expect(headers[0]).toHaveClass('turn-process-header--divider')
  })

  it('运行中手动收起：新规则不得越过运行中（仍不出线）', () => {
    render(<TurnProcess entries={[toolEntry(0)]} running />)
    fireEvent.click(screen.getByTestId('trace-toggle'))
    expect(screen.getByTestId('turn-process-header')).not.toHaveAttribute('data-has-divider')
  })
})
