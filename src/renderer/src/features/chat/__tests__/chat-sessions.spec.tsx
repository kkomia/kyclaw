import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { resetSessionsStore } from '@renderer/features/sessions/sessions-store'
import { createMockTransport, type MockTransport } from './mock-transport'
import { nextFrame } from './next-frame'

/**
 * 切会话（spec §7.2 的目标语义）："切走生成继续、完成通知、切回看完整结果"。
 *
 * 服务端断开 = 取消本轮（threads.spec 的端到端证据），所以渲染端刻意**不**在切换时掐流：
 * Chat 实例挂在注册表里（useChat({ chat }) 对自有实例不做卸载清理），切走只是换视图。
 * 这里用两个 ChatSession 模拟会话切换，断言：
 *   1. 切走期间旧会话的流照常收尾（不受卸载影响），onTurnEnd 仍会到；
 *   2. 切回去看到完整结果（消息留在 Chat 实例里）；
 *   3. 目标会话的历史是回灌来的（没被旧会话的记忆污染）。
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

interface Harness {
  runtime: ThreadChatRuntime
  onTurnEnd: ReturnType<typeof vi.fn>
  loadHistory: ReturnType<typeof vi.fn>
}

function makeRuntime(control: MockTransport, historyB: boolean): Harness {
  const onTurnEnd = vi.fn()
  const loadHistory = vi.fn(async (threadId: string) =>
    threadId === 'thread-b' && historyB
      ? [
          {
            id: 'hb',
            role: 'assistant' as const,
            parts: [{ type: 'text' as const, text: 'B 的历史回答' }]
          }
        ]
      : []
  )
  return {
    runtime: { transport: control.transport, loadHistory, onTurnEnd },
    onTurnEnd,
    loadHistory
  }
}

/** 会话切换的宿主：点按钮换用哪个 ChatSession（key 换挂载，等价于切会话） */
function HarnessView({ runtime }: { runtime: ThreadChatRuntime }): React.JSX.Element {
  const [threadId, setThreadId] = useState('thread-a')
  return (
    <MemoryRouter>
      <div>
        <button type="button" data-testid="go-a" onClick={() => setThreadId('thread-a')}>
          A
        </button>
        <button type="button" data-testid="go-b" onClick={() => setThreadId('thread-b')}>
          B
        </button>
      </div>
      <ChatSession
        key={threadId}
        threadId={threadId}
        transport={runtime.transport}
        runtime={runtime}
      />
    </MemoryRouter>
  )
}

/** 进入会话等 Chat 就绪（外部实例是异步解析的：首次要先回灌历史） */
async function waitForComposer(): Promise<void> {
  await screen.findByTestId('composer-input')
}

async function send(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
  })
}

beforeEach(() => {
  resetThreadChats()
  // round 62：排队队列挂在会话 store 上（模块级状态）—— 不复位会让上一条用例的排队漏进来
  resetSessionsStore()
})

describe('流式中切走：不掐流、可收回', () => {
  it('切到别的会话后流照常收尾（onTurnEnd 仍到），切回来是完整结果', async () => {
    const control = createMockTransport()
    const { runtime, onTurnEnd } = makeRuntime(control, true)
    render(<HarnessView runtime={runtime} />)
    await waitForComposer()

    await send('A 的问题')
    await act(async () => {
      control.push('前半句')
    })
    // round 73：流式正文按帧上屏，推完增量让出一帧内容才落屏
    await nextFrame()
    expect(screen.getByTestId('message-list')).toHaveTextContent('前半句')

    // 流式中切到 B：B 的历史回灌出来了；A 的流没有被掐断
    fireEvent.click(screen.getByTestId('go-b'))
    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toHaveTextContent('B 的历史回答')
    })
    expect(onTurnEnd).not.toHaveBeenCalled()

    // 人在 B，A 的流继续收尾
    await act(async () => {
      control.push('后半句')
      control.finish()
    })
    await waitFor(() => {
      expect(onTurnEnd).toHaveBeenCalledWith('thread-a', {
        isError: false,
        isAbort: false,
        awaitingApproval: false
      })
    })

    // 切回 A：完整结果都在（消息留在 Chat 实例里）
    fireEvent.click(screen.getByTestId('go-a'))
    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toHaveTextContent('前半句后半句')
    })
  })

  it('切走再切回同一会话，不会重复回灌（同一个 Chat 实例）', async () => {
    const control = createMockTransport()
    const { runtime, loadHistory } = makeRuntime(control, false)
    render(<HarnessView runtime={runtime} />)
    await waitForComposer()

    await send('问题')
    await act(async () => {
      control.push('回答')
      control.finish()
    })
    /** 只数 A 自己的回灌（切到 B 时也会为 B 拉一次历史） */
    const aLoads = (): number =>
      loadHistory.mock.calls.filter((call) => call[0] === 'thread-a').length
    expect(aLoads()).toBe(1)

    fireEvent.click(screen.getByTestId('go-b'))
    await waitFor(() => {
      expect(screen.queryByText('回答')).not.toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('go-a'))
    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toHaveTextContent('回答')
    })
    // 切回没有重新拉历史（实例还在），也没有重复的请求
    expect(aLoads()).toBe(1)
    expect(control.requests).toHaveLength(1)
  })

  it('停止仍然是停止：流式中点停止会真的停（与切走区分开）', async () => {
    const control = createMockTransport()
    const { runtime } = makeRuntime(control, false)
    render(<HarnessView runtime={runtime} />)
    await waitForComposer()

    await send('问题')
    await act(async () => {
      control.push('半句')
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-stop'))
    })

    expect(screen.queryByTestId('composer-stop')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-list')).toHaveTextContent('半句')
  })

  /**
   * round 62（P0）：排队队列原来在 ActiveChat 的组件内 ref 里，而对话页按 `key={activeId}` 挂
   * 会话组件 —— 切会话就是卸载，队列与计数一起静默蒸发（Composer 那句"交给上层排队"的承诺落空）。
   * 现在队列按 threadId 挂在 sessions-store 上：切走再切回原样还在，且切回来那一刻就补发。
   */
  it('流式中连发两条排队 → 切走再切回，队列还在且照常补发', async () => {
    const control = createMockTransport()
    const { runtime } = makeRuntime(control, false)
    render(<HarnessView runtime={runtime} />)
    await waitForComposer()

    await send('A 的问题')
    await send('排队一')
    await send('排队二')
    // 流式中：都进队列，不并发请求
    expect(control.requests).toHaveLength(1)
    expect(screen.getByTestId('composer-queue')).toHaveTextContent('已排队 2 条')

    // 切到 B：A 的视图卸载（队列本体在 store 里，不跟着蒸发）
    fireEvent.click(screen.getByTestId('go-b'))
    await waitFor(() => expect(screen.queryByTestId('composer-queue')).not.toBeInTheDocument())

    // 人在 B 时 A 的流收尾：A 那一挂不在了，补发留在切回来那一刻
    await act(async () => {
      control.push('答一')
      control.finish()
    })
    expect(control.requests).toHaveLength(1)

    // 切回 A：排队条数原样还在，并立刻补发第一条
    fireEvent.click(screen.getByTestId('go-a'))
    await waitFor(() => expect(control.requests).toHaveLength(2))
    expect(
      control.requests[1].messages
        .filter((message) => message.role === 'user')
        .flatMap((message) => message.parts)
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    ).toEqual(['A 的问题', '排队一'])
    expect(screen.getByTestId('composer-queue')).toHaveTextContent('已排队 1 条')

    // 这一轮收尾 → 最后一条也补发出去；队列清空、提示收起
    await act(async () => {
      control.push('答二')
      control.finish()
    })
    await waitFor(() => expect(control.requests).toHaveLength(3))
    expect(
      control.requests[2].messages
        .filter((message) => message.role === 'user')
        .flatMap((message) => message.parts)
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    ).toEqual(['A 的问题', '排队一', '排队二'])
    expect(screen.queryByTestId('composer-queue')).not.toBeInTheDocument()
  })
})
