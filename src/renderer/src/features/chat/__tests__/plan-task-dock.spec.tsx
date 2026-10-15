import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPlan } from '@shared/plan'
import { ChatPage } from '@renderer/features/chat/ChatPage'
import { rendererPlansStore } from '@renderer/features/chat/plan-runtime'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import { resetComposerCarryover } from '@renderer/features/chat/composer-carryover'
import { resetProjectsStore } from '@renderer/features/projects/projects-store'
import { resetSessionsStore } from '@renderer/features/sessions/sessions-store'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { tasksStore } from '@renderer/lib/tasks-store'
import { defaultSettings } from '@shared/settings'

/**
 * round 85（用户实报 016 问题二）：**进了规划模式，任务清单就在**（两者是包含关系）。
 *
 * 这里走真对话页（ChatPage）：规划状态从 store 来、任务清单那一格由 ChatPage 接在
 * TaskDockSlot 上 —— 钉的是"接线"这一层（规划中 = 铺出来），格子自己的行为见
 * task-integration.spec。
 */
const THREAD_ID = 'plan-thread'

const planStateApi = vi.hoisted(() => ({
  state: null as SessionPlan | null
}))

vi.mock('@renderer/lib/plans-api', () => ({
  PlansApiError: class PlansApiError extends Error {},
  plansApi: {
    get: async (threadId: string) => ({
      state:
        planStateApi.state ??
        ({
          threadId,
          version: 1,
          mode: 'normal',
          planId: null,
          revision: 0,
          body: null,
          feedback: null,
          approval: null,
          updatedAt: '2026-10-15T00:00:00.000Z'
        } satisfies SessionPlan),
      ref: null
    }),
    enter: vi.fn(async () => ({ state: null, ref: null })),
    decision: vi.fn(async () => ({ state: null, ref: null })),
    cancel: vi.fn(async () => ({ state: null, ref: null })),
    resumeRequest: vi.fn(async () => ({
      url: 'http://127.0.0.1:1/plans/resume',
      init: { method: 'POST' as const, headers: {}, body: '{}' }
    }))
  }
}))

vi.mock('@renderer/lib/tasks-api', () => ({
  tasksApi: {
    get: vi.fn(async () => ({ revision: 0, updatedAt: null, items: [] })),
    put: vi.fn(async () => ({ status: 'ok' }))
  }
}))

vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => [
    { id: 'plan-thread', title: '规划会话', updatedAt: '2026-10-15T00:00:00.000Z' }
  ]),
  fetchThreadMessages: vi.fn(async () => []),
  createThread: vi.fn(async (id: string) => ({ id, title: null, updatedAt: '' })),
  renameThread: vi.fn(),
  deleteThread: vi.fn(),
  truncateThread: vi.fn(async () => 0),
  generateThreadTitle: vi.fn(async () => ({ title: '', generated: false })),
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
}))

vi.mock('@renderer/lib/projects-api', () => ({
  fetchSessionProjects: vi.fn(async () => []),
  putSessionProject: vi.fn(async () => undefined)
}))

vi.mock('@renderer/lib/usage-api', () => ({
  fetchUsage: vi.fn(),
  fetchThreadContext: vi.fn(async () => ({
    threadId: THREAD_ID,
    lastInput: null,
    lastCachedInput: null,
    baselineInput: null,
    todayInput: 0,
    todayCachedInput: 0
  }))
}))

vi.mock('@renderer/lib/ask-user-api', async (original) => ({
  ...(await original<typeof import('@renderer/lib/ask-user-api')>()),
  fetchPendingAskUser: vi.fn(async () => [])
}))

beforeEach(() => {
  resetThreadChats()
  resetSessionsStore()
  resetComposerCarryover()
  resetProjectsStore()
  planStateApi.state = null
  rendererPlansStore.getState().forget(THREAD_ID)
  // 任务清单的收起状态住在模块级 store 里（跨用例留着）：每条用例从头开始（收起、无快照）——
  // round 86 起"进规划会自动展开"，用例之间不重置的话下一条一开场就是展开的
  tasksStore.getState().forget(THREAD_ID)
  installKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
})

afterEach(() => {
  clearKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

function planningState(): SessionPlan {
  return {
    threadId: THREAD_ID,
    version: 2,
    mode: 'planning',
    planId: null,
    revision: 0,
    body: null,
    feedback: null,
    approval: null,
    updatedAt: '2026-10-15T00:00:00.000Z'
  }
}

/** 真对话页渲染 + 等到实例就绪（下面各组用例共用） */
function renderChat(): void {
  render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>
  )
}

async function ready(): Promise<void> {
  await screen.findByTestId('composer-input')
  await waitFor(() => expect(screen.queryByTestId('composer-pending')).not.toBeInTheDocument())
}

/** 服务器那条状态变成"规划中"，页面重新取到它 */
async function enterPlanning(): Promise<void> {
  planStateApi.state = planningState()
  await rendererPlansStore.getState().load(THREAD_ID)
}

describe('round 85 · 规划模式下任务清单的可见性（对话页接线）', () => {
  it('进入规划模式：没有任务也把任务清单那一格铺出来（摘要 + 展开把手）；普通模式不铺', async () => {
    renderChat()

    // 就绪之后：普通模式（plans 回包是 normal）→ 没任务、收起 = 整块不渲染（原有口径）
    await ready()
    expect(screen.queryByTestId('task-dock-slot')).not.toBeInTheDocument()

    // 服务器那条状态变成"规划中"（用户点了 ＋ 菜单的「进入规划模式」，或页面重新取到状态）
    await enterPlanning()

    const card = await screen.findByTestId('task-list-dock')
    expect(card).toHaveTextContent('任务清单')
    expect(screen.getByTestId('plan-mode-chip')).toHaveTextContent('规划中')
  })
})

/**
 * round 86（用户实报 016 问题二的后半）：**进入规划模式的那一刻自动展开** ——
 * 上一轮只做到"规划里这一格不消失"，用户还得再点一下展开把手才看得见清单。
 *
 * 两条一起钉：① 主动进规划 = 展开；② 之后用户手动收起，**不许再被自动顶开**（每次渲染都强开的话，
 * 收起状态就形同虚设：plan 状态一有回包就会被顶回去）。收起状态只有一个来源：tasks-store 的
 * `collapsed`（界面上的 `task-list-dock[data-collapsed]` 就是它）。
 */
describe('round 86 · 进规划自动展开任务清单（只认"进规划"那一次上升沿）', () => {
  it('进规划就展开（不用再点一下把手）；回到普通模式后按 collapsed 说话', async () => {
    renderChat()
    await ready()
    expect(screen.queryByTestId('task-list-dock')).not.toBeInTheDocument()

    await enterPlanning()

    const card = await screen.findByTestId('task-list-dock')
    expect(card).toHaveAttribute('data-collapsed', 'false')
    expect(screen.getByTestId('task-dock-toggle')).toHaveAttribute('aria-expanded', 'true')

    // 回到普通模式：没任务 + 已展开 = 这一格照旧铺着（收起与否由 collapsed 说了算，不是模式说了算）
    planStateApi.state = { ...planningState(), mode: 'normal' }
    await rendererPlansStore.getState().load(THREAD_ID)
    await waitFor(() => expect(screen.queryByTestId('plan-mode-chip')).not.toBeInTheDocument())
    expect(screen.getByTestId('task-list-dock')).toHaveAttribute('data-collapsed', 'false')
  })

  it('用户手动收起之后不再自动弹开（规划状态再有回包也不顶开）', async () => {
    renderChat()
    await ready()
    await enterPlanning()

    const card = await screen.findByTestId('task-list-dock')
    // 起点：进规划自动展开的那一态
    expect(card).toHaveAttribute('data-collapsed', 'false')
    // 手动收起 = 点摘要行那把把手（唯一来源仍是 tasks-store 的 collapsed）
    fireEvent.click(screen.getByTestId('task-dock-toggle'))
    expect(card).toHaveAttribute('data-collapsed', 'true')

    // 规划状态再来一份（同模式、新一轮取数：页面上会重新渲染）：不许把它顶开
    await rendererPlansStore.getState().load(THREAD_ID)
    await waitFor(() => expect(screen.getByTestId('plan-mode-chip')).toHaveTextContent('规划中'))
    expect(screen.getByTestId('task-list-dock')).toHaveAttribute('data-collapsed', 'true')
  })

  it('先手动收起、再真的重新进规划：那一次上升沿仍然要展开', async () => {
    renderChat()
    await ready()
    await enterPlanning()

    fireEvent.click(screen.getByTestId('task-dock-toggle'))
    expect(screen.getByTestId('task-list-dock')).toHaveAttribute('data-collapsed', 'true')

    // 回普通模式：手动收起 + 没任务 → 这一格整块消失（原有口径）
    planStateApi.state = { ...planningState(), mode: 'normal' }
    await rendererPlansStore.getState().load(THREAD_ID)
    await waitFor(() => expect(screen.queryByTestId('task-list-dock')).not.toBeInTheDocument())

    // 再进规划 = 又一次"进规划那一刻"：照样自动展开
    await enterPlanning()
    await waitFor(() =>
      expect(screen.getByTestId('task-list-dock')).toHaveAttribute('data-collapsed', 'false')
    )
  })
})

/**
 * round 86 的判据收口：**只有"读到过非规划 → 规划"才算上升沿**。
 *
 * 计划状态是异步读来的（没缓存的 thread 第一眼是 `state: null`），所以"页面刚打开"与
 * "用户主动进规划"在数据上长得一样（都是 null → 规划中）。前者不该动用户那份收起状态 ——
 * `collapsed` 就住在 tasks-store 里，跨切会话留着，页面重开时把它抹成展开等于把用户的选择删了。
 */
describe('round 86 · 页面打开时不替用户展开（持久收起留着）', () => {
  it('首次加载一条本来就在规划里的会话：这一格在，但按 tasks-store 的收起状态说话', async () => {
    // 服务器那边本来就是规划中（用户上次进过规划），任务清单此前被用户收起过（默认就是收起）
    planStateApi.state = planningState()

    renderChat()
    await ready()

    expect(await screen.findByTestId('plan-mode-chip')).toHaveTextContent('规划中')
    const card = await screen.findByTestId('task-list-dock')
    expect(card).toHaveAttribute('data-collapsed', 'true')
    expect(screen.getByTestId('task-dock-toggle')).toHaveAttribute('aria-expanded', 'false')
  })

  it('切回一条计划状态已经读过的规划会话：也不顶开用户收起的那份', async () => {
    planStateApi.state = planningState()
    await rendererPlansStore.getState().load(THREAD_ID)
    tasksStore.getState().setCollapsed(THREAD_ID, true)

    renderChat()
    await ready()

    expect(await screen.findByTestId('task-list-dock')).toHaveAttribute('data-collapsed', 'true')
  })
})
