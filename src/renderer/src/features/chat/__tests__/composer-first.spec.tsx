import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UIMessage } from 'ai'
import type { ThreadSummary } from '@shared/threads'
import { ChatPage, ChatSession, PENDING_THREAD_ID } from '@renderer/features/chat/ChatPage'
import { resetComposerCarryover } from '@renderer/features/chat/composer-carryover'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { resetSessionsStore } from '@renderer/features/sessions/sessions-store'
import { fetchThreads } from '@renderer/lib/threads-api'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { createMockTransport, type MockTransport } from './mock-transport'
import { resetProjectsStore } from '@renderer/features/projects/projects-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'
import { fetchSessionProjects } from '@renderer/lib/projects-api'

vi.mock('@renderer/lib/projects-api', () => ({
  fetchSessionProjects: vi.fn(async () => []),
  putSessionProject: vi.fn(async () => undefined)
}))

/**
 * 待答问题（ask-user）走 HTTP（`/ask-user/pending`）——本文件给一份**有效空响应**的桩（`[]`）：
 * 这里的用例只关心"输入卡先出来 / 端点失败 → 错误卡 → 重试"，不该因为一条打不通的取数
 * 在页脚多出一张错误卡来（那不是本用例要验证的错误）。与 ask-user-flow.spec 同一手法。
 */
const askUserApi = vi.hoisted(() => ({ pending: vi.fn(async () => []) }))
vi.mock('@renderer/lib/ask-user-api', async (original) => ({
  ...(await original<typeof import('@renderer/lib/ask-user-api')>()),
  fetchPendingAskUser: askUserApi.pending
}))

/**
 * round 76 · **输入卡先出来**（冷启动的观感账）。
 *
 * 现状问题（用户口径）：输入卡原来是这条链的**最后一环** —— 端点解析 → 会话列表 → 历史回灌，
 * 三样都完了才挂输入卡，"能输入"被压在最后（生产 bundle 加载快，更容易撞上冷启动竞态）。
 *
 * 本轮契约：
 *   1. 输入卡从这一屏**第一帧**就在（能聚焦、能打字）；
 *   2. 会话实例就绪之前，发送**一律挡住**（按钮禁用 + 回车不发），并在工具条那一行写明原因
 *      （"正在连接…" / "正在载入会话…"）——不留"看着能发、按了没反应"的状态；
 *   3. 就绪之后自动恢复可发，**草稿与焦点一个字不丢**（载入中途那段也不丢）；
 *   4. 出错的档照旧给错误卡 + 重试，只是**不再把输入卡一起卸掉**。
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

const THREAD_ID = 'thread-ready'

/** 手动的 promise：用例自己决定"这一口什么时候回来" */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function runtimeWith(
  control: MockTransport,
  loadHistory: () => Promise<UIMessage[]>
): ThreadChatRuntime {
  return { transport: control.transport, loadHistory: vi.fn(loadHistory), onTurnEnd: vi.fn() }
}

function input(): HTMLTextAreaElement {
  return screen.getByTestId('composer-input') as HTMLTextAreaElement
}

/** 请求里用户消息的文本（断言"发出去的是什么"） */
function userTexts(control: MockTransport, index: number): string[] {
  return control.requests[index].messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.parts)
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
}

beforeEach(() => {
  resetThreadChats()
  resetSessionsStore()
  resetComposerCarryover()
  resetProjectsStore()
  vi.mocked(fetchSessionProjects).mockClear()
})

afterEach(() => {
  clearKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

it('只挂 ChatPage 也加载项目映射，权限入口随有效项目根恢复', async () => {
  const mappings = deferred<Awaited<ReturnType<typeof fetchSessionProjects>>>()
  const initial = {
    ...defaultSettings(),
    workspaces: [
      { path: 'D:\\project', mode: 'ask' as const },
      { path: 'E:\\other', mode: 'ask' as const }
    ],
    projects: [
      { id: 'p1', name: '项目', path: 'D:\\project', createdAt: '2026-10-13T00:00:00.000Z' }
    ]
  }
  installKyclawBridge(initial)
  useSettingsStore.setState({ settings: initial, loaded: true })
  vi.mocked(fetchThreads).mockResolvedValueOnce([
    { id: THREAD_ID, title: '项目会话', updatedAt: '2026-10-13T00:00:00.000Z' }
  ])
  vi.mocked(fetchSessionProjects).mockImplementationOnce(() => mappings.promise)
  render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>
  )
  await waitFor(() => expect(fetchSessionProjects).toHaveBeenCalledOnce())
  // 映射还没到：入口**照旧在**（同一枚下拉），只是工作区还没定下来 → 下拉里是说明 + 指路，
  // 没有可切的档位（用户实报过"权限模式选择按钮不见了"，这一档正是它消失的地方）
  const undecided = screen.getByTestId('composer-permission')
  expect(undecided).toHaveTextContent('权限模式')
  fireEvent.keyDown(undecided, { key: 'ArrowDown' })
  expect(screen.getByTestId('composer-permission-reason')).toHaveTextContent(
    '会话的工作区还没定下来'
  )
  expect(screen.getByTestId('composer-workspace-settings')).toHaveTextContent('打开工作区设置')
  fireEvent.keyDown(document.body, { key: 'Escape' })
  await act(async () => mappings.resolve([{ threadId: THREAD_ID, projectId: 'p1' }]))
  await waitFor(() =>
    expect(screen.getByTestId('composer-permission')).toHaveTextContent('每次询问')
  )
})

describe('历史回灌之前：输入卡就在，发送挡着', () => {
  it('能聚焦能打字；回车不发、按钮禁用、工具条写明「正在载入会话…」；历史回来后就绪且草稿不丢', async () => {
    const control = createMockTransport()
    const history = deferred<UIMessage[]>()
    render(
      <MemoryRouter>
        <ChatSession
          transport={control.transport}
          threadId={THREAD_ID}
          runtime={runtimeWith(control, () => history.promise)}
        />
      </MemoryRouter>
    )

    // **输入卡立刻就在**（不用等历史回灌 —— 这就是本轮的目标）
    const composerInput = await screen.findByTestId('composer-input')
    expect(screen.getByTestId('chat-loading')).toBeInTheDocument()
    expect(screen.getByTestId('composer-pending')).toHaveTextContent('正在载入会话…')
    expect(screen.getByTestId('composer-send')).toBeDisabled()

    // 就地能打字（不是禁用态输入框）
    composerInput.focus()
    fireEvent.change(composerInput, { target: { value: '半句话' } })
    expect(composerInput).toHaveValue('半句话')
    expect(document.activeElement).toBe(composerInput)

    // 回车：不发（挡板生效），草稿一个字不动
    await act(async () => {
      fireEvent.keyDown(composerInput, { key: 'Enter' })
    })
    expect(control.requests).toHaveLength(0)
    expect(composerInput).toHaveValue('半句话')

    // 历史回来 → 就绪：占位退场、状态行收起、输入卡还是同一只（不重挂）、草稿还在
    await act(async () => {
      history.resolve([{ id: 'h1', role: 'user', parts: [{ type: 'text', text: '上次聊到哪了' }] }])
    })
    await waitFor(() => {
      expect(screen.queryByTestId('composer-pending')).not.toBeInTheDocument()
    })
    expect(screen.queryByTestId('chat-loading')).not.toBeInTheDocument()
    expect(screen.getByTestId('message-list')).toHaveTextContent('上次聊到哪了')
    expect(screen.getByTestId('composer-input')).toBe(composerInput)
    expect(composerInput).toHaveValue('半句话')

    // 就绪之后照常能发（还是那条草稿）
    await act(async () => {
      fireEvent.keyDown(composerInput, { key: 'Enter' })
    })
    expect(control.requests).toHaveLength(1)
    expect(userTexts(control, 0)).toEqual(['上次聊到哪了', '半句话'])
  })

  it('就绪那一刻才落位成初始页：就绪前不是初始页（标题/行都不在），就绪后一起进场', async () => {
    const control = createMockTransport()
    const history = deferred<UIMessage[]>()
    render(
      <MemoryRouter>
        <ChatSession
          transport={control.transport}
          threadId={THREAD_ID}
          runtime={runtimeWith(control, () => history.promise)}
        />
      </MemoryRouter>
    )

    await screen.findByTestId('composer-input')
    // 还没就绪：不算初始页（标题不渲染、占位不收上去）——输入框先落在常规位置
    expect(screen.queryByTestId('welcome-hero')).not.toBeInTheDocument()
    expect(screen.getByTestId('welcome-spacer')).toHaveClass('grow-0')
    expect(screen.queryByTestId('composer-project-row-collapse')).not.toBeInTheDocument()

    await act(async () => {
      history.resolve([])
    })
    await waitFor(() => {
      expect(screen.getByTestId('welcome-hero')).toHaveAttribute('data-active', 'true')
    })
    // 落位：标题进场、占位撑开、选择项目行展开（2026-10-18 A · 信笺重定基线，
    // 卡片中心下移到 mock 的 ≈478 ⇒ mt-28/112 收到 mt-12/48；推导见 ChatPage 注释）
    expect(screen.getByTestId('welcome-spacer')).toHaveClass('grow', 'mt-12')
    expect(screen.getByTestId('composer-project-row-collapse')).toHaveAttribute(
      'data-active',
      'true'
    )
    expect(screen.queryByTestId('composer-capabilities')).not.toBeInTheDocument()
    expect(screen.queryByTestId('composer-ppt-template')).not.toBeInTheDocument()
  })
})

describe('冷启动：端点还没回来', () => {
  it('服务晚 800ms 起来：输入卡先在（「正在连接…」+ 发送挡着），全程不进错误卡，草稿与焦点过桥留下', async () => {
    installKyclawBridge()
    // 端点这一口 800ms 才回来（= 内嵌服务起来）；会话列表也压着（真机上它排在端点之后）
    window.kyclaw.agent.endpoint = vi.fn(
      () =>
        new Promise<{ baseUrl: string; token: string }>((resolve) => {
          setTimeout(() => resolve({ baseUrl: 'http://127.0.0.1:9', token: 'tok' }), 800)
        })
    )
    const threads = deferred<ThreadSummary[]>()
    vi.mocked(fetchThreads).mockImplementationOnce(() => threads.promise)

    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>
    )

    // 第一帧就有输入卡：能聚焦、能打字
    const first = await screen.findByTestId('composer-input')
    first.focus()
    fireEvent.change(first, { target: { value: '冷启动里敲的半句' } })
    expect(document.activeElement).toBe(first)
    expect(screen.getByTestId('composer-pending')).toHaveTextContent('正在连接…')
    expect(screen.getByTestId('composer-send')).toBeDisabled()
    expect(screen.queryByTestId('error-card')).not.toBeInTheDocument()

    // 端点回来（服务起来了）→ 会话列表这才有结果 → 会话 id 定下来：这一挂按 key 换挂
    await waitFor(
      () => {
        expect(screen.getByTestId('composer-pending')).toHaveTextContent('正在载入会话…')
      },
      { timeout: 5000 }
    )
    await act(async () => {
      threads.resolve([])
    })
    await waitFor(() => {
      expect(screen.queryByTestId('composer-pending')).not.toBeInTheDocument()
    })

    // 重挂之后是**新节点**：草稿与焦点由 composer-carryover 过桥带走
    const bridged = input()
    expect(bridged).not.toBe(first)
    expect(bridged).toHaveValue('冷启动里敲的半句')
    expect(document.activeElement).toBe(bridged)
    // 全过程没有错误卡：服务晚起不再等于"进错误卡 + 手动重试"
    expect(screen.queryByTestId('error-card')).not.toBeInTheDocument()
  }, 15_000)

  it('端点失败：错误卡 + 重试就在消息区，输入卡与草稿都还在（不再整页换成错误卡）', async () => {
    installKyclawBridge()
    const endpoint = vi.fn().mockRejectedValue(new Error('agent 服务未启动'))
    window.kyclaw.agent.endpoint = endpoint

    render(
      <MemoryRouter>
        <ChatPage />
      </MemoryRouter>
    )

    await screen.findByTestId('composer-input')
    expect(await screen.findByTestId('error-card')).toHaveTextContent('agent 服务未启动')

    // 出错档也一样能写（发送挡着，错误卡在那儿说为什么）
    await act(async () => {
      fireEvent.change(input(), { target: { value: '先写着' } })
    })
    expect(input()).toHaveValue('先写着')
    expect(screen.getByTestId('composer-send')).toBeDisabled()

    // 重试：端点这次通了 → 错误卡退场，输入卡与草稿都在
    endpoint.mockResolvedValue({ baseUrl: 'http://127.0.0.1:9', token: 'tok' })
    await act(async () => {
      fireEvent.click(screen.getByTestId('error-retry'))
    })
    await waitFor(() => {
      expect(screen.queryByTestId('error-card')).not.toBeInTheDocument()
    })
    expect(input()).toHaveValue('先写着')
  }, 15_000)
})

/**
 * 冷启动的**这一条顺序**：端点先回来（transport 到手），会话列表（`fetchThreads`）后回来。
 *
 * 这段窗口里会发生的事，正是"草稿过桥"要守的：
 *   - 会话 id 没定之前（`activeId === null`）这一挂**不会自己就绪** —— `ready` 要"真会话 id"
 *     （`threadId !== null`），占位那一挂的 `pending` 一直是它（`正在载入会话…`）；
 *     这条不变量同时就是过桥判据一定成立的原因（卸载时 `pending` 非空 → 一定留草稿）。
 *     拿它钉住：**改动它等于改动过桥的前提**，必须回头复核 composer-carryover 的边界。
 *   - 列表回来 → `activeId` 定成真 id → ChatPage 换 key 重挂 → 草稿/焦点由过桥带走。
 */
describe('冷启动：端点先到、会话 id 后到（同一个会话，换 key 重挂）', () => {
  it('期间能打字；会话 id 定下来的那一下换挂，草稿一个字不丢', async () => {
    installKyclawBridge()
    // 端点这一条链很快（本用例压的是"会话列表比它就绪得更晚"）
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
    expect(first).toHaveValue('冷启动里敲的半句')

    // 给"占位那一挂自己就绪"留出机会（端点已回、被 mock 的历史回灌瞬时返回）：它不会就绪
    await act(async () => {
      await new Promise((done) => setTimeout(done, 50))
    })
    expect(screen.getByTestId('composer-pending')).toHaveTextContent('正在载入会话…')
    expect(screen.getByTestId('composer-send')).toBeDisabled()
    expect(input()).toBe(first)

    // 会话列表这才回来 → activeId 定成真 id → 整挂换 key 重挂
    await act(async () => {
      threads.resolve([])
    })
    await waitFor(() => expect(screen.queryByTestId('chat-loading')).not.toBeInTheDocument())

    // 换挂前后是同一段冷启动、同一个会话：用户敲下的字不许被吞
    const bridged = input()
    expect(bridged).not.toBe(first)
    expect(bridged).toHaveValue('冷启动里敲的半句')
  }, 15_000)

  /**
   * 同一段冷启动，但**改动与"换 key 重挂"落在同一批提交上**（React 会把同一个 tick 里来的
   * 多个更新合成一次提交）：那一挂的 `draft` state 更新与那一挂一起被丢掉 —— 卸载那一刻
   * `draftRef.current`（只在下一次提交的 effect 里才同步）还是空的。
   *
   * 所以过桥的**取值来源**不能是那个 ref：必须以**输入框当前的真实值**为准（用户敲下的东西
   * 就在 DOM 里）。这条用例把这条口径钉死：卸载前改草稿、同批重挂，草稿照样要过来。
   */
  it('改动与重挂同批提交：草稿也要过桥带走（不许拿过期的 state ref 当来源）', async () => {
    const control = createMockTransport()
    const runtime = runtimeWith(control, async () => [])
    const real = 'thread-real'
    const { rerender } = render(
      <MemoryRouter>
        <ChatSession
          key={PENDING_THREAD_ID}
          transport={control.transport}
          threadId={null}
          runtime={runtime}
        />
      </MemoryRouter>
    )

    const first = await screen.findByTestId('composer-input')
    const firstValue = first as HTMLTextAreaElement

    await act(async () => {
      fireEvent.change(first, { target: { value: '冷启动里敲的半句' } })
      // 同批：换 key 重挂（真 id 到了）
      rerender(
        <MemoryRouter>
          <ChatSession key={real} transport={control.transport} threadId={real} runtime={runtime} />
        </MemoryRouter>
      )
    })

    const bridged = input()
    expect(bridged).not.toBe(first)
    // 注释里说明"改动的 state 还没落地"：DOM 上确实已经有那半句（这就是过桥该抄的值）
    expect(firstValue.value).toBe('冷启动里敲的半句')
    expect(bridged).toHaveValue('冷启动里敲的半句')
  }, 15_000)

  /**
   * 这一条钉的是**过桥的取值来源**：抄"输入框现在真实写着什么"，不是抄 `draft` state 的镜像
   * （`draftRef` 只在下一次提交的 effect 里才同步）。
   *
   * 场景就是实测到过的那种失配形状：**用户敲下的字在输入框里，但 state 这一侧没跟上**
   * （实机冷启动那一次：值在 DOM 上活了约 200ms、随后被 React 按 state 写回空、发送钮
   * 因为"没内容"一直禁用）。这里把这个形状**直接造出来**（只写 DOM 的 value、不派发 input，
   * 于是 onChange/state 都不会动），再让这一挂按 key 重挂 —— 过桥必须以 DOM 为准，
   * 否则用户看得见的字就这么没了。
   */
  it('state 没跟上（DOM 有字、state 空）时重挂：过桥以输入框的真实内容为准', async () => {
    const control = createMockTransport()
    const runtime = runtimeWith(control, async () => [])
    const real = 'thread-real'
    const { rerender } = render(
      <MemoryRouter>
        <ChatSession
          key={PENDING_THREAD_ID}
          transport={control.transport}
          threadId={null}
          runtime={runtime}
        />
      </MemoryRouter>
    )

    const first = await screen.findByTestId('composer-input')
    // 只写 DOM（不派发 input）：这就是"用户看得见、而 state 还不知道"的那一刻
    ;(first as HTMLTextAreaElement).value = '冷启动里敲的半句'
    expect(screen.getByTestId('composer-send')).toBeDisabled()

    await act(async () => {
      rerender(
        <MemoryRouter>
          <ChatSession key={real} transport={control.transport} threadId={real} runtime={runtime} />
        </MemoryRouter>
      )
    })

    const bridged = input()
    expect(bridged).not.toBe(first)
    expect(bridged).toHaveValue('冷启动里敲的半句')
  }, 15_000)
})
