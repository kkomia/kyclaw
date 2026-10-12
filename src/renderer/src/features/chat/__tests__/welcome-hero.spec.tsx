import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * round 59 · 对话初始页（空会话）：品牌标题 + 输入框居中。
 *
 * 触发：当前会话消息为空、没有错误、没有待审批（草稿与空会话都算）。
 * 布局：标题居中偏上（ky 主文字色 / claw 强调色 + 一行次级品牌语），输入框竖直居中
 *   （由 ChatPage 那三格弹性分配做出来：消息区与 welcome-spacer 等分剩余高度）。
 * 动效：进场淡入 + 上浮（animate-message-in；页脚晚 80ms 起步）；离场走 .trace-fold 收合
 *   —— "收过"内容仍在 DOM（不硬切、也不重挂，输入框全程可用）。
 * 有历史消息的会话（挂载时就没有初始页）压根不渲染它。
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
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
}))

const THREAD_ID = 'thread-hero'

function runtimeOf(control: MockTransport, history: UIMessage[] = []): ThreadChatRuntime {
  return {
    transport: control.transport,
    loadHistory: vi.fn(async () => history),
    onTurnEnd: vi.fn()
  }
}

async function renderSession(control: MockTransport, runtime: ThreadChatRuntime): Promise<void> {
  render(
    <MemoryRouter>
      <ChatSession transport={control.transport} threadId={THREAD_ID} runtime={runtime} />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
}

function send(text: string): void {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
  fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
}

beforeEach(() => {
  resetThreadChats()
})

describe('空会话的初始页', () => {
  it('初始页可见：品牌标题（ky 主色 / claw 强调色）+ 次级品牌语', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    const hero = screen.getByTestId('welcome-hero')
    expect(hero).toHaveAttribute('data-open', 'true')
    expect(hero).toHaveClass('animate-message-in')

    const title = screen.getByTestId('welcome-title')
    expect(title).toHaveTextContent('kyclaw')
    expect(title).toHaveClass('welcome-title') // 展示级字号（tailwind.css 的配方，跟着 UI 字号档缩放）
    // claw 用强调色，ky 用主文字色（同一个 <h1> 里的两段）
    expect(title.querySelector('span')).toHaveClass('text-accent-text')
    expect(title.firstChild?.textContent).toBe('ky')

    expect(screen.getByText('帮你把活干完')).toBeInTheDocument()
    // 不多加任何小字/提示/菜单：标题块里只有这两行
    expect(hero.querySelectorAll('h1, p')).toHaveLength(2)
  })

  it('输入框在同一个页脚里（不重挂）；下半格弹性占位撑着"竖直居中"', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    const footer = screen.getByTestId('chat-footer')
    expect(footer).toContainElement(screen.getByTestId('composer'))
    // 进场：页脚与标题同一套动画，页脚晚 80ms 起步
    expect(footer).toHaveClass('animate-message-in')
    expect(footer.className).toContain('[animation-delay:80ms]')

    // 分界线/消息区都还在（限宽列的既有口径不变），只是消息为空
    expect(screen.getByTestId('message-list')).toBeInTheDocument()
    expect(screen.getByTestId('welcome-spacer')).toHaveClass('grow')
  })

  it('有历史消息的会话：不渲染初始页', async () => {
    const control = createMockTransport()
    await renderSession(
      control,
      runtimeOf(control, [
        { id: 'h1', role: 'user', parts: [{ type: 'text', text: '上次聊到哪了' }] }
      ])
    )

    await screen.findByTestId('message-h1')
    expect(screen.queryByTestId('welcome-hero')).not.toBeInTheDocument()
    expect(screen.getByTestId('welcome-spacer')).toHaveClass('grow-0')
  })
})

describe('首条消息发出：标题离场、布局落到常规', () => {
  it('标题收起（内容留 DOM 走过渡）、占位收到 0、消息正常渲染，且输入框接着能用', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))
    expect(screen.getByTestId('welcome-hero')).toHaveAttribute('data-open', 'true')

    await act(async () => {
      send('第一个问题')
    })

    // 离场：data-open=false 就是 .trace-fold 的收起态（标题淡出收起，不硬切）
    expect(screen.getByTestId('welcome-hero')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('welcome-hero')).not.toHaveClass('animate-message-in')
    expect(screen.getByTestId('chat-footer')).not.toHaveClass('animate-message-in')
    // 收起 ≠ 卸载：内容还在 DOM 里（有对象可动）
    expect(screen.getByTestId('welcome-title')).toBeInTheDocument()
    // 常规布局：页脚不再被弹性占位顶上去
    expect(screen.getByTestId('welcome-spacer')).toHaveClass('grow-0')
    // 消息正常渲染
    expect(screen.getByTestId('message-list')).toHaveTextContent('第一个问题')
    expect(control.requests).toHaveLength(1)

    // 落位过程输入框保持可用：这一轮跑完还能接着发第二条
    await act(async () => {
      control.push('答一')
      control.finish()
    })
    await act(async () => {
      send('第二个问题')
    })
    expect(control.requests).toHaveLength(2)
    expect(screen.getByTestId('message-list')).toHaveTextContent('第二个问题')
    expect(screen.queryByTestId('welcome-hero')).not.toBeNull()
    expect(screen.getByTestId('welcome-hero')).toHaveAttribute('data-open', 'false')
  })
})
