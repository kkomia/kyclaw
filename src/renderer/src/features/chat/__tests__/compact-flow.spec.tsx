import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { resetSessionsStore } from '@renderer/features/sessions/sessions-store'
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
 *   - round 59：压缩是**对话流里的一件事** —— 有记录渲染一条分界线（左右发丝线 + 居中标签
 *     「上下文已压缩（before → ~after tokens）」+ 强调色「查看摘要」），位置按"压缩时刻之后
 *     到达的第一条消息"定位；压缩中同一位置显示「正在压缩上下文…」；
 *   - 「/」命令分区：首条「压缩上下文」带使用率；选中立即压缩（成功不再占用输入框 notice）；流式中禁用；
 *   - 压缩后编辑重发（truncate → 重发）不受影响；
 *   - round 57：作曲栏那枚「压缩上下文」胶囊（用量 ≥ 80% 时出现、点即压缩；每轮结束重取用量，
 *     低于出现线不渲染、没有数据不渲染、流式中禁用）。
 *
 * 底层全走注入的假 transport 与假 runtime；threads-api / usage-api 整体 mock（真服务端行为
 * 由 mastra/__tests__/compaction.spec.ts 真跑）。
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
  createdAt: '2026-10-11T02:00:00.000Z',
  // round 59：记录新增两个 token 字段（分界线标签的数字；after 是服务端的估算值）
  tokensBefore: 527_000,
  tokensAfter: 53_700
}

/** round 59：老记录（压缩时还没记 token 数）—— 标签只留「上下文已压缩」，括号整段不显示 */
const RECORD_WITHOUT_TOKENS = { ...RECORD, tokensBefore: null, tokensAfter: null }

/** 压缩记录时刻（用例里按它算"压缩前 / 压缩后"的存储时间戳） */
const AT = Date.parse(RECORD.createdAt)

/**
 * round 59：有压缩记录的会话在现实里**一定有消息**（保留窗口 ≥ 2 条，被摘要的旧消息才删掉）——
 * 空会话画的是初始页（见 welcome-hero.spec），分界线要有对话流才出现。这里给一句**带时间戳**的
 * 存储历史（压缩之前落库的），把会话摆成常态。
 */
function storedHistory(): UIMessage[] {
  return [messageOf('h0', 'user', '压之前聊过一句', AT - 60_000)]
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

/**
 * 回灌一条带时间的消息（round 59）：时间挂在 `metadata.createdAt` 上 —— 与 message-map 把存储
 * part 的 createdAt 映射出来的形态一致（不带时间 = 本轮新发的消息那种"未知时间"）。
 */
function messageOf(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  createdAt?: number
): UIMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    ...(createdAt === undefined ? {} : { metadata: { createdAt } })
  }
}

/** 消息列里的 DOM 顺序（Message 根节点与分界线的 testid；本轮新发消息的 id 是生成的，按位断言） */
function columnOrder(): string[] {
  const column = screen.getByTestId('message-list').firstElementChild as HTMLElement
  return Array.from(column.children).map((child) => child.getAttribute('data-testid') ?? '')
}

/** 直接给一批 UI 消息当历史（makeRuntime 那边只造纯文本 + 不带时间） */
function runtimeOf(control: MockTransport, messages: UIMessage[]): ThreadChatRuntime {
  return {
    transport: control.transport,
    loadHistory: vi.fn(async () => messages),
    onTurnEnd: vi.fn()
  }
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
  // round 62：排队队列与会话镜像都是模块级状态 —— 每条用例从干净的一份开始
  resetSessionsStore()
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
    // 压缩成功：分界线随记录出现在对话流里（数字口径 = before → ~after tokens）
    expect(screen.getByTestId('compaction-marker')).toHaveTextContent(
      '上下文已压缩（527k → ~53.7k tokens）'
    )
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
    // 压缩中：同一位置显示"正在压缩"；第一条还没发出去
    expect(screen.getByTestId('compaction-marker')).toHaveTextContent('正在压缩上下文…')
    expect(screen.getByTestId('compaction-marker')).toHaveAttribute('data-compacting', 'true')
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

describe('round 59 · 对话流里的「上下文已压缩」分界线', () => {
  it('一条分界线：左右发丝线 + 居中标签（before → ~after tokens）+ 强调色「查看摘要」', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadCompaction).mockResolvedValue(RECORD)

    await renderSession(control, runtimeOf(control, storedHistory()))
    const marker = await screen.findByTestId('compaction-marker')
    expect(marker).toHaveTextContent('上下文已压缩（527k → ~53.7k tokens）')
    // 分界线形态：细线在文字左右两侧（两段发丝线，装饰性）
    expect(marker.querySelectorAll('.bg-hairline')).toHaveLength(2)

    // 默认折叠：摘要不在 DOM；点「查看摘要」展开（内容与元数据行沿用 round 19）
    expect(screen.queryByTestId('compaction-summary')).not.toBeInTheDocument()
    const view = screen.getByTestId('compaction-view-summary')
    expect(view).toHaveTextContent('查看摘要')
    expect(view).toHaveClass('text-accent-text')
    expect(view).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(view)
    expect(screen.getByTestId('compaction-summary')).toHaveTextContent('压缩出来的要点')
    expect(screen.getByTestId('compaction-summary')).toHaveTextContent('已压缩 4 条消息')
    expect(screen.getByTestId('compaction-view-summary')).toHaveTextContent('收起摘要')
    expect(screen.getByTestId('compaction-view-summary')).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByTestId('compaction-view-summary'))
    expect(screen.getByTestId('compaction-view-summary')).toHaveAttribute('aria-expanded', 'false')
  })

  it('老记录（没有 token 数）：括号整段不显示，只留「上下文已压缩」', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadCompaction).mockResolvedValue(RECORD_WITHOUT_TOKENS)

    await renderSession(control, runtimeOf(control, storedHistory()))
    const marker = await screen.findByTestId('compaction-marker')
    expect(marker).toHaveTextContent('上下文已压缩')
    expect(marker).not.toHaveTextContent('tokens')
  })

  it('没有记录：不渲染分界线', async () => {
    const control = createMockTransport()
    await renderSession(control, runtimeOf(control, storedHistory()))
    expect(screen.queryByTestId('compaction-marker')).not.toBeInTheDocument()
  })

  it('位置 = 压缩时刻之后到达的第一条消息之前（重开会话按时间重算）', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadCompaction).mockResolvedValue(RECORD)

    await renderSession(
      control,
      runtimeOf(control, [
        messageOf('h1', 'user', '压之前的老问题', AT - 60_000),
        messageOf('h2', 'assistant', '压之后的新回答', AT + 1_000)
      ])
    )
    await screen.findByTestId('message-h2')

    expect(columnOrder()).toEqual(['message-h1', 'compaction-marker', 'message-h2'])
  })

  it('刚压完（消息都在压缩时刻之前）：分界线落在列表末尾（贴近输入框）', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadCompaction).mockResolvedValue(RECORD)

    await renderSession(
      control,
      runtimeOf(control, [
        messageOf('h1', 'user', '问题', AT - 60_000),
        messageOf('h2', 'assistant', '回答', AT - 30_000)
      ])
    )
    await screen.findByTestId('message-h2')

    expect(columnOrder()).toEqual(['message-h1', 'message-h2', 'compaction-marker'])
  })

  it('重开会话后本轮新发一条：分界线停在它之前（未知时间按"不早于压缩"算）', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadCompaction).mockResolvedValue(RECORD)

    // 真实形态：回灌的存储消息都早于压缩时刻（压缩保留了它们），本轮新发的没有时间戳
    await renderSession(
      control,
      runtimeOf(control, [
        messageOf('h1', 'user', '压之前的老问题', AT - 60_000),
        messageOf('h2', 'assistant', '压缩后保留的回答', AT - 30_000)
      ])
    )
    await screen.findByTestId('message-h2')
    expect(columnOrder()).toEqual(['message-h1', 'message-h2', 'compaction-marker'])

    await act(async () => {
      send('重开后的新问题')
    })
    // 新消息排在分界线**下面**（旧的"继承前一条已知时间"会把分界线一路漂到末尾、盖住新消息）
    const order = columnOrder()
    expect(order.slice(0, 3)).toEqual(['message-h1', 'message-h2', 'compaction-marker'])
    expect(order).toHaveLength(4)
    expect(order[3]).toMatch(/^message-/)
  })

  it('本轮先发过消息再手动压缩：分界线锚在"压缩那一刻在手的消息之后"，之后新发仍排在它下面', async () => {
    const control = createMockTransport()
    vi.mocked(compactThread).mockResolvedValue({ compacted: true, compaction: RECORD })

    await renderSession(
      control,
      runtimeOf(control, [
        messageOf('h1', 'user', '压之前的老问题', AT - 60_000),
        messageOf('h2', 'assistant', '压之前的老回答', AT - 30_000)
      ])
    )
    // 先跑一轮：本轮新发的消息在客户端**没有时间戳**（真实形态），但它们确实存在于压缩之前
    await act(async () => {
      send('本地新发的一句')
    })
    await act(async () => {
      control.push('答一')
      control.finish()
    })

    // 手动压缩（「/」→ 压缩上下文）
    typeAt('/')
    await screen.findByTestId('suggest-command:compact')
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    })
    await screen.findByTestId('compaction-marker')

    // 两条历史 + 本轮新发的 user/assistant 都在压缩之前 → 分界线钉在它们之后（锚点冻结）
    const frozen = columnOrder()
    expect(frozen).toHaveLength(5)
    expect(frozen[0]).toBe('message-h1')
    expect(frozen[4]).toBe('compaction-marker')

    // 之后新发的消息排在分界线下面（锚点不动）
    await act(async () => {
      send('压完再发一句')
    })
    const grown = columnOrder()
    expect(grown).toHaveLength(6)
    expect(grown[4]).toBe('compaction-marker')
    expect(grown[5]).toMatch(/^message-/)
  })

  it('压缩后编辑重发（消息变少）：锚点 clamp 到当前条数，分界线不会被挤出列表', async () => {
    const control = createMockTransport()
    vi.mocked(compactThread).mockResolvedValue({ compacted: true, compaction: RECORD })

    await renderSession(
      control,
      runtimeOf(control, [
        messageOf('h1', 'user', '旧问题', AT - 60_000),
        messageOf('h2', 'assistant', '旧回答', AT - 30_000)
      ])
    )
    // 手动压缩 → 锚点 = 当时 2 条
    typeAt('/')
    await screen.findByTestId('suggest-command:compact')
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    })
    await screen.findByTestId('compaction-marker')
    expect(columnOrder()).toEqual(['message-h1', 'message-h2', 'compaction-marker'])

    // 编辑重发 h1：服务端截断 + 客户端只剩改过的那条（1 条 < 锚点 2）
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

    const order = columnOrder()
    expect(order[order.length - 1]).toBe('compaction-marker')
    expect(order.filter((id) => id === 'compaction-marker')).toHaveLength(1)
  })
})

describe('「/」命令分区（手动入口）', () => {
  it('首条「压缩上下文」带当前使用率；选中立即压缩（成功进对话流，不占输入框 notice）', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(64_000)) // 64000/128000 = 50%
    vi.mocked(compactThread).mockResolvedValue({ compacted: true, compaction: RECORD })

    await renderSession(control, runtimeOf(control, storedHistory()))
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
    // round 59：成功的表现是对话流里那条分界线 —— 输入框区**没有**任何提示行
    await waitFor(() => {
      expect(screen.getByTestId('compaction-marker')).toHaveTextContent('上下文已压缩')
    })
    expect(screen.queryByTestId('composer-notice')).not.toBeInTheDocument()
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

describe('round 57 · 作曲栏「压缩上下文」胶囊（不输入也能压缩）', () => {
  it('用量 ≥ 80%：胶囊出现；点一下就走压缩（不用在输入框打字）', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(110_000)) // 110000/128000 ≈ 86%
    vi.mocked(compactThread).mockResolvedValue({ compacted: true, compaction: RECORD })

    await renderSession(control, runtimeOf(control, storedHistory()))
    const chip = await screen.findByTestId('composer-compact')
    expect(chip).toHaveTextContent('压缩上下文')
    expect(chip).toBeEnabled()

    fireEvent.click(chip)

    await waitFor(() => {
      expect(vi.mocked(compactThread)).toHaveBeenCalledWith(THREAD_ID)
    })
    // round 59：分界线随记录出现在对话流里；输入框区没有提示行；全程一条消息都没发出去
    await waitFor(() => {
      expect(screen.getByTestId('compaction-marker')).toHaveTextContent('上下文已压缩')
    })
    expect(screen.queryByTestId('composer-notice')).not.toBeInTheDocument()
    expect(control.requests).toHaveLength(0)
  })

  it('用量 < 80%：不出现；一轮结束后用量越过出现线才露面（每轮结束重取一次）', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(64_000)) // 64000/128000 = 50%

    await renderSession(control, makeRuntime(control))
    await act(async () => {})
    expect(vi.mocked(fetchThreadContext)).toHaveBeenCalled()
    expect(screen.queryByTestId('composer-compact')).not.toBeInTheDocument()

    // 又跑一轮：服务端用量涨到 86%（< 阈值 100%，不触发自动压缩），这一轮里按钮还不该出现
    vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(110_000))
    await act(async () => {
      send('再聊一轮')
    })
    expect(screen.queryByTestId('composer-compact')).not.toBeInTheDocument()

    // 轮结束 → 取数刷新 → 用量越过 80% → 按钮露面
    await act(async () => {
      control.push('答一')
      control.finish()
    })
    expect(await screen.findByTestId('composer-compact')).toBeInTheDocument()
  })

  it('还没有用量记录（lastInput = null）：不出现', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(null))

    await renderSession(control, makeRuntime(control))
    await act(async () => {})

    expect(vi.mocked(fetchThreadContext)).toHaveBeenCalled()
    expect(screen.queryByTestId('composer-compact')).not.toBeInTheDocument()
  })

  it('取数失败（服务没起来 / 单测未装桥）：不出现（不闪假状态）', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadContext).mockRejectedValue(new Error('no bridge'))

    await renderSession(control, makeRuntime(control))
    await act(async () => {})

    expect(screen.queryByTestId('composer-compact')).not.toBeInTheDocument()
  })

  it('压缩进行中：胶囊显示「压缩中…」并禁用；压完回到常态', async () => {
    const control = createMockTransport()
    const gate = deferred<{ compacted: boolean; compaction: typeof RECORD }>()
    vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(110_000))
    vi.mocked(compactThread).mockImplementation(() => gate.promise)

    await renderSession(control, makeRuntime(control))
    fireEvent.click(await screen.findByTestId('composer-compact'))

    const busy = await screen.findByTestId('composer-compact')
    expect(busy).toHaveTextContent('压缩中…')
    expect(busy).toBeDisabled()

    await act(async () => {
      gate.resolve({ compacted: true, compaction: RECORD })
    })
    await waitFor(() => {
      expect(screen.getByTestId('composer-compact')).toHaveTextContent('压缩上下文')
    })
  })

  it('流式中（compactDisabled）：胶囊可见但禁用，点了没有动作', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadContext).mockResolvedValue(contextOf(110_000)) // 86% < 阈值：不走自动压缩

    await renderSession(control, makeRuntime(control))
    await screen.findByTestId('composer-compact')

    await act(async () => {
      send('先跑一轮')
    })

    const chip = screen.getByTestId('composer-compact')
    expect(chip).toBeDisabled()
    fireEvent.click(chip)
    expect(vi.mocked(compactThread)).not.toHaveBeenCalled()
  })
})

/**
 * round 62（P0）：`dispatch` 置 `sending.current = true` 之后，还要 await 物化、await 取用量、
 * 可能整轮压缩，才真正 `sendMessage` —— 这段窗口里 `busy` 还是 false（动作行照旧画着、
 * `/压缩上下文` 照旧可点），但撤回 / 编辑重发 / 压缩都要在服务端动历史，放行就会与在途的发送
 * 并发写同一份历史。闸门因此多一档 `sending.current`（**执行时**现读的 ref；动作行的显隐仍由
 * state 决定，观感不变）。
 */
describe('round 62 · 动作闸门（发送预检在途）', () => {
  it('预检还没回来时点撤回 / 压缩：一个都不动服务端历史；预检放开后闸门恢复', async () => {
    const control = createMockTransport()
    await renderSession(control, makeRuntime(control))

    // 先跑完一轮：消息动作行得有东西可点
    await act(async () => {
      send('第一问')
    })
    await act(async () => {
      control.push('答一')
      control.finish()
    })
    const firstUserId = control.requests[0].messages[0].id

    // 第二次发送：把预检里那次用量取数挂住 —— dispatch 已置 sending.current，sendMessage 还没发
    const gate = deferred<Awaited<ReturnType<typeof fetchThreadContext>>>()
    vi.mocked(fetchThreadContext).mockReturnValueOnce(gate.promise)
    await act(async () => {
      send('第二问')
    })
    expect(control.requests).toHaveLength(1)

    // 撤回：动作行还在（状态上不忙），但闸门挡住服务端截断
    fireEvent.click(screen.getByTestId('message-undo'))
    await act(async () => {
      fireEvent.click(await screen.findByTestId('message-undo-confirm'))
    })
    expect(vi.mocked(truncateThread)).not.toHaveBeenCalled()

    // `/` 命令里的「压缩上下文」：同样被挡住（命令行本身是可点的 —— 拦在执行时）
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '/' } })
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
    expect(vi.mocked(compactThread)).not.toHaveBeenCalled()

    // 预检放开：这条消息照常发出（闸门拦的是"动历史"，不是发送本身）
    await act(async () => {
      gate.resolve(contextOf(null))
    })
    await waitFor(() => expect(control.requests).toHaveLength(2))

    // 轮末之后闸门恢复：撤回照常做（不是永久锁死）
    await act(async () => {
      control.push('答二')
      control.finish()
    })
    fireEvent.click(screen.getAllByTestId('message-undo')[0] as HTMLElement)
    await act(async () => {
      fireEvent.click(await screen.findByTestId('message-undo-confirm'))
    })
    await waitFor(() =>
      expect(vi.mocked(truncateThread)).toHaveBeenCalledWith(THREAD_ID, firstUserId)
    )
  })
})

describe('压缩后的既有链条不回退', () => {
  it('编辑重发仍工作：truncate 先走、再带 messageId 重发', async () => {
    const control = createMockTransport()
    vi.mocked(fetchThreadCompaction).mockResolvedValue(RECORD)
    const runtime = makeRuntime(control, [{ id: 'h1', role: 'user', text: '旧问题' }])

    await renderSession(control, runtime)
    // 满载下挂载读取（fetchThreadCompaction → setCompaction）可能还没刷进 React：等它出现，不做同步断言
    await screen.findByTestId('compaction-marker')

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
