import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { ThreadSummary } from '@shared/threads'
import { ChatPage, ChatSession, PENDING_THREAD_ID } from '@renderer/features/chat/ChatPage'
import { resetComposerCarryover } from '@renderer/features/chat/composer-carryover'
import { resetThreadChats, type ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { resetSessionsStore, useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { fetchThreadMessages, fetchThreads } from '@renderer/lib/threads-api'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { resetProjectsStore } from '@renderer/features/projects/projects-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'
import { fetchSessionProjects } from '@renderer/lib/projects-api'
import { createMockTransport } from './mock-transport'

vi.mock('@renderer/lib/projects-api', () => ({
  fetchSessionProjects: vi.fn(async () => []),
  putSessionProject: vi.fn(async () => undefined)
}))

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

const askUserApi = vi.hoisted(() => ({ pending: vi.fn(async () => []) }))
vi.mock('@renderer/lib/ask-user-api', async (original) => ({
  ...(await original<typeof import('@renderer/lib/ask-user-api')>()),
  fetchPendingAskUser: askUserApi.pending
}))

/**
 * R92 · 草稿过桥的**保留边界**（用户口诉的 e2e 间歇失败根因修复的回归）。
 *
 * 背景（v4 取证，2026-10-16）：冷启动"未就绪挂 → 会话落位换 key 重挂"这一段里，若
 * **输入（fill/键入）与"重挂"落在同一批提交**，那一挂的 `draft` state 更新会随组件一起被
 * React 丢掉，而受控恢复（restore）又把输入框的值按旧 state 写回 —— 用户刚敲的字
 * 在 DOM 上"活了 ~200ms 后被吞"，过桥的卸载 cleanup 抄到的是空值 → 新挂空输入 → 发送钮
 * 永久禁用（e2e 里表现为 8s/30s 超时）。
 *
 * 三条边界（本文件钉住）：
 *   1. 同批重挂 + 回写吞值：字要由"写入时的记录"兜住（不丢）；
 *   2. 用户主动**新建会话**：未就绪挂的草稿**不许**带进新会话（不泄露）；
 *   3. 用户主动**切换其他会话**：同上（不泄露）；
 *   4. 反向防回归：系统初始化落位（列表载入选定的那条）**要**把草稿带过去（原有承诺不破）。
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function runtimeWith(history: () => Promise<UIMessage[]>): ThreadChatRuntime {
  const control = createMockTransport()
  return { transport: control.transport, loadHistory: vi.fn(history), onTurnEnd: vi.fn() }
}

function input(): HTMLTextAreaElement {
  return screen.getByTestId('composer-input') as HTMLTextAreaElement
}

beforeEach(() => {
  resetThreadChats()
  resetSessionsStore()
  resetComposerCarryover()
  resetProjectsStore()
  vi.mocked(fetchSessionProjects).mockClear()
  vi.mocked(fetchThreads).mockClear()
})

afterEach(() => {
  clearKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

describe('R92 · 会话落位重挂的草稿过桥：不丢、也不跨会话泄露', () => {
  it('DOM 被受控回写清掉（同批重挂吞掉 state 的实测产物）：用户刚敲的字由写入记录兜住', async () => {
    const runtime = runtimeWith(async () => [])
    const real = 'thread-real'
    const { rerender } = render(
      <MemoryRouter>
        <ChatSession
          key={PENDING_THREAD_ID}
          transport={runtime.transport}
          threadId={null}
          runtime={runtime}
        />
      </MemoryRouter>
    )
    const first = await screen.findByTestId('composer-input')

    // 用户输入（onChange 正常收下：写入记录与 state 都拿到这半句）
    await act(async () => {
      fireEvent.change(first, { target: { value: '半句' } })
    })
    expect(first).toHaveValue('半句')

    // 构造 e2e 实测的那一步产物（v4 #11）：受控恢复把输入框按旧 state 写回空，
    // 紧接着换 key 重挂 —— 卸载时 DOM 已经是空的了。
    // （"同批吞 state"这一步在 jsdom 的 fireEvent 路径不可复现（探路 P1-P3），这里直接
    //   构造它的产物：DOM 空、而"写入时的记录"是唯一还记得用户敲了什么的地方。）
    await act(async () => {
      ;(first as HTMLTextAreaElement).value = ''
      rerender(
        <MemoryRouter>
          <ChatSession key={real} transport={runtime.transport} threadId={real} runtime={runtime} />
        </MemoryRouter>
      )
    })

    const bridged = input()
    expect(bridged).not.toBe(first)
    expect(bridged).toHaveValue('半句')
  }, 15_000)

  it('未就绪挂上用户点「新建会话」：草稿不许带进新会话', async () => {
    installKyclawBridge()
    window.kyclaw.agent.endpoint = vi.fn(
      async () => ({ baseUrl: 'http://127.0.0.1:9', token: 'tok' }) as const
    )
    const threads = deferred<ThreadSummary[]>()
    vi.mocked(fetchThreads).mockImplementationOnce(() => threads.promise)

    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>
    )

    // 占位挂（列表还没回，activeId 未定）：能打字
    const first = await screen.findByTestId('composer-input')
    await act(async () => {
      fireEvent.change(first, { target: { value: '半句' } })
    })
    expect(first).toHaveValue('半句')

    // 用户主动新建会话（= startNew 这条用户入口）：换了会话，草稿不该跟过去
    await act(async () => {
      useSessionsStore.getState().startNew()
    })
    await waitFor(() => expect(screen.getByTestId('composer-input')).not.toBe(first))
    expect(input()).toHaveValue('')
  }, 15_000)

  it('用户主动切到另一个会话：前一个会话的草稿不许带过去', async () => {
    installKyclawBridge()
    window.kyclaw.agent.endpoint = vi.fn(
      async () => ({ baseUrl: 'http://127.0.0.1:9', token: 'tok' }) as const
    )
    // 甲/乙的历史都挂着：落位挂保持"未就绪"（这正是"卸载时 pending 非空 → 会留草稿"的那一档）
    const history = deferred<Awaited<ReturnType<typeof fetchThreadMessages>>>()
    vi.mocked(fetchThreadMessages).mockImplementation(() => history.promise)
    vi.mocked(fetchThreads).mockResolvedValueOnce([
      { id: 'thread-a', title: '甲', updatedAt: '2026-10-16T00:00:00.000Z' },
      { id: 'thread-b', title: '乙', updatedAt: '2026-10-15T00:00:00.000Z' }
    ])

    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>
    )

    // 列表回来 → 系统落位到最近一条（甲）；甲的历史还挂着（未就绪挂）：期间能打字
    const first = await screen.findByTestId('composer-input')
    await waitFor(() => expect(useSessionsStore.getState().activeId).toBe('thread-a'))
    await act(async () => {
      fireEvent.change(first, { target: { value: '半句' } })
    })
    expect(first).toHaveValue('半句')
    expect(screen.getByTestId('composer-pending')).toHaveTextContent('正在载入会话…')

    // 用户主动切到乙：甲的草稿不该出现在乙的输入框里
    await act(async () => {
      useSessionsStore.getState().select('thread-b')
    })
    await waitFor(() => expect(screen.getByTestId('composer-input')).not.toBe(first))
    expect(input()).toHaveValue('')
  }, 15_000)

  it('反向防回归：系统初始化落位（列表选定最近一条）要把草稿带过去', async () => {
    installKyclawBridge()
    window.kyclaw.agent.endpoint = vi.fn(
      async () => ({ baseUrl: 'http://127.0.0.1:9', token: 'tok' }) as const
    )
    const threads = deferred<ThreadSummary[]>()
    vi.mocked(fetchThreads).mockImplementationOnce(() => threads.promise)

    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>
    )

    const first = await screen.findByTestId('composer-input')
    await act(async () => {
      fireEvent.change(first, { target: { value: '冷启动里敲的半句' } })
    })

    // 列表回来（系统落位）→ 换 key 重挂 → 同一段冷启动的草稿跟着走
    await act(async () => {
      threads.resolve([])
    })
    await waitFor(() => expect(screen.getByTestId('composer-input')).not.toBe(first))
    expect(input()).toHaveValue('冷启动里敲的半句')
  }, 15_000)
})
