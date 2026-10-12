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
import { truncateThread, fetchThreadCompaction } from '@renderer/lib/threads-api'
import { mapStoredMessages } from '@renderer/lib/message-map'
import { defaultSettings } from '@shared/settings'
import type { StoredMessage } from '@shared/threads'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * 审批全流程（T13，RTL + 真实 Chat 实例）：服务端要求审批 → **输入框上方的审批条** → 决策回灌 →
 * 自动续跑（AI SDK 的 sendAutomaticallyWhen）→ 完成语义与队列门控。
 * round 29：审批卡从消息流里的工具链上搬到了 composer 停靠区（`approval-dock`），本文件同时钉住
 * "消息流里不再有审批按钮""重开会话从存储恢复的审批也停在输入框上方"。
 *
 * 底层是注入的假 transport：approval / tool-output chunk 由用例逐段推，形状与 chatRoute
 * 的 v7 协议一致；threads-api 整体 mock 掉（这些用例不碰网络，服务端的真往返由 mastra 侧
 * 的集成用例跑，见 src/mastra/tools/__tests__/approval.spec.ts）。
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
  truncateThread: vi.fn(async () => 2),
  generateThreadTitle: vi.fn(async () => ({ title: '', generated: false })),
  // round 19：压缩链路（ActiveChat 挂载即读记录；这些用例不做压缩）
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
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
  unmount: () => void
}

async function renderSession(
  control: MockTransport,
  injectRuntime = true,
  threadId = THREAD_ID,
  /** 回灌的历史（重开会话的场景：审批从存储 metadata 恢复） */
  history: UIMessage[] = []
): Promise<Session> {
  const onTurnEnd = vi.fn()
  const view = render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId={threadId}
        {...(injectRuntime
          ? {
              runtime: {
                transport: control.transport,
                loadHistory: async () => history,
                onTurnEnd
              }
            }
          : {})}
      />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
  return { control, onTurnEnd, unmount: view.unmount }
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

/**
 * 审批条（round 29）从"没了"到"真摘掉"中间有 300ms 的退场过渡（用户口径：不许闪现），
 * 断言"不再出现"要等它跑完。
 */
async function expectNoApproval(): Promise<void> {
  await waitFor(() => expect(screen.queryByTestId('approval-card')).not.toBeInTheDocument())
}

let bridge: KyclawBridgeStubs

beforeEach(() => {
  resetThreadChats()
  resetSessionApprovals()
  vi.mocked(truncateThread).mockClear()
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
  it('挂起轮：审批条停在输入框上方、带 diff 与四决策；点「允许一次」→ 自动续跑、回灌 approved:true', async () => {
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

    // round 29：卡在停靠区里（输入框上方），不在消息流里；消息流只剩只读的「等待审批」状态行
    const dock = screen.getByTestId('approval-dock')
    expect(dock).toHaveAttribute('data-open', 'true')
    expect(dock).toContainElement(card)
    expect(screen.getByTestId('tool-card')).toHaveAttribute('data-state', 'approval-requested')
    expect(screen.getByTestId('tool-state')).toHaveTextContent('等待审批')

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
    await expectNoApproval()
    expect(control.requests).toHaveLength(2)
  })

  it('同一步里既有记忆工具（UI 里停在 input-available）又有待审批写：决策后照常自动续跑', async () => {
    const control = createMockTransport()
    const session = await renderSession(control)

    await send('记一下我的偏好，然后写文件')
    act(() => {
      // Mastra 记忆工具：服务端把结果吞进记忆，UI 消息里永远停在 input-available（T18 复核②）
      control.toolInput('call-wm', 'updateWorkingMemory', { memory: '# 用户信息\n- 偏好：中文' })
      control.requestApproval(APPROVAL_A)
      control.finish()
    })

    await screen.findByTestId('approval-card')
    await waitFor(() =>
      expect(session.onTurnEnd).toHaveBeenCalledWith(THREAD_ID, {
        isError: false,
        isAbort: false,
        awaitingApproval: true
      })
    )

    fireEvent.click(screen.getByTestId('approval-allow-once'))

    // 修复点：AI SDK 内置判定会因那条 input-available 的记忆 part 恒 false —— 这里必须真的续跑
    await waitFor(() => expect(control.requests).toHaveLength(2))
    expect(control.requests[1].trigger).toBe('submit-message')
    expect(approvalIn(control, 1, 'call-a')).toMatchObject({ approved: true })
    // 续跑请求与普通发送同一口径：线程上下文照带（决策的 options 透传）
    expect(control.requests[1].body).toEqual({
      memory: { thread: THREAD_ID, resource: 'local-user' }
    })

    act(() => {
      control.toolOutput('call-a', '已写入 D:\\项目\\demo\\a.txt（12 字节）')
      control.push('记好了，文件也写完了。')
      control.finish()
    })
    await waitFor(() =>
      expect(session.onTurnEnd).toHaveBeenLastCalledWith(THREAD_ID, {
        isError: false,
        isAbort: false,
        awaitingApproval: false
      })
    )
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
    await expectNoApproval()

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
    // round 62（P0）：自动放行走的是**同一条**回灌出口 —— 自动续跑那次请求同样带线程上下文，
    // 否则服务端拿不到 memory.thread（round 51 修的是手动那条路，自动这条漏了同一处）
    expect(control.requests[2].body).toEqual({
      memory: { thread: THREAD_ID, resource: 'local-user' }
    })
    await expectNoApproval()

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

  it('等审批期间发送：进队列、不直发（直发会让决策失去自动续跑）；决策+续跑收尾后才发', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await send('写个文件')
    act(() => {
      control.requestApproval(APPROVAL_A)
      control.finish()
    })
    await screen.findByTestId('approval-card')

    // 挂起轮已结束（status=ready），但发送仍按"忙"处理：进队列，不产生第二次请求
    await send('顺便再写一个')
    expect(control.requests).toHaveLength(1)
    expect(screen.getByTestId('composer-queue')).toHaveTextContent('已排队 1 条')

    fireEvent.click(screen.getByTestId('approval-allow-once'))
    await waitFor(() => expect(control.requests).toHaveLength(2))
    // 续跑还没收尾：队列依旧不补发
    expect(control.requests).toHaveLength(2)

    act(() => {
      control.toolOutput('call-a', '已写入 a.txt')
      control.push('写好了。')
      control.finish()
    })

    await waitFor(() => expect(control.requests).toHaveLength(3))
    expect(userTexts(control, 2)).toEqual(['写个文件', '顺便再写一个'])
  })

  it('等审批期间没有编辑入口；续跑收尾后编辑入口回来（不是永远关着）', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await send('写个文件')
    act(() => {
      control.requestApproval(APPROVAL_A)
      control.finish()
    })
    await screen.findByTestId('approval-card')

    // 待批：不给编辑（编辑重发会截断掉那条挂起消息，服务端 run 快照还在）
    expect(screen.queryByTestId('message-edit')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('approval-allow-once'))
    await waitFor(() => expect(control.requests).toHaveLength(2))
    act(() => {
      control.toolOutput('call-a', '已写入 a.txt')
      control.push('写好了。')
      control.finish()
    })

    // 一轮真正结束（ready 且无待批）→ 编辑入口按原语义回来
    await waitFor(() => expect(screen.getByTestId('message-edit')).toBeInTheDocument())
  })

  it('永久允许：先登记本会话记忆 —— 同对话里紧随的第二次写不再弹卡', async () => {
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

    // 续跑里再来一次同工具 + 同工作区的审批 → 直接放行（不依赖落盘成功）
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
    await expectNoApproval()
  })

  it('永久允许落盘失败：露一行"没保存"，本对话里仍然继续放行；原始 Error 落控制台', async () => {
    const control = createMockTransport()
    await renderSession(control)
    const failure = new Error('磁盘满了')
    bridge.update.mockRejectedValueOnce(failure)

    await send('写个文件')
    act(() => {
      control.requestApproval(APPROVAL_A)
      control.finish()
    })
    await screen.findByTestId('approval-card')

    fireEvent.click(screen.getByTestId('approval-allow-forever'))

    expect(await screen.findByTestId('approval-permanent-error')).toHaveTextContent('没能保存')
    expect(console.error).toHaveBeenCalledWith('[kyclaw] 「永久允许」没能写进设置', failure)

    // 落盘失败了，但"先登记"的会话记忆还在：同对话里第二次写照旧不弹卡
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
    await expectNoApproval()
  })

  it('本会话允许只覆盖当前对话：换个会话（threadId 不同）照旧弹卡', async () => {
    const first = createMockTransport()
    const firstSession = await renderSession(first)

    await send('写个文件')
    act(() => {
      first.requestApproval(APPROVAL_A)
      first.finish()
    })
    await screen.findByTestId('approval-card')
    fireEvent.click(screen.getByTestId('approval-allow-session'))
    await waitFor(() => expect(first.requests).toHaveLength(2))
    firstSession.unmount()

    const second = createMockTransport()
    await renderSession(second, true, 'thread-other')
    await send('再写一个')
    act(() => {
      second.requestApproval({ ...APPROVAL_A, approvalId: 'run-2::call-a' })
      second.finish()
    })

    expect(await screen.findByTestId('approval-card')).toBeInTheDocument()
    // 没有自动放行：请求数还是 1（自动放行会立刻续跑出第二次请求）
    expect(second.requests).toHaveLength(1)
  })
})

describe('审批条停靠（round 29：输入框上方，不在消息流里）', () => {
  it('同一步多个挂起：审批条里多条堆叠、逐个决策，全部处理完才自动续跑', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await send('写两个文件')
    act(() => {
      control.requestApproval(APPROVAL_A)
      control.requestApproval({
        toolCallId: 'call-b',
        toolName: 'write',
        input: { path: 'b.txt', content: 'x' },
        approvalId: 'run-1::call-b'
      })
      control.finish()
    })

    await waitFor(() => expect(screen.getAllByTestId('approval-card')).toHaveLength(2))
    expect(screen.getByTestId('approval-dock')).toHaveAttribute('data-open', 'true')
    expect(screen.getAllByTestId('approval-target').map((node) => node.textContent)).toEqual([
      'a.txt',
      'b.txt'
    ])

    // 只决策第一条：还有待审批 → 不续跑（闸门在 canResumeAfterApproval）
    fireEvent.click(screen.getAllByTestId('approval-allow-once')[0])
    expect(control.requests).toHaveLength(1)
    await waitFor(() => expect(screen.getAllByTestId('approval-card')).toHaveLength(1))

    // 第二条也决策完 → 两条审批一起回灌、自动续跑
    fireEvent.click(screen.getByTestId('approval-allow-once'))
    await waitFor(() => expect(control.requests).toHaveLength(2))
    expect(approvalIn(control, 1, 'call-a')).toMatchObject({ approved: true })
    expect(approvalIn(control, 1, 'call-b')).toMatchObject({ approved: true })
    await expectNoApproval()
  })

  it('重开会话（重启后）：存储里挂起的审批恢复成输入框上方的审批条，批准即续跑', async () => {
    const control = createMockTransport()
    const history = mapStoredMessages([
      {
        id: 'u1',
        role: 'user',
        content: { format: 2, parts: [{ type: 'text', text: '写个文件' }] }
      },
      {
        id: 'a1',
        role: 'assistant',
        content: {
          format: 2,
          parts: [
            { type: 'reasoning', reasoning: '先看一下工作区' },
            {
              type: 'tool-invocation',
              toolInvocation: {
                state: 'call',
                toolCallId: 'call-hang',
                toolName: 'write',
                args: { path: 'a.txt', content: '第一行' }
              }
            }
          ],
          metadata: {
            pendingToolApprovals: {
              'call-hang': {
                toolCallId: 'call-hang',
                toolName: 'write',
                runId: 'run-9',
                type: 'approval'
              }
            }
          }
        }
      } as unknown as StoredMessage
    ])

    await renderSession(control, true, THREAD_ID, history)

    const card = await screen.findByTestId('approval-card')
    expect(screen.getByTestId('approval-dock')).toContainElement(card)
    expect(card).toHaveAttribute('data-tool', 'write')
    expect(card).toHaveAttribute('data-workspace', WORKSPACE)
    expect(screen.getByTestId('approval-target')).toHaveTextContent('a.txt')
    // 消息流里同样只有只读状态行（审批入口只有输入框上方这一处）
    expect(screen.getByTestId('tool-state')).toHaveTextContent('等待审批')

    fireEvent.click(screen.getByTestId('approval-allow-once'))

    // 审批 id 按服务端口径复原（runId::toolCallId）→ 回灌后服务端能从快照续跑
    await waitFor(() => expect(control.requests).toHaveLength(1))
    expect(approvalIn(control, 0, 'call-hang')).toMatchObject({
      id: 'run-9::call-hang',
      approved: true
    })
  })

  it('思考段先于工具行到达：流里先出「思考中…」，工具调用前不裸奔（round 29 复核）', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await send('看看环境再写')
    act(() => {
      control.reason('先看看工作区里有什么')
    })

    // 只有思考：独立思考块直接出、「思考中…」行在
    expect(await screen.findByTestId('reasoning-toggle')).toHaveTextContent('思考中…')
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent('先看看工作区里有什么')

    // 工具行到达（这一轮还在流）：思考段保持展开 —— 不是"工具挨工具"裸奔
    act(() => {
      control.requestApproval(APPROVAL_A)
    })
    await waitFor(() =>
      expect(screen.getByTestId('tool-card')).toHaveAttribute('data-state', 'approval-requested')
    )
    expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('reasoning-text')).toHaveTextContent('先看看工作区里有什么')
    expect(screen.getByTestId('approval-dock')).toHaveAttribute('data-open', 'true')

    // 挂起轮收尾（流停）：思考段按老口径收起，过程块因为还有待审批仍开着（只读状态行看得见）
    act(() => {
      control.finish()
    })
    await waitFor(() =>
      expect(screen.getByTestId('reasoning-toggle')).toHaveAttribute('aria-expanded', 'false')
    )
    expect(screen.getByTestId('trace-block')).toHaveAttribute('data-open', 'true')
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

describe('待批闸门 × 错误卡旧重试（T13 N1：截断失败留下的重试卡不能绕过闸门）', () => {
  it('「编辑重发」留下的旧重试卡：等审批期间点它不动作；决策续跑收尾后恢复原语义', async () => {
    const control = createMockTransport()
    await renderSession(control)

    // 第一轮：编辑重发时服务端截断失败 → syncError 卡（重试 = 重做 editResend）
    await send('原始问题')
    await act(async () => {
      control.push('答')
      control.finish()
    })
    vi.mocked(truncateThread).mockRejectedValueOnce(new Error('线程服务返回 500'))
    fireEvent.click(screen.getByTestId('message-edit'))
    fireEvent.change(screen.getByTestId('message-edit-input'), {
      target: { value: '改过的问题' }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('message-edit-save'))
    })
    await screen.findByText(/没能在服务端同步/)
    expect(vi.mocked(truncateThread)).toHaveBeenCalledTimes(1)

    // 接着开一轮、挂在等审批上（旧卡片还在）
    await send('写个文件')
    act(() => {
      control.requestApproval(APPROVAL_A)
      control.finish()
    })
    await screen.findByTestId('approval-card')

    // 点旧卡的重试：待批期间必须不动作——不截断、不发请求
    // （直发会让决策失去自动续跑；编辑会截断掉挂起消息而服务端 run 快照还在）
    await act(async () => {
      fireEvent.click(screen.getByTestId('error-retry'))
    })
    expect(vi.mocked(truncateThread)).toHaveBeenCalledTimes(1)
    expect(control.requests).toHaveLength(2)

    // 决策 + 续跑收尾后闸门放开：重试恢复原语义（重新截断并重发）
    fireEvent.click(screen.getByTestId('approval-allow-once'))
    await waitFor(() => expect(control.requests).toHaveLength(3))
    await act(async () => {
      control.toolOutput('call-a', '已写入 a.txt')
      control.push('写好了。')
      control.finish()
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('error-retry'))
    })
    await waitFor(() => expect(control.requests).toHaveLength(4))
    expect(vi.mocked(truncateThread)).toHaveBeenCalledTimes(2)
  })

  it('「重新生成」留下的旧重试卡：等审批期间点它也不动作（两条路径同闸门）', async () => {
    const control = createMockTransport()
    await renderSession(control)

    // 一轮回答到一半流断了：错误卡（重试 = 先截断再 regenerate）
    await send('问题')
    act(() => {
      control.push('半个回答')
      control.disconnect()
    })
    await screen.findByTestId('error-card')

    // 截断失败 → 换成 syncError 卡（kind=retry）；点的是后渲染的那张（syncError）
    vi.mocked(truncateThread).mockRejectedValueOnce(new Error('线程服务返回 500'))
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('error-retry').at(-1) as HTMLElement)
    })
    await screen.findByText(/没能在服务端同步/)
    expect(vi.mocked(truncateThread)).toHaveBeenCalledTimes(1)

    // 再来一轮、挂在等审批（流错误卡被新请求清掉，只剩 syncError 卡）
    await send('写个文件')
    act(() => {
      control.requestApproval(APPROVAL_A)
      control.finish()
    })
    await screen.findByTestId('approval-card')
    expect(screen.getAllByTestId('error-retry')).toHaveLength(1)

    await act(async () => {
      fireEvent.click(screen.getByTestId('error-retry'))
    })
    expect(vi.mocked(truncateThread)).toHaveBeenCalledTimes(1)
    expect(control.requests).toHaveLength(2)
  })

  it('round 19：会话有压缩记录时，挂起 → 决策 → 续跑不受影响；等审批期间压缩命令禁用', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadCompaction).mockResolvedValueOnce({
      threadId: THREAD_ID,
      summary: '## 要点\n- 之前聊过写文件',
      summarized: 4,
      kept: 10,
      createdAt: '2026-10-11T02:00:00.000Z',
      // round 59：记录新增两个必填 token 字段（这条只验审批链路，取 null）
      tokensBefore: null,
      tokensAfter: null
    })
    await renderSession(control, true, THREAD_ID, [
      // round 59：分界线要有对话流才画（空会话画的是初始页）；有压缩记录的会话现实里也有消息
      { id: 'h0', role: 'user', parts: [{ type: 'text', text: '之前聊过写文件' }] }
    ])
    expect(await screen.findByTestId('compaction-marker')).toBeInTheDocument()

    await send('写个文件')
    act(() => {
      control.requestApproval(APPROVAL_A)
      control.finish()
    })
    await screen.findByTestId('approval-card')

    // 等审批期间：压缩命令行可见但禁用（压缩不与挂起轮打架）
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '/' } })
    input.setSelectionRange(1, 1)
    fireEvent.select(input)
    expect(screen.getByTestId('suggest-command:compact')).toBeDisabled()

    // 决策 → 自动续跑：照常发出带线程上下文的回灌请求
    fireEvent.click(screen.getByTestId('approval-allow-once'))
    await waitFor(() => expect(control.requests).toHaveLength(2))
    expect(approvalIn(control, 1, 'call-a')).toMatchObject({ approved: true })

    await act(async () => {
      control.toolOutput('call-a', '已写入 a.txt')
      control.push('写好了。')
      control.finish()
    })
    await expectNoApproval()
  })
})
