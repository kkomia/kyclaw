import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * round 59 · 对话初始页（空会话）：品牌标题 + 输入框竖直居中。
 *
 * 触发：当前会话消息为空、没有错误、没有待审批（草稿与空会话都算）。
 * 布局：标题 `absolute bottom-full` 挂在页脚（输入框那一格）之上、**不占布局高度** ——
 *   消息区与 welcome-spacer 等分剩余高度，输入框因此是真·竖直居中（用户实拍"偏下"的修正）。
 * 标题形态：`<kyclaw>`（尖括号强调色 / 中间主文字色）+ 一行次级品牌语。
 * 动效：进场淡入 + 上浮（`animate-message-in`；页脚晚 80ms 起步）；离场换 `animate-fade-out`
 *   —— 绝对定位没有高度可收合，"收过"内容仍在 DOM（不硬切、也不重挂，输入框全程可用）。
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
  it('初始页可见：`<kyclaw>`（尖括号强调色 / 中间主色）+ 次级品牌语', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    const hero = screen.getByTestId('welcome-hero')
    expect(hero).toHaveAttribute('data-active', 'true')
    expect(hero).toHaveClass('animate-message-in')

    const title = screen.getByTestId('welcome-title')
    expect(title.textContent).toBe('<kyclaw>')
    expect(title).toHaveClass('welcome-title') // 展示级字号（tailwind.css 的配方，跟着 UI 字号档缩放）
    expect(title).toHaveClass('text-ink') // 中间的品牌名用主文字色
    // 尖括号用强调色（双色法从 claw 移到括号上，对齐 KIMI <Code>）
    const brackets = title.querySelectorAll('span')
    expect(brackets).toHaveLength(2)
    expect(brackets[0]?.textContent).toBe('<')
    expect(brackets[1]?.textContent).toBe('>')
    for (const bracket of brackets) expect(bracket).toHaveClass('text-accent-text')

    expect(screen.getByText('帮你把活干完')).toBeInTheDocument()
    // 不多加任何小字/提示/菜单：标题块里只有这两行
    expect(hero.querySelectorAll('h1, p')).toHaveLength(2)
  })

  it('标题挂法：绝对定位在页脚（输入框那一格）之上，不占布局高度 → 输入框真·竖直居中', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))

    const footer = screen.getByTestId('chat-footer')
    const hero = screen.getByTestId('welcome-hero')
    // 挂点：标题是页脚那一格的绝对定位子元素（页脚带 relative），不参与流内高度
    expect(footer).toHaveClass('relative')
    expect(footer).toContainElement(screen.getByTestId('composer'))
    expect(hero).toHaveClass('absolute', 'bottom-full', 'pointer-events-none')
    // 进场：页脚与标题同一套动画，页脚晚 80ms 起步
    expect(footer).toHaveClass('animate-message-in')
    expect(footer.className).toContain('[animation-delay:80ms]')

    // 分界线/消息区都还在（限宽列的既有口径不变），只是消息为空；下半格弹性占位撑着居中
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
  it('标题淡出（内容留 DOM）、占位收到 0、消息正常渲染，且输入框接着能用', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control))
    expect(screen.getByTestId('welcome-hero')).toHaveAttribute('data-active', 'true')

    await act(async () => {
      send('第一个问题')
    })

    // 离场 = 换成淡出（绝对定位没有高度可收合；两段动画首尾状态相接，不硬切）
    const hero = screen.getByTestId('welcome-hero')
    expect(hero).toHaveAttribute('data-active', 'false')
    expect(hero).toHaveClass('animate-fade-out')
    expect(hero).not.toHaveClass('animate-message-in')
    expect(screen.getByTestId('chat-footer')).not.toHaveClass('animate-message-in')
    // 离场 ≠ 卸载：内容还在 DOM 里（有对象可动）
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
    expect(screen.getByTestId('welcome-hero')).toHaveAttribute('data-active', 'false')
  })
})
