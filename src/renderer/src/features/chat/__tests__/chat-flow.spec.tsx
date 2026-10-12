import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { truncateThread } from '@renderer/lib/threads-api'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * 会话级行为：流式中发送排队、停止、编辑=截断重发（R2：先服务端 truncate，再客户端截断）、
 * 每轮请求带 threadId/resourceId、出错重试。
 * 全部走真实交互路径（往输入框里敲 + 回车 / 点按钮），底层是注入的假 transport 与假 runtime；
 * threads-api 整体 mock 掉（这些用例不碰网络，服务端的截断行为由 threads.spec 真跑）。
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

const THREAD_ID = 'thread-1'

interface TestRuntime {
  runtime: ThreadChatRuntime
  loadHistory: ReturnType<typeof vi.fn>
  onTurnEnd: ReturnType<typeof vi.fn>
}

function makeRuntime(
  control: MockTransport,
  history: { id: string; role: 'user' | 'assistant'; text: string }[] = []
): TestRuntime {
  const loadHistory = vi.fn(async () =>
    history.map((message) => ({
      id: message.id,
      role: message.role,
      parts: [{ type: 'text' as const, text: message.text }]
    }))
  )
  const onTurnEnd = vi.fn()
  return {
    runtime: { transport: control.transport, loadHistory, onTurnEnd },
    loadHistory,
    onTurnEnd
  }
}

async function renderSession(
  control: MockTransport,
  runtime: ThreadChatRuntime,
  threadId = THREAD_ID
): Promise<void> {
  render(
    <MemoryRouter>
      <ChatSession transport={control.transport} threadId={threadId} runtime={runtime} />
    </MemoryRouter>
  )
  // 会话的 Chat 是异步解析出来的（首次进入要先回灌历史），等输入框出现再交互
  await screen.findByTestId('composer-input')
}

function type(text: string): void {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
}

function send(text: string): void {
  type(text)
  fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
}

/** 请求历史里的用户消息文本（断言截断/队列时最直观） */
function userTexts(control: MockTransport, index: number): string[] {
  return control.requests[index].messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
}

beforeEach(() => {
  resetThreadChats()
  vi.mocked(truncateThread).mockClear()
  vi.mocked(truncateThread).mockResolvedValue(2)
})

describe('线程上下文', () => {
  it('每轮请求带 threadId / resourceId（服务端据此落线程；resourceId 固定 local-user）', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    await act(async () => {
      send('问题')
    })

    // 形状 = Mastra 只认的 memory.thread/resource（与 threads.spec 用同一个构造函数）
    expect(control.requests[0].body).toEqual({
      memory: { thread: THREAD_ID, resource: 'local-user' }
    })
  })

  it('首屏把服务端历史灌进会话（回灌）', async () => {
    const control = createMockTransport()
    const { runtime, loadHistory } = makeRuntime(control, [
      { id: 'h1', role: 'user', text: '上次聊到哪了' },
      { id: 'h2', role: 'assistant', text: '聊到会话管理。' }
    ])
    await renderSession(control, runtime)

    await waitFor(() => {
      expect(screen.getByTestId('message-list')).toHaveTextContent('上次聊到哪了')
    })
    expect(loadHistory).toHaveBeenCalledWith(THREAD_ID)
    expect(screen.getByTestId('message-list')).toHaveTextContent('聊到会话管理。')
  })
})

describe('活动会话落在限宽内容列（P0 回归）', () => {
  it('message-list / composer 都在 chat-page 里的限宽列（chat-column）里', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    const frame = screen.getByTestId('chat-page')
    const column = within(frame).getByTestId('chat-column')
    expect(column).toHaveClass('content-column')
    expect(within(column).getByTestId('message-list')).toBeInTheDocument()
    expect(within(column).getByTestId('composer')).toBeInTheDocument()
  })

  it('消息区包裹层自带 flex 列身份（round 59 用户实拍回归：丢了这个 class 组合，消息会溢到输入框下面）', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    // jsdom 量不到真实布局，只能钉住"受限高度链"的类名（MessageList 的 frame 在里面靠它拿高度）
    const frame = screen.getByTestId('message-list-frame')
    const area = frame.parentElement as HTMLElement
    expect(area).toHaveClass('flex', 'min-h-0', 'flex-1', 'flex-col')
  })

  it('顶栏在限宽列之外（round 27）：整幅 header 带、ml 让到内容卡可见左缘；标题 = 卡左缘 + 16', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    const frame = screen.getByTestId('chat-page')
    const column = within(frame).getByTestId('chat-column')
    const header = screen.getByTestId('chat-header')
    // 顶栏不在限宽列里（列只装消息区 + 发送框；用户口径：标题贴面板最左，不被居中列推开）
    expect(column).not.toContainElement(header)
    // 顶栏带：整幅宽 + ml(内容安全左缘) 跟着侧栏开合过渡；标题 = 卡左缘 + header pl-2 + 按钮 px-2 = +16
    const band = header.parentElement as HTMLElement
    expect(frame).toContainElement(band)
    expect(band.className).toContain('ml-(--content-safe-left)')
    expect(header).toHaveClass('pl-2')
    expect(screen.getByTestId('chat-title')).toHaveClass('px-2')
    // DOM 顺序：顶栏带在限宽列之前
    expect(band.compareDocumentPosition(column) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('摘要轨的定位基准是 chat 页根（round 21）：closest(".relative") = chat-page（整幅），不是限宽列', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    // 两条用户消息才会出轨
    await act(async () => {
      send('第一问')
    })
    await act(async () => {
      control.push('答一')
      control.finish()
    })
    await act(async () => {
      send('第二问')
    })
    await act(async () => {
      control.push('答二')
      control.finish()
    })

    const rail = screen.getByTestId('message-rail')
    expect(rail.closest('.relative')).toBe(screen.getByTestId('chat-page'))
    // chat 页根是整幅（不套 content-column）；限宽列是它的子层
    const page = screen.getByTestId('chat-page')
    expect(page).not.toHaveClass('content-column')
    expect(within(page).getByTestId('chat-column')).toHaveClass('content-column')
  })
})

describe('流式中发送 = 入队（最简队列）', () => {
  it('流式中的发送先排队，当前回复结束后自动发出', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    await act(async () => {
      send('第一个问题')
    })
    expect(control.requests).toHaveLength(1)

    // 流式中的第二条：进队列，不并发请求
    await act(async () => {
      send('第二个问题')
    })
    expect(control.requests).toHaveLength(1)
    expect(screen.getByTestId('composer-queue')).toHaveTextContent('已排队 1 条')

    await act(async () => {
      control.push('答一')
      control.finish()
    })

    // 流结束 → 队列自动发出（客户端仍带全量历史；服务端记忆以 id 对齐，不重复落库）
    await waitFor(() => {
      expect(control.requests).toHaveLength(2)
    })
    expect(userTexts(control, 1)).toEqual(['第一个问题', '第二个问题'])
    expect(screen.queryByTestId('composer-queue')).not.toBeInTheDocument()
  })

  it('停止后队列也不丢：回到可发送态时把它发出去', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    await act(async () => {
      send('第一个问题')
    })
    await act(async () => {
      send('排队中的问题')
    })
    expect(control.requests).toHaveLength(1)

    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-stop'))
    })

    await waitFor(() => {
      expect(control.requests).toHaveLength(2)
    })
    expect(userTexts(control, 1)).toEqual(['第一个问题', '排队中的问题'])
  })
})

describe('停止', () => {
  it('停止后保留已生成的内容，并回到可发送态', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    await act(async () => {
      send('问题')
    })
    await act(async () => {
      control.push('半句回答')
    })
    expect(screen.getByTestId('message-list')).toHaveTextContent('半句回答')

    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-stop'))
    })

    expect(screen.getByTestId('composer-send')).toBeInTheDocument()
    expect(screen.queryByTestId('composer-stop')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-list')).toHaveTextContent('半句回答')
  })
})

describe('编辑 = 截断重发（服务端 + 客户端两边）', () => {
  it('编辑中间那条用户消息：先调服务端 truncate，再带着改过的历史重发', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    await act(async () => {
      send('第一个问题')
    })
    await act(async () => {
      control.push('答一')
      control.finish()
    })
    await act(async () => {
      send('第二个问题')
    })
    await act(async () => {
      control.push('答二')
      control.finish()
    })
    expect(control.requests).toHaveLength(2)

    const editedId = control.requests[0].messages[0].id
    expect(screen.getByTestId('message-list')).toHaveTextContent('第二个问题')

    fireEvent.click(screen.getAllByTestId('message-edit')[0])
    fireEvent.change(screen.getByTestId('message-edit-input'), {
      target: { value: '改过的第一个问题' }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('message-edit-save'))
    })

    await waitFor(() => {
      expect(control.requests).toHaveLength(3)
    })
    // 服务端先截断（R2），而且截断的就是被编辑的那条消息
    expect(truncateThread).toHaveBeenCalledWith(THREAD_ID, editedId)
    // 客户端截断：只留改过的那一条（同一个消息 id，替换而不是新增）；第二问与两条回答都不在历史里
    expect(control.requests[2].messages).toHaveLength(1)
    expect(control.requests[2].messages[0].id).toBe(editedId)
    expect(userTexts(control, 2)).toEqual(['改过的第一个问题'])
    expect(screen.queryByText('第二个问题')).not.toBeInTheDocument()
    expect(screen.queryByText('答二')).not.toBeInTheDocument()
  })

  it('服务端截断失败：不重发（两边历史不能不一致），给错误卡；点重试重做这一步', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    await act(async () => {
      send('原始问题')
    })
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

    // 没有发出第三轮请求，历史也保持原样
    await waitFor(() => {
      expect(screen.getByText(/没能在服务端同步/)).toBeInTheDocument()
    })
    expect(control.requests).toHaveLength(1)
    expect(screen.getByTestId('message-list')).toHaveTextContent('原始问题')

    // 重试：截断再来一次，成功后才重发
    fireEvent.click(screen.getByTestId('error-retry'))
    await waitFor(() => {
      expect(control.requests).toHaveLength(2)
    })
    expect(userTexts(control, 1)).toEqual(['改过的问题'])
  })

  it('取消编辑：不改历史、不发请求', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    await act(async () => {
      send('原始问题')
    })
    await act(async () => {
      control.push('答')
      control.finish()
    })

    fireEvent.click(screen.getByTestId('message-edit'))
    fireEvent.change(screen.getByTestId('message-edit-input'), {
      target: { value: '改了一半' }
    })
    fireEvent.click(screen.getByTestId('message-edit-cancel'))

    expect(screen.queryByTestId('message-edit-input')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-list')).toHaveTextContent('原始问题')
    expect(control.requests).toHaveLength(1)
    expect(truncateThread).not.toHaveBeenCalled()
  })

  it('流式中不给编辑入口（避免编辑触发的请求和当前这条流并发）', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    await act(async () => {
      send('问题')
    })
    expect(screen.queryByTestId('message-edit')).not.toBeInTheDocument()

    await act(async () => {
      control.push('答')
      control.finish()
    })
    expect(screen.getByTestId('message-edit')).toBeInTheDocument()
  })
})

describe('出错与重试', () => {
  it('流建立失败 → 错误卡；重试 = 整轮重生成（带上线程上下文）', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control).runtime)

    control.failNext(new TypeError('Failed to fetch'))
    await act(async () => {
      send('问题')
    })
    await waitFor(() => {
      expect(screen.getByTestId('error-card')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('error-retry'))

    await waitFor(() => {
      expect(control.requests).toHaveLength(2)
    })
    expect(control.requests[1].trigger).toBe('regenerate-message')
    expect(control.requests[1].body).toEqual({
      memory: { thread: THREAD_ID, resource: 'local-user' }
    })
  })

  it('正常收尾：onTurnEnd(threadId, isError=false, isAbort=false)', async () => {
    const control = createMockTransport()
    const runtime = makeRuntime(control)
    await renderSession(control, runtime.runtime, 'thread-ok')

    await act(async () => {
      send('问题')
    })
    await act(async () => {
      control.push('答')
      control.finish()
    })

    expect(runtime.onTurnEnd).toHaveBeenCalledWith('thread-ok', {
      isError: false,
      isAbort: false,
      awaitingApproval: false
    })
  })

  it('出错收尾：onTurnEnd(threadId, isError=true)', async () => {
    const control = createMockTransport()
    const runtime = makeRuntime(control)
    await renderSession(control, runtime.runtime, 'thread-fail')

    control.failNext(new TypeError('Failed to fetch'))
    await act(async () => {
      send('问题')
    })

    await waitFor(() => {
      expect(runtime.onTurnEnd).toHaveBeenCalledWith('thread-fail', {
        isError: true,
        isAbort: false,
        awaitingApproval: false
      })
    })
  })

  it('停止收尾：onTurnEnd(threadId, isAbort=true)——用户主动停止不是完成轮（T9⑤）', async () => {
    const control = createMockTransport()
    const runtime = makeRuntime(control)
    await renderSession(control, runtime.runtime, 'thread-stop')

    await act(async () => {
      send('问题')
    })
    await act(async () => {
      control.push('半句回答')
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('composer-stop'))
    })

    // 停止走的是 abort：onFinish 以 isAbort=true 触发，调用方据此不生成标题、不发完成通知
    await waitFor(() => {
      expect(runtime.onTurnEnd).toHaveBeenCalledWith('thread-stop', {
        isError: false,
        isAbort: true,
        awaitingApproval: false
      })
    })
    // 已生成的内容留着，状态回到可发送
    expect(screen.getByTestId('message-list')).toHaveTextContent('半句回答')
    expect(screen.getByTestId('composer-send')).toBeInTheDocument()
  })
})
