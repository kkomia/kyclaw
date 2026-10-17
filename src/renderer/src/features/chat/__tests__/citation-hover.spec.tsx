import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageList } from '../MessageList'
import { citationHoverManager } from '../citation-hints'

/**
 * 2026-10-18 引用返工 · hover 稳定性（模块级单一 hover 管理器）。
 *
 * 覆盖：流式重渲染（卸载→同 key 重挂载）不丢 open、同一时刻只有一张卡、
 * 锚点离开视口才关（视口内滚动不关）、Esc / 窗口失焦立即关。
 */
const SEARCH_OUTPUT = [
  '联网搜索「巴黎人口」（后端：免费档）',
  '',
  '1. Paris - Wikipedia',
  '   URL: https://example.org/paris',
  '   摘要: 巴黎是法国的首都，人口约 210 万。',
  '',
  '2. Paris history',
  '   URL: https://example.org/history',
  '   摘要: 历史段落。'
].join('\n')

function webSearch(output = SEARCH_OUTPUT): UIMessage['parts'][number] {
  return {
    type: 'tool-web_search',
    toolCallId: 'search-1',
    state: 'output-available',
    input: { query: '巴黎人口' },
    output
  }
}

function text(value: string): UIMessage['parts'][number] {
  return { type: 'text', text: value }
}

function assistant(parts: UIMessage['parts']): UIMessage {
  return { id: 'a1', role: 'assistant', parts }
}

function renderReady(messages: UIMessage[]): ReturnType<typeof render> {
  return render(<MessageList messages={messages} status="ready" />)
}

afterEach(() => {
  vi.restoreAllMocks()
  citationHoverManager.reset()
})

describe('引用 hover 稳定性（单一管理器）', () => {
  it('流式重渲染（unmount → 同 key 重挂载）不丢 open，且只渲染一张卡', async () => {
    const messages = [
      assistant([
        webSearch(),
        text('巴黎人口约 210 万 [1](https://example.org/paris "Paris - Wikipedia")。')
      ])
    ]

    const first = renderReady(messages)
    fireEvent.focus(screen.getByTestId('citation-chip'))
    expect(await screen.findByTestId('citation-card')).toHaveTextContent('Paris - Wikipedia')

    // 模拟流式重渲染导致 chip 重挂载：先卸载，再用同一 key 挂一个新实例
    first.unmount()
    renderReady(messages)

    const card = await screen.findByTestId('citation-card')
    expect(card).toHaveTextContent('Paris - Wikipedia')
    expect(screen.getAllByTestId('citation-card')).toHaveLength(1)
  })

  it('全屏同一时刻只有一张卡：focus 第二枚角标会替换第一张', async () => {
    renderReady([
      assistant([
        webSearch(),
        text(
          '巴黎人口 [1](https://example.org/paris "Paris - Wikipedia")；' +
            '历史 [2](https://example.org/history "Paris history")。'
        )
      ])
    ])

    const chips = screen.getAllByTestId('citation-chip')
    expect(chips).toHaveLength(2)

    fireEvent.focus(chips[0]!)
    expect(await screen.findByTestId('citation-card')).toHaveTextContent('Paris - Wikipedia')

    fireEvent.focus(chips[1]!)
    await waitFor(() => {
      const cards = screen.getAllByTestId('citation-card')
      expect(cards).toHaveLength(1)
      expect(cards[0]).toHaveTextContent('Paris history')
    })
  })

  it('同 citationKey 的两枚角标（fragment 变体）不会互相抢 anchor / 循环更新', async () => {
    renderReady([
      assistant([
        webSearch(),
        text(
          '巴黎人口 [1](https://example.org/paris "Paris - Wikipedia")；' +
            '历史 [1](https://example.org/paris#history "Paris - Wikipedia")。'
        )
      ])
    ])

    const chips = screen.getAllByTestId('citation-chip')
    expect(chips).toHaveLength(2)
    // fragment 归一后同 key：focus 第一枚 → 一张卡；第二枚接管时仍只一张卡，不能 ping-pong
    fireEvent.focus(chips[0]!)
    expect(await screen.findByTestId('citation-card')).toBeInTheDocument()
    expect(screen.getAllByTestId('citation-card')).toHaveLength(1)

    fireEvent.focus(chips[1]!)
    await waitFor(() => {
      const cards = screen.getAllByTestId('citation-card')
      expect(cards).toHaveLength(1)
    })
  })

  it('视口内滚动只重定位不关；锚点离开视口才关', async () => {
    renderReady([
      assistant([
        webSearch(),
        text('巴黎人口约 210 万 [1](https://example.org/paris "Paris - Wikipedia")。')
      ])
    ])

    const chip = screen.getByTestId('citation-chip')
    vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue({
      top: 120,
      bottom: 144,
      left: 80,
      right: 104,
      width: 24,
      height: 24,
      x: 80,
      y: 120,
      toJSON: () => ({})
    } as DOMRect)
    fireEvent.focus(chip)
    expect(await screen.findByTestId('citation-card')).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    expect(screen.getByTestId('citation-card')).toBeInTheDocument()

    vi.spyOn(chip, 'getBoundingClientRect').mockReturnValue({
      top: -300,
      bottom: -276,
      left: 80,
      right: 104,
      width: 24,
      height: 24,
      x: 80,
      y: -300,
      toJSON: () => ({})
    } as DOMRect)
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
    await waitFor(() => expect(screen.queryByTestId('citation-card')).toBeNull())
  })

  it('Escape / 窗口失焦立即关；重新 focus 可再次打开', async () => {
    renderReady([
      assistant([webSearch(), text('巴黎 [1](https://example.org/paris "Paris - Wikipedia")。')])
    ])

    const chip = screen.getByTestId('citation-chip')
    fireEvent.focus(chip)
    expect(await screen.findByTestId('citation-card')).toBeInTheDocument()

    fireEvent.keyDown(chip, { key: 'Escape' })
    expect(screen.queryByTestId('citation-card')).toBeNull()

    fireEvent.focus(chip)
    expect(await screen.findByTestId('citation-card')).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(screen.queryByTestId('citation-card')).toBeNull()
  })
})
