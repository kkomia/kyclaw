import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatTransport, UIMessage } from 'ai'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { resetProjectsStore } from '@renderer/features/projects/projects-store'
import { SessionsController } from '@renderer/features/sessions/SessionsController'
import { resetSessionsStore, useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { createThread } from '@renderer/lib/threads-api'
import { defaultSettings, type AppSettings } from '@shared/settings'
import { createMockTransport, type MockTransport } from './mock-transport'

/**
 * round 49 · 发送即物化（用户实报：发送后、AI 回复前切走会话，侧栏那一行整个消失）。
 *
 * 消失的机制：侧栏的草稿行只在 activeId 还停在草稿上时渲染（composeSidebarSessions），而服务端
 * 镜像要等轮末（handleTurnEnd 的乐观插入 + refresh）才有它 —— 发送后切走，两边都不在。
 * 修复点：发送路径先物化（POST /api/threads，与"首条消息建线程"同一条存储路径）。
 *
 * 这里渲染的是**真侧栏**（SessionsController）+ 真对话页（ChatSession，注入假 transport/runtime）：
 * 底部两条路都 mock（threads-api / projects-api），服务端真行为由 mastra/__tests__/threads.spec 真跑。
 */
vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => [
    { id: 't-other', title: '别的会话', updatedAt: new Date().toISOString() }
  ]),
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

vi.mock('@renderer/lib/projects-api', () => ({
  fetchSessionProjects: vi.fn(async () => []),
  putSessionProject: vi.fn(async () => undefined)
}))

vi.mock('@renderer/lib/usage-api', () => ({
  fetchUsage: vi.fn(),
  fetchThreadContext: vi.fn(async () => ({
    threadId: 'draft',
    lastInput: null,
    lastCachedInput: null,
    baselineInput: null,
    todayInput: 0,
    todayCachedInput: 0
  }))
}))

const PROJECTS: AppSettings['projects'] = [
  { id: 'p1', name: '插件', path: 'D:\\ws\\插件', createdAt: '2026-10-11T00:00:00.000Z' }
]

/** 侧栏 + 对话页的宿主：会话切换 = activeId 变（与真应用同一条路：ChatPage 按 activeId 换挂） */
function Harness({
  transport,
  runtime
}: {
  transport: ChatTransport<UIMessage>
  runtime: ThreadChatRuntime
}): React.JSX.Element {
  const activeId = useSessionsStore((state) => state.activeId)
  return (
    <MemoryRouter>
      <SessionsController />
      {activeId === null ? null : (
        <ChatSession key={activeId} threadId={activeId} transport={transport} runtime={runtime} />
      )}
    </MemoryRouter>
  )
}

function makeRuntime(control: MockTransport): ThreadChatRuntime {
  return { transport: control.transport, loadHistory: vi.fn(async () => []), onTurnEnd: vi.fn() }
}

async function send(text: string): Promise<void> {
  fireEvent.change(screen.getByTestId('composer-input'), { target: { value: text } })
  fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' })
}

/** 首屏（别人的会话被选中）→ 在项目 p1 下开一个草稿 → 等对话页挂到草稿上 */
async function openDraftInProject(
  control: MockTransport,
  runtime: ThreadChatRuntime
): Promise<string> {
  render(<Harness transport={control.transport} runtime={runtime} />)
  await screen.findByTestId('session-item-t-other')

  let draftId = ''
  act(() => {
    draftId = useSessionsStore.getState().startNew('p1')
  })
  await screen.findByTestId('composer-input')
  await waitFor(() => {
    expect(screen.getByTestId(`session-item-${draftId}`)).toBeInTheDocument()
  })
  return draftId
}

beforeEach(() => {
  installKyclawBridge()
  resetSessionsStore()
  resetProjectsStore()
  resetThreadChats()
  useSettingsStore.setState({
    settings: { ...defaultSettings(), projects: PROJECTS },
    loaded: true
  })
  window.localStorage.clear()
})

afterEach(() => {
  clearKyclawBridge()
})

describe('发送即物化（round 49）', () => {
  it('发送时先把草稿落成真线程；AI 还没回就切走，侧栏那一行还在（项目分组里）', async () => {
    const control = createMockTransport()
    const draftId = await openDraftInProject(control, makeRuntime(control))
    // 草稿此刻确实挂在项目 p1 下
    expect(screen.getByTestId('project-sessions-p1')).toContainElement(
      screen.getByTestId(`session-item-${draftId}`)
    )

    await act(async () => {
      send('第一条消息')
    })

    // AI 还没回（流还开着）就切走：草稿行没了 activeId 兜底 —— 修复前这里就是用户看到的"整个会话没了"
    act(() => {
      useSessionsStore.getState().select('t-other')
    })
    await waitFor(() => {
      expect(screen.getByTestId(`session-item-${draftId}`)).toBeInTheDocument()
    })
    expect(screen.getByTestId('project-sessions-p1')).toContainElement(
      screen.getByTestId(`session-item-${draftId}`)
    )

    // 靠的是发送那一刻的物化：POST /api/threads 带的就是草稿 id，并进了服务端镜像；消息照发（没被挡）
    expect(vi.mocked(createThread)).toHaveBeenCalledWith(draftId, undefined)
    expect(useSessionsStore.getState().threads.some((thread) => thread.id === draftId)).toBe(true)
    expect(control.requests).toHaveLength(1)
  })

  it('物化失败不挡发送：消息照发、原始 error 落控制台（不留未处理 rejection）', async () => {
    const control = createMockTransport()
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(createThread).mockRejectedValueOnce(new Error('线程服务返回 500'))

    const draftId = await openDraftInProject(control, makeRuntime(control))
    await act(async () => {
      send('照发不误')
    })

    await waitFor(() => {
      expect(control.requests).toHaveLength(1)
    })
    expect(control.requests[0].body).toEqual({
      memory: { thread: draftId, resource: 'local-user' }
    })
    expect(errorLog).toHaveBeenCalledWith('[kyclaw] 会话物化失败（照常发送）', expect.any(Error))
    // 没物化成功，但会话还在（activeId 兜着草稿行；轮末 handleTurnEnd 还有乐观兜底）
    expect(screen.getByTestId(`session-item-${draftId}`)).toBeInTheDocument()

    errorLog.mockRestore()
  })
})
