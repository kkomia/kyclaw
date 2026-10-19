import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { ChatPage, ChatSession } from '@renderer/features/chat/ChatPage'
import { ErrorCard } from '@renderer/features/chat/ErrorCard'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import { resetSessionsStore } from '@renderer/features/sessions/sessions-store'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * threads-api 整体 mock：这些用例关心的是"出错 → 错误卡 → 重试"，不该打网络。
 * （编辑/重试前的服务端截断行为由 chat-flow.spec 与 threads.spec 各自覆盖）
 */
vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => []),
  fetchThreadMessages: vi.fn(async () => []),
  createThread: vi.fn(async (id: string, title?: string) => ({
    id,
    title: title ?? null,
    updatedAt: new Date().toISOString()
  })),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  truncateThread: vi.fn(async () => 0),
  generateThreadTitle: vi.fn(async () => ({ title: '', generated: false })),
  // round 19：压缩链路（ActiveChat 挂载即读记录；这些用例不做压缩）
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
}))

/**
 * 待答问题（ask-user）走 HTTP（`/ask-user/pending`），不是 IPC 面 —— 本文件里给一份
 * **有效空响应**的桩（`[]`，与真服务端"没有挂起问题"同形）：这些用例只关心错误卡与端点重试，
 * 不该因为一条打不通的取数在页脚多出一张错误卡来（那不是本用例要验证的错误）。
 * 与 ask-user-flow.spec 同一手法：保留模块其余导出（cancel / resume body 的形状不动）。
 */
const askUserApi = vi.hoisted(() => ({ pending: vi.fn(async () => []) }))
vi.mock('@renderer/lib/ask-user-api', async (original) => ({
  ...(await original<typeof import('@renderer/lib/ask-user-api')>()),
  fetchPendingAskUser: askUserApi.pending
}))

afterEach(() => {
  clearKyclawBridge()
})

beforeEach(() => {
  resetThreadChats()
  resetSessionsStore()
})

/**
 * Step 5：流报错（Review Focus #2）—— 401 / 断流 / 其它都落错误卡，重试 = 重发上一条。
 */
async function renderSession(control: MockTransport): Promise<void> {
  render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId="thread-errors"
        runtime={{ transport: control.transport, loadHistory: async () => [], onTurnEnd: () => {} }}
      />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
}

function type(text: string): void {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
}

function send(text: string): void {
  type(text)
  fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
}

function userTexts(control: MockTransport, index: number): string[] {
  return control.requests[index].messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
}

describe('ErrorCard 渲染', () => {
  it('一般错误：错误原文 + 重试按钮（不给 Key 指引）', () => {
    const onRetry = vi.fn()
    render(
      <MemoryRouter>
        <ErrorCard error={new Error('服务暂时不可用')} onRetry={onRetry} />
      </MemoryRouter>
    )

    expect(screen.getByTestId('error-card')).toHaveTextContent('服务暂时不可用')
    expect(screen.queryByTestId('error-auth-hint')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('error-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('PB-036：主文案中文、原始串收进「详情」（等宽折行），重试热区 ≥26（sm=26）', () => {
    render(
      <MemoryRouter>
        <ErrorCard
          error={new Error('socket hang up: ECONNRESET at TLS wrap on the same long line')}
          onRetry={vi.fn()}
        />
      </MemoryRouter>
    )

    expect(screen.getByTestId('error-message')).toHaveTextContent('连接中断')
    const details = screen.getByTestId('error-details')
    expect(details).toHaveTextContent('socket hang up')
    const raw = screen.getByTestId('error-raw')
    expect(raw.className).toContain('font-mono')
    expect(raw.className).toContain('break-all')
    expect(raw.className).toContain('whitespace-pre-wrap')
    // 卡片内每行同一左缩进（px-4），标题行/主文案/详情/按钮都在这条基线上
    const card = screen.getByTestId('error-card')
    expect(card.className).toContain('px-4')
    expect(screen.getByTestId('error-retry').className).toContain('h-(--control-height-sm)')
  })

  it('401：多一条"去设置填 Key"的指引，链接指向设置页', () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    render(
      <MemoryRouter>
        <ErrorCard error={unauthorized} onRetry={vi.fn()} />
      </MemoryRouter>
    )

    const hint = screen.getByTestId('error-auth-hint')
    expect(hint).toHaveTextContent(/设置/)
    expect(within(hint).getByRole('link')).toHaveAttribute('href', '/settings')
  })

  it('文案里的 unauthorized / api key 也算认证类错误（同上，走渲染口径）', () => {
    const { unmount } = render(
      <MemoryRouter>
        <ErrorCard error={new Error('Invalid API key provided')} onRetry={vi.fn()} />
      </MemoryRouter>
    )
    expect(screen.getByTestId('error-auth-hint')).toBeInTheDocument()
    unmount()

    render(
      <MemoryRouter>
        <ErrorCard error={new Error('socket hang up')} onRetry={vi.fn()} />
      </MemoryRouter>
    )
    expect(screen.queryByTestId('error-auth-hint')).not.toBeInTheDocument()
  })
})

describe('流报错 → 错误卡 + 重试（端到端）', () => {
  it('请求 401：错误卡带 Key 指引；重试重发上一条，成功后可继续对话', async () => {
    const control = createMockTransport()
    await renderSession(control)
    control.failNext(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))

    await act(async () => {
      send('问题')
    })

    const card = await screen.findByTestId('error-card')
    expect(card).toHaveTextContent('Unauthorized')
    expect(screen.getByTestId('error-auth-hint')).toBeInTheDocument()
    // 失败轮：用户消息仍然在列表里（不丢）
    expect(screen.getByTestId('message-list')).toHaveTextContent('问题')

    await act(async () => {
      fireEvent.click(screen.getByTestId('error-retry'))
    })

    await waitFor(() => {
      expect(control.requests).toHaveLength(2)
    })
    expect(control.requests[1].trigger).toBe('regenerate-message')
    expect(userTexts(control, 1)).toEqual(['问题'])

    await act(async () => {
      control.push('这次通了')
      control.finish()
    })

    expect(screen.queryByTestId('error-card')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-list')).toHaveTextContent('这次通了')
  })

  it('断流：半截内容留着 + 错误卡；重试整轮重发（不幻影续写）', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await act(async () => {
      send('问题')
    })
    await act(async () => {
      control.push('说到一半')
    })
    await act(async () => {
      control.disconnect()
    })

    expect(await screen.findByTestId('error-card')).toBeInTheDocument()
    // PB-036：轮次失败卡与正文同栅格（消息列同宽居中 + 18px 阅读缩进）
    expect(screen.getByTestId('error-card').parentElement?.className).toContain(
      'pl-[var(--chat-reading-indent)]'
    )
    expect(
      screen.getByTestId('error-card').parentElement?.parentElement?.className
    ).toContain('max-w-[calc(var(--chat-content-width)+32px)]')
    expect(screen.getByTestId('message-list')).toHaveTextContent('说到一半')

    await act(async () => {
      fireEvent.click(screen.getByTestId('error-retry'))
    })

    await waitFor(() => {
      expect(control.requests).toHaveLength(2)
    })
    // 重试是整轮重发：历史里只剩用户那条（半截回答被截掉，不会接着写）
    expect(control.requests[1].messages).toHaveLength(1)
    expect(userTexts(control, 1)).toEqual(['问题'])

    await act(async () => {
      control.push('完整回答')
      control.finish()
    })
    expect(screen.getByTestId('message-list')).toHaveTextContent('完整回答')
    expect(screen.queryByTestId('error-card')).not.toBeInTheDocument()
  })
})

describe('端点取不到（服务没起来）', () => {
  it('对话页给错误卡；重试重新取端点，拿到后进会话界面', async () => {
    installKyclawBridge()
    /**
     * 端点这一档**一直失败**，不是"只失败一次"：页面进不进错误态只取决于"端点取不到"这一个事实。
     * 同一时刻还有别的人在问同一个端点（项目映射、待答问题……），"第一次调用归谁"是谁先调度的事 ——
     * 拿 `mockRejectedValueOnce` 写这条用例，判据就挂在跨功能调用次序上了（改一处预取顺序就红）。
     * 重试前把这一档整体翻成"通"（不是"下一次通"），两段都不依赖调用次序。
     */
    let endpointDown = true
    const endpoint = vi.fn(async (): Promise<{ baseUrl: string; token: string }> => {
      if (endpointDown) throw new Error('agent 服务未启动')
      return { baseUrl: 'http://127.0.0.1:9', token: 'tok' }
    })
    window.kyclaw.agent.endpoint = endpoint
    // 端点背后的"服务"：列表与历史都给空（这个用例只验证端点重试这条路）
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url).pathname
        const payload = path.endsWith('/messages') ? { messages: [] } : { threads: [] }
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      })
    )

    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>
    )

    expect(await screen.findByTestId('error-card')).toHaveTextContent('agent 服务未启动')

    // 重试：这一档整体翻成"通"
    const before = endpoint.mock.calls.length
    endpointDown = false
    await act(async () => {
      fireEvent.click(screen.getByTestId('error-retry'))
    })

    // 重试 = 重新取了一次端点（只看"有没有再取"，不把次数钉成某个绝对数：
    // 还有别的功能也在问这个端点，绝对数同样是跨功能次序的断言）
    await waitFor(() => {
      expect(endpoint.mock.calls.length).toBeGreaterThan(before)
    })
    await waitFor(() => {
      expect(screen.queryByTestId('error-card')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('composer-input')).toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})
