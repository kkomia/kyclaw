import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { StoredMessage } from '@shared/threads'
import { mapStoredMessages } from '@renderer/lib/message-map'
import { MessageList } from '../MessageList'

/**
 * 0.1.3 网页引用：真实 React 渲染面。
 *
 * 覆盖：数字 HTTP 链接命中已完成工具结果才出角标（未命中保持普通链接）、普通链接不变、
 * 危险协议不可点、hover/focus 摘要卡（host/title/snippet + 本地站点视觉 + portal）、
 * Escape / chip 失焦 / 窗口失焦收起、来源面板的折叠/展开/首次顺序/fragment 去重/跨 text part、
 * 流式隐藏、表格内引用、reference-style / 代码块 / HTML 实体与渲染一致、
 * 多 assistant 本轮共享 allowlist、用户轮之间不污染、历史回读（mapStoredMessages）。
 */
const SEARCH_OUTPUT = [
  '联网搜索「巴黎人口」（后端：免费档）',
  '',
  '1. Paris - Wikipedia',
  '   URL: https://example.org/paris',
  '   摘要: 巴黎是法国的首都，人口约 210 万。'
].join('\n')

interface SearchHit {
  url: string
  title?: string
  snippet?: string
}

function searchOutput(hits: readonly SearchHit[]): string {
  const lines = ['联网搜索「测试」（后端：免费档）', '']
  hits.forEach((hit, index) => {
    lines.push(`${index + 1}. ${hit.title ?? hit.url}`)
    lines.push(`   URL: ${hit.url}`)
    if (hit.snippet !== undefined) lines.push(`   摘要: ${hit.snippet}`)
  })
  return lines.join('\n')
}

function assistant(parts: UIMessage['parts'], id = 'a1'): UIMessage {
  return { id, role: 'assistant', parts }
}

function user(value: string, id = 'u1'): UIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text: value }] }
}

function text(value: string): UIMessage['parts'][number] {
  return { type: 'text', text: value }
}

function webSearch(output = SEARCH_OUTPUT): UIMessage['parts'][number] {
  return {
    type: 'tool-web_search',
    toolCallId: 'search-1',
    state: 'output-available',
    input: { query: '巴黎人口' },
    output
  }
}

function fetchPart(url: string, output = 'HTTP 200\n\n页面正文'): UIMessage['parts'][number] {
  return {
    type: 'tool-fetch',
    toolCallId: 'fetch-1',
    state: 'output-available',
    input: { url },
    output
  }
}

function renderReady(messages: UIMessage[]): ReturnType<typeof render> {
  return render(<MessageList messages={messages} status="ready" />)
}

afterEach(() => {
  vi.useRealTimers()
})

describe('正文角标：provenance 门控', () => {
  it('命中工具结果的数字链接渲染成角标；普通链接保持原样', () => {
    renderReady([
      assistant([
        webSearch(),
        text(
          '巴黎人口约 210 万 [1](https://example.org/paris "Paris - Example")，' +
            '另见 [文档](https://example.org/docs)。'
        )
      ])
    ])

    const chip = screen.getByTestId('citation-chip')
    expect(chip).toHaveTextContent('1')
    expect(chip).toHaveAttribute('href', 'https://example.org/paris')
    expect(chip).toHaveAttribute('target', '_blank')
    expect(chip).toHaveAttribute('rel', 'noreferrer')
    expect(chip).toHaveAttribute('aria-label', '来源 1：Paris - Example（example.org）')
    expect(chip).toHaveClass('citation-chip')
    expect(within(chip).getByTestId('citation-chip-face')).toHaveTextContent('1')

    const normal = screen.getByRole('link', { name: '文档' })
    expect(normal).not.toBe(chip)
    expect(normal).toHaveAttribute('href', 'https://example.org/docs')
    expect(normal).toHaveAttribute('target', '_blank')
    expect(normal).not.toHaveAttribute('data-testid', 'citation-chip')
  })

  it('正文 URL 不在工具结果里：不产生角标 / 来源面板，保持普通安全外链', () => {
    renderReady([
      assistant([webSearch(), text('巴黎 [1](https://not-in-tools.example/x "看起来像标题")。')])
    ])

    expect(screen.queryByTestId('citation-chip')).toBeNull()
    expect(screen.queryByTestId('sources-toggle')).toBeNull()

    const normal = screen.getByRole('link', { name: '1' })
    expect(normal).toHaveAttribute('href', 'https://not-in-tools.example/x')
    expect(normal).toHaveAttribute('target', '_blank')
    expect(normal).not.toHaveAttribute('data-testid', 'citation-chip')
    expect(normal).not.toHaveClass('citation-chip')
  })

  it('工具结果自己不会变成来源：没有正文数字链接就没有面板 / 角标', () => {
    renderReady([assistant([webSearch()])])

    expect(screen.queryByTestId('sources-toggle')).toBeNull()
    expect(screen.queryByTestId('citation-chip')).toBeNull()
  })

  it('fetch 的 input.url / final-url 能授权正文引用', () => {
    renderReady([
      assistant([
        fetchPart('https://example.org/start', 'HTTP 200\n\n页面正文'),
        text('页面 [1](https://example.org/start "Start")。')
      ])
    ])

    expect(screen.getByTestId('citation-chip')).toHaveAttribute('href', 'https://example.org/start')
    expect(screen.getByTestId('sources-toggle')).toHaveAttribute('aria-label', '来源（1）')
  })

  it('危险协议不产生角标，也不留可点击的 javascript: 链接', () => {
    renderReady([
      assistant([
        text(
          '示例 [1](javascript:alert(1))、[2](data:text/html,x)、' +
            '[3](javascript&colon;alert(1)) 与 [4](https://user:pass@example.org/x) 都不是来源。'
        )
      ])
    ])

    expect(screen.queryByTestId('citation-chip')).toBeNull()
    expect(screen.queryByTestId('sources-toggle')).toBeNull()
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull()
    expect(document.querySelector('a[href*="javascript"]')).toBeNull()
    expect(document.querySelector('a[href*="user:pass"]')).toBeNull()
    expect(screen.getByTestId('message-text')).toHaveTextContent('1')
  })

  it('围栏代码与行内代码里的数字链接不变成角标，也不进来源', () => {
    renderReady([
      assistant([
        webSearch(),
        text(
          ['```md', '[1](https://code.example/x)', '```', '`[2](https://inline.example/y)`'].join(
            '\n'
          )
        )
      ])
    ])

    expect(screen.queryByTestId('citation-chip')).toBeNull()
    expect(screen.queryByTestId('sources-toggle')).toBeNull()
  })

  it('blockquote 围栏与缩进代码里的数字链接不变成角标，也不进来源', () => {
    renderReady([
      assistant([
        webSearch(),
        text(
          [
            '> ```md',
            '> [1](https://example.org/paris)',
            '> ```',
            '',
            '    [2](https://example.org/paris)'
          ].join('\n')
        )
      ])
    ])

    expect(screen.queryByTestId('citation-chip')).toBeNull()
    expect(screen.queryByTestId('sources-toggle')).toBeNull()
  })

  it('reference-style link 与内联链接同口径：出角标并进来源面板', () => {
    renderReady([
      assistant([
        webSearch(),
        text(
          [
            '[ref]: https://example.org/paris "Paris - Wikipedia"',
            '',
            '巴黎人口约 210 万 [1][ref]。'
          ].join('\n')
        )
      ])
    ])

    const chip = screen.getByTestId('citation-chip')
    expect(chip).toHaveAttribute('href', 'https://example.org/paris')
    expect(chip).toHaveAttribute('aria-label', '来源 1：Paris - Wikipedia（example.org）')
    expect(screen.getByTestId('sources-toggle')).toHaveAttribute('aria-label', '来源（1）')
  })

  it('HTML 实体：正文 &amp; 与工具结果的 & 命中同一条来源，href 用解码后的 URL', () => {
    const output = searchOutput([{ url: 'https://example.org/paris?a=1&b=2', title: 'Paris' }])
    renderReady([
      assistant([
        webSearch(output),
        text('巴黎 [1](https://example.org/paris?a=1&amp;b=2 "Paris")。')
      ])
    ])

    const chip = screen.getByTestId('citation-chip')
    expect(chip).toHaveAttribute('href', 'https://example.org/paris?a=1&b=2')

    fireEvent.click(screen.getByTestId('sources-toggle'))
    expect(screen.getByTestId('source-link')).toHaveAttribute(
      'href',
      'https://example.org/paris?a=1&b=2'
    )
  })

  it('表格单元格里的引用仍走同一个角标组件', () => {
    const output = searchOutput([{ url: 'https://a.example/x', title: 'A 来源' }])
    renderReady([
      assistant([
        webSearch(output),
        text(
          ['| 来源 | 说明 |', '| --- | --- |', '| [1](https://a.example/x "A 来源") | 正文 |'].join(
            '\n'
          )
        )
      ])
    ])

    const table = screen.getByRole('table')
    const chip = within(table).getByTestId('citation-chip')
    expect(chip).toHaveAttribute('href', 'https://a.example/x')
    expect(screen.getByTestId('sources-toggle')).toBeInTheDocument()
  })
})

describe('hover / focus 摘要卡', () => {
  it('focus 立即出卡：标题 / host / 摘要 + 本地站点视觉，无远程图片；Escape / 失焦 / 窗口失焦收起', async () => {
    renderReady([
      assistant([
        webSearch(),
        text('巴黎人口约 210 万 [1](https://example.org/paris "Paris - Wikipedia")。')
      ])
    ])

    const chip = screen.getByTestId('citation-chip')
    fireEvent.focus(chip)

    const card = await screen.findByTestId('citation-card')
    expect(card).toHaveAttribute('role', 'tooltip')
    expect(card).toHaveTextContent('Paris - Wikipedia')
    expect(card).toHaveTextContent('example.org')
    expect(card).toHaveTextContent('巴黎是法国的首都，人口约 210 万。')
    expect(card.querySelector('img')).toBeNull()
    expect(within(card).getByTestId('site-mark')).toHaveAttribute('data-site-host', 'example.org')
    expect(within(card).getByTestId('site-mark')).toHaveTextContent('E')
    expect(chip).toHaveAttribute('aria-describedby', card.id)

    fireEvent.keyDown(chip, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('citation-card')).toBeNull())

    fireEvent.focus(chip)
    await screen.findByTestId('citation-card')
    fireEvent.blur(chip)
    await waitFor(() => expect(screen.queryByTestId('citation-card')).toBeNull())

    fireEvent.focus(chip)
    await screen.findByTestId('citation-card')
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    await waitFor(() => expect(screen.queryByTestId('citation-card')).toBeNull())
  })

  it('hover 延迟打开，移出收起（不加载远程 favicon）', () => {
    vi.useFakeTimers()
    renderReady([
      assistant([webSearch(), text('巴黎 [1](https://example.org/paris "Paris - Example")。')])
    ])

    const chip = screen.getByTestId('citation-chip')
    fireEvent.mouseEnter(chip)
    expect(screen.queryByTestId('citation-card')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(200)
    })

    const card = screen.getByTestId('citation-card')
    expect(card).toHaveTextContent('Paris - Example')
    expect(card.querySelector('img')).toBeNull()

    fireEvent.mouseLeave(chip)
    expect(screen.queryByTestId('citation-card')).toBeNull()
  })
})

describe('来源汇总面板', () => {
  it('跨 text part 首次顺序去重；fragment 合并、query 保留；默认折叠，展开后是外链', () => {
    const output = searchOutput([
      { url: 'https://b.example/x', title: 'B 来源' },
      { url: 'https://a.example/x', title: 'A 来源' },
      { url: 'https://a.example/x?page=2', title: 'A 第二页' }
    ])
    renderReady([
      assistant([
        webSearch(output),
        text('A [2](https://b.example/x "B 来源") [1](https://a.example/x#one "A 来源")'),
        text('B [1](https://a.example/x#two) [3](https://a.example/x?page=2 "A 第二页")')
      ])
    ])

    const toggle = screen.getByTestId('sources-toggle')
    expect(toggle).toHaveAttribute('aria-label', '来源（3）')
    // 入口是 icon-only：零可见文字，也没有「引用」字样
    expect(toggle).toHaveTextContent('')
    expect(toggle).not.toHaveTextContent('引用')
    expect(toggle.querySelector('svg')?.getAttribute('class')).toContain('lucide-globe')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('sources-list')).toBeNull()

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('sources-panel')).toBeInTheDocument()

    const list = screen.getByTestId('sources-list')
    expect(list.tagName).toBe('UL')

    const items = screen.getAllByTestId('source-item')
    expect(items).toHaveLength(3)
    expect(items[0]).toHaveTextContent('B 来源')
    expect(items[0]).toHaveTextContent('b.example')
    expect(items[1]).toHaveTextContent('A 来源')
    expect(items[1]).toHaveTextContent('a.example')
    expect(items[2]).toHaveTextContent('A 第二页')

    // 列表语义：可见编号是模型编号，对读屏隐藏；完整语义在链接的 aria-label 里
    expect(screen.getAllByTestId('source-label')[0]).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getAllByTestId('site-mark')).toHaveLength(3)
    expect(document.querySelector('[data-testid="sources-list"] img')).toBeNull()

    const links = screen.getAllByTestId('source-link')
    expect(links[0]).toHaveAttribute('href', 'https://b.example/x')
    expect(links[1]).toHaveAttribute('href', 'https://a.example/x#one')
    expect(links[2]).toHaveAttribute('href', 'https://a.example/x?page=2')
    expect(links[0]).toHaveAttribute('aria-label', '来源 2：B 来源（b.example）')
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noreferrer')
    }
  })

  it('流式期间隐藏，流结束（status ready）后出现', async () => {
    const message = assistant([
      webSearch(),
      text('巴黎 [1](https://example.org/paris "Paris - Example")。')
    ])
    const view = render(<MessageList messages={[message]} status="streaming" />)

    expect(screen.getByTestId('citation-chip')).toBeInTheDocument()
    expect(screen.queryByTestId('sources-toggle')).toBeNull()

    view.rerender(<MessageList messages={[message]} status="ready" />)
    await waitFor(() => expect(screen.getByTestId('sources-toggle')).toBeInTheDocument())
    expect(screen.getByTestId('sources-toggle')).toHaveAttribute('aria-label', '来源（1）')
  })
})

describe('多 assistant / 用户轮边界', () => {
  it('工具结果在 A、引用在 B：本轮共享 allowlist，面板只在轮末出现', async () => {
    renderReady([
      user('巴黎人口多少？'),
      assistant([webSearch(), text('已查到资料。')], 'a1'),
      assistant(
        [text('巴黎人口约 210 万 [1](https://example.org/paris "Paris - Wikipedia")。')],
        'a2'
      )
    ])

    expect(screen.getAllByTestId('citation-chip')).toHaveLength(1)
    expect(screen.getAllByTestId('sources-toggle')).toHaveLength(1)
    expect(screen.getByTestId('sources-toggle')).toHaveAttribute('aria-label', '来源（1）')

    fireEvent.focus(screen.getByTestId('citation-chip'))
    const card = await screen.findByTestId('citation-card')
    expect(card).toHaveTextContent('巴黎是法国的首都，人口约 210 万。')
  })

  it('上一轮工具结果不给下一轮授权：跨用户消息的 URL 仍是普通链接', () => {
    renderReady([
      user('先查巴黎。', 'u1'),
      assistant([webSearch(), text('已查到资料。')], 'a1'),
      user('那纽约呢？', 'u2'),
      assistant([text('巴黎资料在这里 [1](https://example.org/paris)。')], 'a2')
    ])

    expect(screen.queryByTestId('citation-chip')).toBeNull()
    expect(screen.queryByTestId('sources-toggle')).toBeNull()
    expect(screen.getByRole('link', { name: '1' })).toHaveAttribute(
      'href',
      'https://example.org/paris'
    )
  })
})

describe('历史回读', () => {
  it('mapStoredMessages 还原的正文 + web_search 结果仍出角标 / 摘要 / 面板', async () => {
    const stored = [
      {
        id: 'a-history',
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'result',
                toolCallId: 'search-history',
                toolName: 'web_search',
                args: { query: '巴黎人口' },
                result: SEARCH_OUTPUT
              }
            },
            {
              type: 'text',
              text: '巴黎人口约 210 万 [1](https://example.org/paris "Paris - Wikipedia")。'
            }
          ]
        }
      }
    ] as StoredMessage[]

    renderReady(mapStoredMessages(stored))

    const chip = screen.getByTestId('citation-chip')
    expect(chip).toHaveAttribute('href', 'https://example.org/paris')
    expect(screen.getByTestId('sources-toggle')).toHaveAttribute('aria-label', '来源（1）')

    fireEvent.focus(chip)
    const card = await screen.findByTestId('citation-card')
    expect(card).toHaveTextContent('Paris - Wikipedia')
    expect(card).toHaveTextContent('巴黎是法国的首都，人口约 210 万。')
  })
})
