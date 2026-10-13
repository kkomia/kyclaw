import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { truncateThread } from '@renderer/lib/threads-api'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * 消息动作行（round 61）：
 *   - 助手消息：「复制」（正文 parts 的拼接，不含思考/工具/文件；成功不弹文字，图标转对勾）、
 *     「重新生成」（**只有最后一条助手消息**；先 truncate 这条助手消息、再 regenerate）；
 *   - 用户消息：「编辑」（既有，R2）+「撤回」（二次确认 → 服务端 truncate → 客户端移除这条及
 *     之后的 UI 消息 → 原文回到输入框）；
 *   - 闸门：流式中 / 等审批 / 压缩中整行不出现（与「编辑」同一道）。
 * round 63：四个动作都是**图标按钮**（钮上零文字、名字只在 aria-label / title 上）——
 * 用例因此按 testid + 无障碍名查，并且每题都钉住"钮里没有可见文字"。
 * 全部走真实交互路径（点动作钮 / 确认弹窗），底层注入假 transport + 假 runtime，
 * threads-api 整体 mock（服务端截断的真行为由 threads.spec 跑）。
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
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
}))

const THREAD_ID = 'thread-actions'

async function renderSession(control: MockTransport, runtime?: ThreadChatRuntime): Promise<void> {
  render(
    <MemoryRouter>
      <ChatSession
        transport={control.transport}
        threadId={THREAD_ID}
        runtime={
          runtime ?? {
            transport: control.transport,
            loadHistory: async () => [],
            onTurnEnd: () => {}
          }
        }
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

/** 图标按钮里那枚 svg 的 class（lucide 会带上 `lucide-<名字>`，用来断言换了哪枚图标） */
function iconOf(button: HTMLElement): string {
  return button.querySelector('svg')?.getAttribute('class') ?? ''
}

/** 完成一轮对话（发出去 → 推一段回答 → 收尾） */
async function turn(control: MockTransport, question: string, answer: string): Promise<void> {
  await act(async () => {
    send(question)
  })
  await act(async () => {
    control.push(answer)
    control.finish()
  })
}

/** 点开某条用户消息的「撤回」并确认（返回确认弹窗里的两个钮，方便各自断言） */
async function openUndo(messageId: string): Promise<void> {
  fireEvent.click(within(screen.getByTestId(`message-${messageId}`)).getByTestId('message-undo'))
  await screen.findByTestId('message-undo-confirm')
}

/** 列表里最后一条助手消息的 id（从 DOM 读，避免猜 useChat 分给消息的随机 id） */
function lastAssistantId(): string {
  const articles = screen.getByTestId('message-list').querySelectorAll('[data-role="assistant"]')
  const last = articles[articles.length - 1]
  return (last.getAttribute('data-testid') ?? '').replace(/^message-/, '')
}

beforeEach(() => {
  resetThreadChats()
  vi.mocked(truncateThread).mockClear()
  vi.mocked(truncateThread).mockResolvedValue(2)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('助手消息动作行', () => {
  it('一轮跑完才出现；复制的是正文 parts 的拼接（不含思考/工具）；点了图标转对勾、不弹文字', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    const control = createMockTransport()
    await renderSession(control)

    await act(async () => {
      send('问题')
    })
    // 流式中的那条没有动作行（内容还在长）
    expect(screen.queryByTestId('message-copy')).not.toBeInTheDocument()

    await act(async () => {
      control.reason('先想一想')
      control.toolInput('t1', 'read_file', { path: 'a.md' })
      control.push('回答第一段')
      control.push('，第二段')
      control.finish()
    })

    const copy = await screen.findByTestId('message-copy')
    // 图标按钮：钮上零可见文字，语义只在 aria-label / title（round 63）
    expect(copy).toHaveTextContent('')
    expect(copy).toHaveAttribute('aria-label', '复制')
    expect(copy).toHaveAttribute('title', '复制')
    expect(iconOf(copy)).toContain('lucide-copy')

    // 复制内容 = 正文 parts（思考与工具调用都不在里头）
    vi.useFakeTimers()
    fireEvent.click(copy)
    await act(async () => {})
    expect(writeText).toHaveBeenCalledWith('回答第一段，第二段')
    // 成功反馈只有图标（对勾）与无障碍名的变化，依旧零可见文字
    const copied = screen.getByTestId('message-copy')
    expect(iconOf(copied)).toContain('lucide-check')
    expect(copied).toHaveAttribute('aria-label', '已复制')
    expect(copied).toHaveTextContent('')

    act(() => {
      vi.advanceTimersByTime(1500)
    })
    const restored = screen.getByTestId('message-copy')
    expect(iconOf(restored)).toContain('lucide-copy')
    expect(restored).toHaveAttribute('aria-label', '复制')
  })

  it('纯工具轮（没有正文）不给「复制」空钮；「重新生成」照旧出现', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await act(async () => {
      send('干个活')
    })
    await act(async () => {
      control.toolInput('t1', 'read_file', { path: 'a.md' })
      control.finish()
    })

    expect(screen.queryByTestId('message-copy')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-regenerate')).toBeInTheDocument()
  })

  it('「重新生成」只在最后一条助手消息上：先 truncate 这一条（服务端），再 regenerate', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await turn(control, '第一问', '答一')
    await turn(control, '第二问', '答二')

    // 两条助手回复，只有最后一条带「重新生成」
    expect(screen.getAllByTestId('message-regenerate')).toHaveLength(1)
    const targetId = lastAssistantId()
    expect(screen.getByTestId('message-regenerate').closest('article')).toHaveAttribute(
      'data-testid',
      `message-${targetId}`
    )

    // 调用序：先服务端 truncate 这条助手消息，再走 regenerate 请求
    const order: string[] = []
    vi.mocked(truncateThread).mockImplementation(async () => {
      order.push('truncate')
      return 2
    })
    const requests = control.requests.length
    await act(async () => {
      fireEvent.click(screen.getByTestId('message-regenerate'))
    })

    await waitFor(() => {
      expect(control.requests.length).toBe(requests + 1)
    })
    order.push('request')
    expect(order).toEqual(['truncate', 'request'])
    expect(vi.mocked(truncateThread)).toHaveBeenCalledWith(THREAD_ID, targetId)
    expect(control.requests[requests].trigger).toBe('regenerate-message')
  })

  it('闸门：流式中动作行整个不出现（复制与重新生成都没有）', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await act(async () => {
      send('问题')
    })
    await act(async () => {
      control.push('答')
    })

    const assistant = screen.getByTestId('message-list').querySelector('[data-role="assistant"]')
    expect(assistant).not.toBeNull()
    expect(within(assistant as HTMLElement).queryByTestId('message-copy')).not.toBeInTheDocument()
    expect(
      within(assistant as HTMLElement).queryByTestId('message-regenerate')
    ).not.toBeInTheDocument()

    await act(async () => {
      control.finish()
    })
    expect(screen.getByTestId('message-copy')).toBeInTheDocument()
  })
})

describe('用户消息「撤回」', () => {
  it('取消：什么都不做（不截断、消息还在、输入框不填）', async () => {
    const control = createMockTransport()
    await renderSession(control)
    await turn(control, '原始问题', '答')

    const userId = control.requests[0].messages[0].id
    await openUndo(userId)
    fireEvent.click(screen.getByTestId('message-undo-cancel'))

    expect(screen.queryByTestId('message-undo-confirm')).not.toBeInTheDocument()
    expect(vi.mocked(truncateThread)).not.toHaveBeenCalled()
    expect(screen.getByTestId('message-list')).toHaveTextContent('原始问题')
    expect(screen.getByTestId('composer-input')).toHaveValue('')
    expect(control.requests).toHaveLength(1)
  })

  it('确认：服务端 truncate 这条 → 这条及之后的 UI 消息消失 → 原文回到输入框', async () => {
    const control = createMockTransport()
    await renderSession(control)
    await turn(control, '第一问', '答一')
    await turn(control, '第二问', '答二')

    const firstUserId = control.requests[0].messages[0].id
    await openUndo(firstUserId)
    await act(async () => {
      fireEvent.click(screen.getByTestId('message-undo-confirm'))
    })

    // 截断的是被撤回的那条（服务端存储是权威；客户端只在成功之后才动）
    await waitFor(() =>
      expect(vi.mocked(truncateThread)).toHaveBeenCalledWith(THREAD_ID, firstUserId)
    )
    await waitFor(() => {
      const list = screen.getByTestId('message-list')
      expect(list).not.toHaveTextContent('第一问')
      expect(list).not.toHaveTextContent('答一')
      expect(list).not.toHaveTextContent('第二问')
      expect(list).not.toHaveTextContent('答二')
    })
    // 原文放回输入框（含这条之后被移除的内容都不进输入框）
    expect(screen.getByTestId('composer-input')).toHaveValue('第一问')
    // 没有新请求发出：撤回不是"重发"
    expect(control.requests).toHaveLength(2)
  })

  it('只撤回最后一条：前面的对话原样留着', async () => {
    const control = createMockTransport()
    await renderSession(control)
    await turn(control, '第一问', '答一')
    await turn(control, '第二问', '答二')

    const secondUserId = control.requests[1].messages[2].id
    await openUndo(secondUserId)
    await act(async () => {
      fireEvent.click(screen.getByTestId('message-undo-confirm'))
    })

    await waitFor(() =>
      expect(vi.mocked(truncateThread)).toHaveBeenCalledWith(THREAD_ID, secondUserId)
    )
    await waitFor(() => {
      const list = screen.getByTestId('message-list')
      expect(list).toHaveTextContent('第一问')
      expect(list).toHaveTextContent('答一')
      expect(list).not.toHaveTextContent('第二问')
      expect(list).not.toHaveTextContent('答二')
    })
    expect(screen.getByTestId('composer-input')).toHaveValue('第二问')
  })

  it('服务端截断失败：不静默（错误卡说明是撤回没做成），消息还在；重试重做这一步', async () => {
    const control = createMockTransport()
    await renderSession(control)
    await turn(control, '原始问题', '答')

    const userId = control.requests[0].messages[0].id
    vi.mocked(truncateThread).mockRejectedValueOnce(new Error('线程服务返回 500'))
    await openUndo(userId)
    await act(async () => {
      fireEvent.click(screen.getByTestId('message-undo-confirm'))
    })

    await waitFor(() => {
      expect(screen.getByText(/已取消撤回/)).toBeInTheDocument()
    })
    expect(screen.getByTestId('message-list')).toHaveTextContent('原始问题')
    expect(screen.getByTestId('composer-input')).toHaveValue('')

    // 重试：截断再来一次，成功后才移除 + 回填原文
    await act(async () => {
      fireEvent.click(screen.getByTestId('error-retry'))
    })
    await waitFor(() => expect(vi.mocked(truncateThread)).toHaveBeenCalledTimes(2))
    await waitFor(() => {
      expect(screen.getByTestId('message-list')).not.toHaveTextContent('原始问题')
    })
    expect(screen.getByTestId('composer-input')).toHaveValue('原始问题')
  })

  it('闸门：流式中不给「撤回」（与「编辑」同一道）', async () => {
    const control = createMockTransport()
    await renderSession(control)

    await act(async () => {
      send('问题')
    })
    expect(screen.queryByTestId('message-undo')).not.toBeInTheDocument()

    await act(async () => {
      control.push('答')
      control.finish()
    })
    // 两枚都是图标按钮：钮上零文字，名字在 aria-label / title，图标各自就位
    const undo = screen.getByTestId('message-undo')
    expect(undo).toHaveAttribute('aria-label', '撤回')
    expect(undo).toHaveAttribute('title', '撤回')
    expect(undo).toHaveTextContent('')
    expect(iconOf(undo)).toContain('lucide-undo-2')
    // 既有「编辑」照旧（也一样是图标按钮）
    const edit = screen.getByTestId('message-edit')
    expect(edit).toHaveAttribute('aria-label', '编辑')
    expect(edit).toHaveAttribute('title', '编辑')
    expect(edit).toHaveTextContent('')
    expect(iconOf(edit)).toContain('lucide-pencil')
  })
})
