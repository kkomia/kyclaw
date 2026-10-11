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
    const endpoint = vi
      .fn()
      .mockRejectedValueOnce(new Error('agent 服务未启动'))
      .mockResolvedValue({ baseUrl: 'http://127.0.0.1:9', token: 'tok' })
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

    await act(async () => {
      fireEvent.click(screen.getByTestId('error-retry'))
    })

    await waitFor(() => {
      expect(endpoint).toHaveBeenCalledTimes(2)
    })
    expect(await screen.findByTestId('composer-input')).toBeInTheDocument()
    expect(screen.queryByTestId('error-card')).not.toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})
