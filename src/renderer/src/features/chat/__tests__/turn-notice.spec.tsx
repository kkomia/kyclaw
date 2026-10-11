import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * 轮末提示（round 33）：一轮**看起来跑完、其实是被截停/截断**时，输入框上方给一行人话。
 *   - `tool-calls` 收尾且没有待审批 = 单轮步数预算用尽（"任务没完成就中断了"）；
 *   - `length` = 输出被长度上限截断。
 * 正常收尾（stop）、出错、主动停止、以及"还停在等审批"的挂起轮都不提示。
 */
vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => []),
  fetchThreadMessages: vi.fn(async () => []),
  createThread: vi.fn(),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  truncateThread: vi.fn(async () => 0),
  generateThreadTitle: vi.fn(async () => ({ title: '', generated: false })),
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
}))

const THREAD_ID = 'thread-notice'

function makeRuntime(control: MockTransport): ThreadChatRuntime {
  return {
    transport: control.transport,
    loadHistory: vi.fn(async () => []),
    onTurnEnd: vi.fn()
  }
}

async function renderSession(control: MockTransport): Promise<void> {
  render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId={THREAD_ID}
        runtime={makeRuntime(control)}
      />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
}

function send(text: string): void {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
  fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
}

/** 跑一轮：发一条消息 → 回一段文本 → 按给定原因收尾 */
async function runTurn(
  control: MockTransport,
  text: string,
  reason?: 'stop' | 'tool-calls' | 'length'
): Promise<void> {
  await act(async () => {
    send(text)
  })
  await act(async () => {
    control.push('收到')
    control.finish(reason)
  })
}

beforeEach(() => {
  resetThreadChats()
})

describe('轮末提示（被截停 / 被截断）', () => {
  it('finishReason=tool-calls 且无待审批 → 提示"已达单轮步数上限，回复「继续」可接着做"', async () => {
    const control = createMockTransport()
    await renderSession(control)

    expect(screen.queryByTestId('turn-notice')).toBeNull()
    await runTurn(control, '做个长任务', 'tool-calls')

    const notice = await screen.findByTestId('turn-notice')
    expect(notice).toHaveTextContent('已达单轮步数上限，回复「继续」可接着做')
    // 不是小字（UI 雷点）：正文档 b2
    expect(notice.className).toContain('text-b2')
    expect(notice.className).toContain('animate-fade-in')
  })

  it('finishReason=length → 提示"输出达到长度上限，内容被截断"', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await runTurn(control, '写段长文', 'length')
    expect(await screen.findByTestId('turn-notice')).toHaveTextContent(
      '输出达到长度上限，内容被截断'
    )
  })

  it('finishReason=stop（正常收尾）→ 不提示', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await runTurn(control, '问个问题', 'stop')
    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toHaveTextContent('收到')
    })
    expect(screen.queryByTestId('turn-notice')).toBeNull()
  })

  it('挂起轮（等审批的 tool-calls 收尾）→ 不提示（审批卡才是该露的面）', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await act(async () => {
      send('跑个命令')
    })
    await act(async () => {
      control.requestApproval({
        toolCallId: 'call-bash',
        toolName: 'bash',
        input: { command: 'echo hi' },
        approvalId: 'run-1::call-bash'
      })
      control.finish('tool-calls')
    })

    // 审批卡在（挂起轮成立）
    await waitFor(() => {
      expect(screen.getByTestId('composer-input')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('turn-notice')).toBeNull()
  })

  it('新一轮开始（发送）→ 上一轮的提示消失', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await runTurn(control, '做个长任务', 'tool-calls')
    expect(await screen.findByTestId('turn-notice')).toBeInTheDocument()

    await act(async () => {
      send('继续')
    })
    await waitFor(() => {
      expect(screen.queryByTestId('turn-notice')).toBeNull()
    })
  })
})
