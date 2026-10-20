import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { ChatPage, ChatSession } from '@renderer/features/chat/ChatPage'
import { ErrorCard } from '@renderer/features/chat/ErrorCard'
import { RETRY_KEEP_PROMPT } from '@renderer/features/chat/retry-keep'
import { truncateThread } from '@renderer/lib/threads-api'
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

  it('PB-050：内核已退出（崩溃详情）→ 主文案就是详情，不被「连接中断」覆盖', () => {
    const message =
      '内核路径失败：内核进程已退出（exitCode=1）：内核不再响应，请重启应用。\n日志：C:\\Users\\me\\AppData\\Roaming\\kyclaw\\logs\\kernel.log'
    render(
      <MemoryRouter>
        <ErrorCard error={new Error(message)} onRetry={vi.fn()} />
      </MemoryRouter>
    )

    const copy = screen.getByTestId('error-message')
    expect(copy).toHaveTextContent('内核进程已退出（exitCode=1）')
    expect(copy).toHaveTextContent('请重启应用')
    expect(copy).toHaveTextContent('kernel.log')
    expect(copy).not.toHaveTextContent('连接中断')
    // 原始串仍在「详情」里（不删、可展开）
    expect(screen.getByTestId('error-raw')).toHaveTextContent('内核进程已退出')
  })

  it('PB-050：详情里同时带 read ECONNRESET 时，仍以内核崩溃详情为准（不被网络正则抢走）', () => {
    const message =
      '内核进程已退出（signal SIGKILL）：内核不再响应，请重启应用。\n日志：C:\\Users\\me\\AppData\\Roaming\\kyclaw\\logs\\kernel.log；底层连接错误：read ECONNRESET'
    render(
      <MemoryRouter>
        <ErrorCard error={new Error(message)} onRetry={vi.fn()} />
      </MemoryRouter>
    )

    const copy = screen.getByTestId('error-message')
    expect(copy).toHaveTextContent('内核进程已退出（signal SIGKILL）')
    expect(copy).not.toHaveTextContent('连接中断')
  })

  it('PB-050 负向控制：纯网络错误（内核没退）仍是「连接中断」文案', () => {
    render(
      <MemoryRouter>
        <ErrorCard error={new Error('read ECONNRESET')} onRetry={vi.fn()} />
      </MemoryRouter>
    )

    const copy = screen.getByTestId('error-message')
    expect(copy).toHaveTextContent('连接中断')
    expect(copy).not.toHaveTextContent('内核进程已退出')
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
    expect(screen.getByTestId('error-card').parentElement?.parentElement?.className).toContain(
      'max-w-[calc(var(--chat-content-width)+32px)]'
    )
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

  it('PB-050：in-flight 断流且内核已退出 → 卡片给崩溃详情（exitCode/日志路径），不是「连接中断」', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await act(async () => {
      send('长回答：说到一半杀内核')
    })
    await act(async () => {
      control.push('说到一半')
    })
    // 与主进程 kernel-chat 实际写进 SSE 的 errorText 同形（前缀由 kernel-chat 加）
    await act(async () => {
      control.disconnect(
        new Error(
          '内核路径失败：内核进程已退出（exitCode=1）：内核不再响应，请重启应用。\n日志：C:\\Users\\me\\AppData\\Roaming\\kyclaw\\logs\\kernel.log'
        )
      )
    })

    const card = await screen.findByTestId('error-card')
    const copy = screen.getByTestId('error-message')
    expect(copy).toHaveTextContent('内核进程已退出（exitCode=1）')
    expect(copy).toHaveTextContent('请重启应用')
    expect(copy).toHaveTextContent('kernel.log')
    expect(copy).not.toHaveTextContent('连接中断')
    // 已交付的半截内容仍在；重试入口仍在（PB-038 的「重启应用」是启动失败档，不受影响）
    expect(screen.getByTestId('message-list')).toHaveTextContent('说到一半')
    expect(
      card.querySelector('[data-testid="error-retry"], [data-testid="error-retry-keep"]')
    ).not.toBeNull()
    // 原始串收在「详情」里（不删）
    expect(screen.getByTestId('error-raw')).toHaveTextContent('内核进程已退出')
  })
})

describe('端点取不到（服务没起来）', () => {
  it('PB-038：启动失败给「重启应用」，点击走 app.relaunch，不再「再跑一次」', async () => {
    installKyclawBridge()
    const endpoint = vi.fn(async (): Promise<{ baseUrl: string; token: string }> => {
      throw new Error('agent 服务未启动')
    })
    window.kyclaw.agent.endpoint = endpoint
    const relaunch = vi.fn(async () => ({ ok: true as const }))
    window.kyclaw.app.relaunch = relaunch
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ threads: [] }), { status: 200 }))
    )

    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>
    )

    expect(await screen.findByTestId('error-card')).toHaveTextContent('agent 服务未启动')
    expect(screen.getByTestId('error-retry')).toHaveTextContent('重启应用')
    expect(screen.getByTestId('error-retry-hint')).toHaveTextContent('重启后会重新加载内核')
    expect(screen.queryByText('再跑一次')).not.toBeInTheDocument()

    const before = endpoint.mock.calls.length
    fireEvent.click(screen.getByTestId('error-retry'))
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(1))
    expect(endpoint.mock.calls.length).toBe(before)
    await waitFor(() => expect(screen.getByTestId('error-retry')).toHaveTextContent('正在重启…'))
    expect(screen.getByTestId('error-retry')).toBeDisabled()
    vi.unstubAllGlobals()
  })
})

/**
 * PB-035 B′（用户：「重试直接就是整轮重试 之前的东西都没了」）：
 * 失败轮**有产出**时给两条路 —— 「保留内容再试」（不清空、不 truncate，新起一轮追加）
 * 与「清空重来」（现状语义）；**无产出**时只留一个按钮，且三个词都不叫「重试」。
 */
describe('PB-035 B′：保留内容再试', () => {
  it('ErrorCard：有产出 → 两个按钮 + 保留说明；无产出 → 只有一个按钮', () => {
    const onRetry = vi.fn()
    const onRetryKeep = vi.fn()
    const { rerender } = render(
      <ErrorCard
        error={new Error('断了')}
        onRetry={onRetry}
        onRetryKeep={onRetryKeep}
        preservedRecords={3}
      />
    )
    expect(screen.getByTestId('error-retry-keep')).toHaveTextContent('保留内容再试')
    expect(screen.getByTestId('error-retry')).toHaveTextContent('清空重来')
    expect(screen.getByTestId('error-preserve-note')).toHaveTextContent('已产生 3 条记录')
    // 三个词都不叫「重试」
    expect(screen.getByTestId('error-retry-keep')).not.toHaveTextContent('重试')
    expect(screen.getByTestId('error-retry')).not.toHaveTextContent('重试')

    rerender(
      <ErrorCard
        error={new Error('断了')}
        onRetry={onRetry}
        onRetryKeep={onRetryKeep}
        preservedRecords={0}
      />
    )
    expect(screen.queryByTestId('error-retry-keep')).not.toBeInTheDocument()
    expect(screen.queryByTestId('error-preserve-note')).not.toBeInTheDocument()
    expect(screen.getByTestId('error-retry')).toHaveTextContent('再跑一次')
    expect(screen.getByTestId('error-retry')).not.toHaveTextContent('重试')
  })

  it('端到端：断流后点「保留内容再试」→ 不 truncate、旧内容保留、新起一轮追加，且标记消息不显示', async () => {
    installKyclawBridge()
    const control = createMockTransport()
    await renderSession(control)

    send('问题')
    await waitFor(() => expect(control.requests).toHaveLength(1))
    await act(async () => {
      control.push('说到一半')
    })
    await act(async () => {
      control.disconnect()
    })
    expect(await screen.findByTestId('error-card')).toBeInTheDocument()
    expect(screen.getByTestId('message-list')).toHaveTextContent('说到一半')

    vi.mocked(truncateThread).mockClear()
    await act(async () => {
      fireEvent.click(screen.getByTestId('error-retry-keep'))
    })

    await waitFor(() => expect(control.requests).toHaveLength(2))
    // ① 不清空：服务端 truncate 一次都没调
    expect(vi.mocked(truncateThread)).not.toHaveBeenCalled()
    // ② 新起一轮：请求里带着上一轮的内容（不止一条），且多出一条续跑指令
    expect(control.requests[1].messages.length).toBeGreaterThanOrEqual(2)
    expect(userTexts(control, 1)).toEqual(['问题', RETRY_KEEP_PROMPT])
    // ③ 旧内容仍在原位
    expect(screen.getByTestId('message-list')).toHaveTextContent('说到一半')
    // ④ 续跑指令不渲染成用户气泡
    expect(screen.getByTestId('message-list')).not.toHaveTextContent(RETRY_KEEP_PROMPT)
  })
})
