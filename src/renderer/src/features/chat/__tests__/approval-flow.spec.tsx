import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { resetSessionApprovals } from '@renderer/features/chat/approval'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import { useSessionsStore } from '@renderer/features/sessions/sessions-store'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * 审批全流程（T13，RTL + 真实 Chat 实例）：服务端要求审批 → 审批卡 → 决策回灌 →
 * 自动续跑（AI SDK 的 sendAutomaticallyWhen）→ 完成语义与队列门控。
 *
 * 底层是注入的假 transport：approval / tool-output chunk 由用例逐段推，形状与 chatRoute
 * 的 v7 协议一致；threads-api 整体 mock 掉（这些用例不碰网络，服务端的真往返由 mastra 侧
 * 的集成用例跑，见 src/mastra/tools/__tests__/approval.spec.ts）。
 */
vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => []),
  fetchThreadMessages: vi.fn(async () => []),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  truncateThread: vi.fn(async () => 2),
  generateThreadTitle: vi.fn(async () => ({ title: '', generated: false }))
}))

const THREAD_ID = 'thread-approval'
const WORKSPACE = 'D:\\项目\\demo'

const APPROVAL_A = {
  toolCallId: 'call-a',
  toolName: 'write',
  input: { path: 'a.txt', content: '第一行\n第二行' },
  approvalId: 'run-1::call-a'
}

interface Session {
  control: MockTransport
  onTurnEnd: ReturnType<typeof vi.fn>
}

async function renderSession(control: MockTransport, injectRuntime = true): Promise<Session> {
  const onTurnEnd = vi.fn()
  render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId={THREAD_ID}
        {...(injectRuntime
          ? { runtime: { transport: control.transport, loadHistory: async () => [], onTurnEnd } }
          : {})}
      />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
  return { control, onTurnEnd }
}

async function send(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
  })
}

/** 第 index 次请求里、带这个 toolCallId 的 part 的 approval（断言回灌内容） */
function approvalIn(control: MockTransport, index: number, toolCallId: string): unknown {
  const message = control.requests[index]?.messages.find(
    (candidate: UIMessage) =>
      candidate.role === 'assistant' &&
      candidate.parts.some((part) => (part as { toolCallId?: string }).toolCallId === toolCallId)
  )
  const part = message?.parts.find(
    (candidate) => (candidate as { toolCallId?: string }).toolCallId === toolCallId
  )
  return (part as { approval?: unknown } | undefined)?.approval
}

/** 某次请求里的用户消息文本 */
function userTexts(control: MockTransport, index: number): string[] {
  return (control.requests[index]?.messages ?? [])
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
}

let bridge: KyclawBridgeStubs

beforeEach(() => {
  resetThreadChats()
  resetSessionApprovals()
  useSessionsStore.setState({
    threads: [],
    activeId: null,
    loaded: false,
    error: null,
    notices: {}
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const initial = {
    ...defaultSettings(),
    workspaces: [{ path: WORKSPACE, mode: 'ask' as const }]
  }
  bridge = installKyclawBridge(initial)
  useSettingsStore.setState({ settings: initial, loaded: true })
})

afterEach(() => {
  clearKyclawBridge()
  vi.restoreAllMocks()
})

describe('审批卡全流程（挂起 → 决策 → 续跑）', () => {
  it('挂起轮：卡片带 diff 与四决策；点「允许一次」→ 自动续跑、回灌 approved:true', async () => {
    const control = createMockTransport()
    const session = await renderSession(control)

    await send('写个文件')
    act(() => {
      control.requestApproval(APPROVAL_A)
      control.finish()
    })

    const card = await screen.findByTestId('approval-card')
    expect(card).toHaveAttribute('data-tool', 'write')
    expect(card).toHaveAttribute('data-workspace', WORKSPACE)
    expect(screen.getByTestId('approval-target')).toHaveTextContent('a.txt')
    const lines = screen.getAllByTestId('approval-diff-line')
    expect(lines.map((line) => line.getAttribute('data-kind'))).toEqual(['add', 'add'])
    expect(lines[0]).toHaveTextContent('第一行')

    // 挂起轮不是完成轮（渲染端据此不跑标题生成/完成通知）
    await waitFor(() =>
      expect(session.onTurnEnd).toHaveBeenCalledWith(THREAD_ID, {
        isError: false,
        isAbort: false,
        awaitingApproval: true
      })
    )

    fireEvent.click(screen.getByTestId('approval-allow-once'))

    await waitFor(() => expect(control.requests).toHaveLength(2))
    expect(approvalIn(control, 1, 'call-a')).toMatchObject({ approved: true })
    expect((approvalIn(control, 1, 'call-a') as { reason?: string }).reason).toBeUndefined()

    // 续跑（服务端执行工具 → 回结果 → 模型收尾），这一轮结束才是真完成
    act(() => {
      control.toolOutput('call-a', '已写入 D:\\项目\\demo\\a.txt（12 字节）')
      control.push('写好了。')
      control.finish()
    })
    await waitFor(() =>
      expect(session.onTurnEnd).toHaveBeenLastCalledWith(THREAD_ID, {
        isError: false,
        isAbort: false,
        awaitingApproval: false
      })
    )
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument()
    expect(control.requests).toHaveLength(2)
  })

  it('拒绝：回灌 approved:false 带原因，恢复成静态工具卡', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await send('写个文件')
    act(() => {
      control.requestApproval(APPROVAL_A)
      control.finish()
    })
    await screen.findByTestId('approval-card')

    fireEvent.click(screen.getByTestId('approval-deny'))

    await waitFor(() => expect(control.requests).toHaveLength(2))
    expect(approvalIn(control, 1, 'call-a')).toMatchObject({
      approved: false,
      reason: '用户拒绝了这次操作'
    })
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument()

    act(() => {
      control.push('好，那我不写。')
      control.finish()
    })
    await waitFor(() =>
      expect(screen.getAllByTestId('message-text').at(-1)).toHaveTextContent('好，那我不写。')
    )
  })

  it('永久允许：写进 settings.permissions.rules（工具 + 工作区）', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await send('写个文件')
    act(() => {
      control.requestApproval(APPROVAL_A)
      control.finish()
    })
    await screen.findByTestId('approval-card')

    fireEvent.click(screen.getByTestId('approval-allow-forever'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        permissions: { rules: [{ tool: 'write', workspace: WORKSPACE, mode: 'allow' }] }
      })
    )
    expect(useSettingsStore.getState().settings.permissions.rules).toEqual([
      { tool: 'write', workspace: WORKSPACE, mode: 'allow' }
    ])
    await waitFor(() => expect(control.requests).toHaveLength(2))
    expect(approvalIn(control, 1, 'call-a')).toMatchObject({ approved: true })
  })

  it('本会话允许：只进内存；同工具 + 同工作区的下一次审批自动放行（不再弹卡）', async () => {
    const control = createMockTransport()
    const session = await renderSession(control)

    await send('写个文件')
    act(() => {
      control.requestApproval(APPROVAL_A)
      control.finish()
    })
    await screen.findByTestId('approval-card')

    fireEvent.click(screen.getByTestId('approval-allow-session'))

    await waitFor(() => expect(control.requests).toHaveLength(2))
    // 只进内存：没有写设置（永久规则才落盘）
    expect(bridge.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ permissions: expect.anything() })
    )

    // 续跑的这一轮里又来一次同工具 + 同工作区的审批 → 自动放行，不打扰用户
    act(() => {
      control.toolOutput('call-a', '已写入 a.txt')
      control.requestApproval({
        toolCallId: 'call-b',
        toolName: 'write',
        input: { path: 'b.txt', content: 'x' },
        approvalId: 'run-1::call-b'
      })
      control.finish()
    })

    await waitFor(() => expect(control.requests).toHaveLength(3))
    expect(approvalIn(control, 2, 'call-b')).toMatchObject({ approved: true })
    expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument()

    act(() => {
      control.toolOutput('call-b', '已写入 b.txt')
      control.push('两个都写好了。')
      control.finish()
    })
    await waitFor(() =>
      expect(session.onTurnEnd).toHaveBeenLastCalledWith(THREAD_ID, {
        isError: false,
        isAbort: false,
        awaitingApproval: false
      })
    )
  })

  it('等审批时不补发排队消息：决策做完、续跑收尾后才发', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await send('写个文件')
    // 流还开着时用户又发了一条 → 进队列
    await send('再等等')

    act(() => {
      control.requestApproval(APPROVAL_A)
      control.finish()
    })
    await screen.findByTestId('approval-card')

    // 挂起轮结束也不补发（还是一次请求）
    expect(control.requests).toHaveLength(1)

    fireEvent.click(screen.getByTestId('approval-allow-session'))
    await waitFor(() => expect(control.requests).toHaveLength(2))

    act(() => {
      control.toolOutput('call-a', '已写入 a.txt')
      control.push('写好了。')
      control.finish()
    })

    // 续跑收尾 → 排队的消息补发
    await waitFor(() => expect(control.requests).toHaveLength(3))
    expect(userTexts(control, 2)).toEqual(['写个文件', '再等等'])
  })
})

describe('挂起轮 ≠ 完成轮（默认 runtime 的完成语义）', () => {
  it('挂起轮不触发 handleTurnEnd；决策后的续跑轮才触发一次', async () => {
    const control = createMockTransport()
    const handleTurnEnd = vi
      .spyOn(useSessionsStore.getState(), 'handleTurnEnd')
      .mockResolvedValue(undefined)

    await renderSession(control, false)

    await send('写个文件')
    act(() => {
      control.requestApproval(APPROVAL_A)
      control.finish()
    })
    await screen.findByTestId('approval-card')
    expect(handleTurnEnd).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('approval-allow-once'))
    await waitFor(() => expect(control.requests).toHaveLength(2))

    act(() => {
      control.toolOutput('call-a', '已写入 a.txt')
      control.push('写好了。')
      control.finish()
    })

    await waitFor(() => expect(handleTurnEnd).toHaveBeenCalledTimes(1))
    expect(handleTurnEnd).toHaveBeenCalledWith(THREAD_ID)
  })
})
