import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'
import { compactThread, fetchThreadCompaction, truncateThread } from '@renderer/lib/threads-api'
import { fetchThreadContext } from '@renderer/lib/usage-api'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * round 19 · 渲染端压缩链路：
 *   - 自动触发：最近一轮用量 ≥ 阈值（contextPct × contextWindow）→ 先压缩再发送；
 *     压缩失败照发 + 一行警示；低于阈值不压缩；
 *   - busy 语义：压缩中再次发送排入队列（照既有"流式中发送"口径）；
 *   - 顶部标记：有记录显示「上下文已压缩」（默认折叠，点开见摘要）；压缩中显示「上下文压缩中…」；
 *   - 「/」命令分区：首条「压缩上下文」带使用率；选中立即压缩并给 notice；流式中禁用；
 *   - 压缩后编辑重发（truncate → 重发）不受影响。
 *
 * 底层全走注入的假 transport 与假 runtime；threads-api / usage-api 整体 mock（真服务端行为
 * 由 mastra/__tests__/compaction.spec.ts 真跑）。
 */
vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => []),
  fetchThreadMessages: vi.fn(async () => []),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  truncateThread: vi.fn(async () => 2),
  generateThreadTitle: vi.fn(async () => ({ title: '', generated: false })),
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
}))

vi.mock('@renderer/lib/usage-api', () => ({
  fetchUsage: vi.fn(),
  fetchThreadContext: vi.fn(async () => ({
    threadId: 'thread-1',
    lastInput: null,
    lastCachedInput: null,
    baselineInput: null,
    todayInput: 0,
    todayCachedInput: 0
  }))
}))

const THREAD_ID = 'thread-1'
/** 阈值 = deepseek-v4-flash 128K × 100% */
const THRESHOLD = 128_000

const PROVIDER = {
  id: 'p1',
  name: 'p1',
  type: 'openai-compatible' as const,
  baseUrl: 'http://127.0.0.1:9/v1',
  model: 'deepseek-v4-flash',
  isDefault: true
}

const RECORD = {
  threadId: THREAD_ID,
  summary: '## 要点\n- 压缩出来的要点',
  summarized: 4,
  kept: 10,
  createdAt: '2026-10-11T02:00:00.000Z'
}

function contextOf(lastInput: number | null): {
  threadId: string
  lastInput: number | null
  lastCachedInput: number | null
  baselineInput: number | null
  todayInput: number
  todayCachedInput: number
} {
  return {
    threadId: THREAD_ID,
    lastInput,
    lastCachedInput: null,
    baselineInput: 1,
    todayInput: 0,
    todayCachedInput: 0
  }
}

function makeRuntime(
  control: MockTransport,
  history: { id: string; role: 'user' | 'assistant'; text: string }[] = []
): ThreadChatRuntime {
  return {
    transport: control.transport,
    loadHistory: vi.fn(async () =>
      history.map((message) => ({
        id: message.id,
        role: message.role,
        parts: [{ type: 'text' as const, text: message.text }]
      }))
    ),
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

function type(text: string): void {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
}

function send(text: string): void {
  type(text)
  fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
}

/** 真实键盘的"在末尾输入"：改值 + 光标置尾 + 派发 select（onSelect 重算触发） */
function typeAt(value: string): void {
  const input = screen.getByTestId('composer-input') as HTMLTextAreaElement
  fireEvent.change(input, { target: { value } })
  input.setSelectionRange(value.length, value.length)
  fireEvent.select(input)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

beforeEach(() => {
  resetThreadChats()
  vi.clearAllMocks()
  useSettingsStore.setState({
    settings: { ...defaultSettings(), providers: [PROVIDER] },
    loaded: true
  })
  vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(null))
  vi.mocked(fetchThreadCompaction).mockResolvedValue(null)
  vi.mocked(compactThread).mockResolvedValue({ compacted: false, compaction: null })
  vi.mocked(truncateThread).mockResolvedValue(2)
})

describe('自动触发（发送路径预检）', () => {
  it('用量 ≥ 阈值：先压缩、再发送（顺序断言；真环下降由服务端集成测试兜底）', async () => {
    const control = createMockTransport()
    const events: string[] = []
    const wrapped: MockTransport = {
      ...control,
      transport: {
        ...control.transport,
        async sendMessages(options) {
          events.push('send')
          return control.transport.sendMessages(options)
        }
      }
    }
    vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(THRESHOLD + 100))
    vi.mocked(compactThread).mockImplementation(async () => {
      events.push('compact')
      return { compacted: true, compaction: RECORD }
    })

    await renderSession(wrapped, makeRuntime(wrapped))
    await act(async () => {
      send('继续聊')
    })

    expect(events).toEqual(['compact', 'send'])
    expect(control.requests).toHaveLength(1)
    // 压缩成功：顶部标记随记录出现
    expect(screen.getByTestId('compaction-marker')).toHaveTextContent('上下文已压缩')
  })

  it('用量低于阈值：不压缩，直接发送', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(1_000))

    await renderSession(control, makeRuntime(control))
    await act(async () => {
      send('普通一轮')
    })

    expect(vi.mocked(compactThread)).not.toHaveBeenCalled()
    expect(control.requests).toHaveLength(1)
  })

  it('压缩失败：照常发送 + 一行警示（不阻塞对话）', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(THRESHOLD + 1))
    vi.mocked(compactThread).mockRejectedValue(new Error('模型这次没跑通'))

    await renderSession(control, makeRuntime(control))
    await act(async () => {
      send('还得发出去')
    })

    expect(control.requests).toHaveLength(1)
    expect(screen.getByTestId('composer-notice')).toHaveTextContent(
      '压缩失败：模型这次没跑通；已直接发送'
    )
  })

  it('用量取不到（服务没起来 / 记录未落）：不压缩，照常发送', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadContext).mockRejectedValue(new Error('no bridge'))

    await renderSession(control, makeRuntime(control))
    await act(async () => {
      send('降级发送')
    })

    expect(vi.mocked(compactThread)).not.toHaveBeenCalled()
    expect(control.requests).toHaveLength(1)
  })

  it('压缩进行中：再次发送被挡（按 busy 排入队列），压缩完成后依次发出', async () => {
    const control = createMockTransport()
    const gate = deferred<{ compacted: boolean; compaction: typeof RECORD }>()
    vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(THRESHOLD + 1))
    vi.mocked(compactThread).mockImplementation(() => gate.promise)

    await renderSession(control, makeRuntime(control))
    await act(async () => {
      send('第一条')
    })
    // 压缩中：标记显示进行中；第一条还没发出去
    expect(screen.getByTestId('compaction-marker')).toHaveTextContent('上下文压缩中…')
    expect(control.requests).toHaveLength(0)

    await act(async () => {
      send('第二条')
    })
    expect(control.requests).toHaveLength(0)
    expect(screen.getByTestId('composer-queue')).toHaveTextContent('已排队 1 条')

    await act(async () => {
      gate.resolve({ compacted: true, compaction: RECORD })
    })
    await waitFor(() => {
      expect(control.requests).toHaveLength(1)
    })

    // 第一条那一轮结束 → 队列里的第二条自动发出
    await act(async () => {
      control.push('答一')
      control.finish()
    })
    await waitFor(() => {
      expect(control.requests).toHaveLength(2)
    })
  })
})

describe('顶部「上下文已压缩」标记', () => {
  it('有记录：默认折叠（摘要不在 DOM），点开展开摘要与元数据；再点收起', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadCompaction).mockResolvedValue(RECORD)

    await renderSession(control, makeRuntime(control))
    await screen.findByTestId('compaction-marker')
    expect(screen.getByTestId('compaction-marker')).toHaveTextContent('上下文已压缩')
    expect(screen.queryByTestId('compaction-summary')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('compaction-toggle'))
    expect(screen.getByTestId('compaction-summary')).toHaveTextContent('压缩出来的要点')
    expect(screen.getByTestId('compaction-summary')).toHaveTextContent('已压缩 4 条消息')
    expect(screen.getByTestId('compaction-toggle')).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByTestId('compaction-toggle'))
    expect(screen.getByTestId('compaction-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  it('没有记录：不渲染标记', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control))
    expect(screen.queryByTestId('compaction-marker')).not.toBeInTheDocument()
  })
})

describe('「/」命令分区（手动入口）', () => {
  it('首条「压缩上下文」带当前使用率；选中立即压缩并给成功 notice', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(64_000)) // 64000/128000 = 50%
    vi.mocked(compactThread).mockResolvedValue({ compacted: true, compaction: RECORD })

    await renderSession(control, makeRuntime(control))
    typeAt('/')

    const row = await screen.findByTestId('suggest-command:compact')
    expect(row).toHaveTextContent('压缩上下文')
    expect(row).toHaveTextContent('已使用 50%')
    expect(screen.getByText('命令')).toBeInTheDocument()

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    await waitFor(() => {
      expect(vi.mocked(compactThread)).toHaveBeenCalledWith(THREAD_ID)
    })
    // 命令行不是引用标记：触发段整段移除，不插任何标记文本
    expect(screen.getByTestId('composer-input')).toHaveValue('')
    await waitFor(() => {
      expect(screen.getByTestId('composer-notice')).toHaveTextContent(
        '已压缩历史上下文（保留最近 10 条）'
      )
    })
  })

  it('流式中：命令行可见但禁用（点了/回车都没有动作）', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control))

    await act(async () => {
      send('先跑一轮')
    })
    typeAt('/压缩')

    const row = await screen.findByTestId('suggest-command:compact')
    expect(row).toBeDisabled()

    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    expect(vi.mocked(compactThread)).not.toHaveBeenCalled()
  })

  it('没有可压缩的旧消息：给一行提示（不假装压缩过）', async () => {
    const control = createMockTransport()
    vi.mocked(compactThread).mockResolvedValue({ compacted: false, compaction: null })

    await renderSession(control, makeRuntime(control))
    typeAt('/')
    await screen.findByTestId('suggest-command:compact')
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByTestId('composer-notice')).toHaveTextContent('当前没有可压缩的旧消息')
    })
  })
})

describe('压缩后的既有链条不回退', () => {
  it('编辑重发仍工作：truncate 先走、再带 messageId 重发', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadCompaction).mockResolvedValue(RECORD)
    const runtime = makeRuntime(control, [{ id: 'h1', role: 'user', text: '旧问题' }])

    await renderSession(control, runtime)
    expect(screen.getByTestId('compaction-marker')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('message-edit'))
    fireEvent.change(screen.getByTestId('message-edit-input'), {
      target: { value: '改过的问题' }
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('message-edit-save'))
    })

    await waitFor(() => {
      expect(vi.mocked(truncateThread)).toHaveBeenCalledWith(THREAD_ID, 'h1')
    })
    await waitFor(() => {
      expect(control.requests).toHaveLength(1)
    })
    expect(control.requests[0]?.messageId).toBe('h1')
  })
})
