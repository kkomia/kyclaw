/**
 * 对话 / 轨迹 两个页签（本轮新增的一等视图）：切页不硬切、两块内容都在文档里、
 * 轨迹层只在自己被选中时取数。
 *
 * 走的是 ChatSession 这条真路径（页签在 ChatHeader 上、状态在 ChatSession 里），
 * 底层数据层 mock 掉（轨迹服务端行为由 mastra 的 route spec 真跑）。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSession } from '@renderer/features/chat/ChatPage'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import type { ThreadChatRuntime } from '@renderer/features/chat/thread-chats'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { resetSessionsStore, useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { resetProjectsStore } from '@renderer/features/projects/projects-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'
import type { StoredMessage } from '@shared/threads'
import { createMockTransport, type MockTransport } from './mock-transport'

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

vi.mock('@renderer/lib/trajectory-api', () => ({
  fetchThreadUsageRuns: vi.fn(async () => [])
}))

vi.mock('@renderer/lib/projects-api', () => ({
  fetchSessionProjects: vi.fn(async () => []),
  putSessionProject: vi.fn(async () => undefined)
}))

import { fetchThreadMessages } from '@renderer/lib/threads-api'

const THREAD_ID = 'thread-1'

const STORED: StoredMessage[] = [
  {
    id: 'u1',
    role: 'user',
    createdAt: '2026-10-13T06:00:00.000Z',
    content: { format: 2, parts: [{ type: 'text', text: '你好', createdAt: 1791871200000 }] }
  } as unknown as StoredMessage
]

function runtime(): ThreadChatRuntime {
  return {
    transport: { sendMessages: vi.fn() } as unknown as ThreadChatRuntime['transport'],
    loadHistory: vi.fn(async () => []),
    onTurnEnd: vi.fn()
  } as unknown as ThreadChatRuntime
}

let control: MockTransport

async function mountSession(): Promise<void> {
  installKyclawBridge(defaultSettings())
  useSettingsStore.setState({ settings: defaultSettings(), loaded: true })
  useSessionsStore.setState({
    threads: [{ id: THREAD_ID, title: '会话甲', updatedAt: '2026-10-13T06:00:00.000Z' }],
    activeId: THREAD_ID,
    loaded: true,
    error: null,
    notices: {}
  })
  vi.mocked(fetchThreadMessages).mockResolvedValue(STORED)
  control = createMockTransport()

  render(
    <MemoryRouter>
      <ChatSession transport={control.transport} threadId={THREAD_ID} runtime={runtime()} />
    </MemoryRouter>
  )
  await screen.findByTestId('composer-input')
}

beforeEach(() => {
  resetThreadChats()
  resetSessionsStore()
  resetProjectsStore()
  vi.mocked(fetchThreadMessages).mockClear()
})

afterEach(() => {
  clearKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

describe('对话 / 轨迹 页签', () => {
  it('两枚页签都在头部；缺省停在「对话」', async () => {
    await mountSession()

    expect(screen.getByTestId('view-tab-chat')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('view-tab-trajectory')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('trajectory-layer')).not.toHaveAttribute('data-active')
    // 轨迹页签没被选中：一次请求都不发（懒取）
    expect(vi.mocked(fetchThreadMessages)).not.toHaveBeenCalled()
  })

  it('页签固定在头部右端（右上角）、标题占剩余空间 —— 不回标题旁边（用户口径：切换键要在右上）', async () => {
    await mountSession()

    const header = screen.getByTestId('chat-header')
    const tabs = screen.getByRole('tablist', { name: '对话视图' })
    // 右端 = 头部最后一个子元素；标题那一格 flex-1 占剩余宽度并让出右上角
    expect(tabs.parentElement).toBe(header)
    expect(header.lastElementChild).toBe(tabs)
    expect(screen.getByTestId('chat-title').parentElement).toHaveClass('flex-1')
    // pr-14：右上角那条走廊留给工作台开关（页签不钻到按钮底下）
    expect(header).toHaveClass('pr-14')
  })

  it('点「轨迹」：轨迹层激活并取数，对话层让位（两块都留在文档里、带透明度过渡，不硬切）', async () => {
    await mountSession()

    const chatPane = screen.getByTestId('chat-pane')
    const layer = screen.getByTestId('trajectory-layer')
    expect(chatPane).toHaveClass('transition-opacity')
    expect(layer).toHaveClass('transition-opacity')

    fireEvent.click(screen.getByTestId('view-tab-trajectory'))

    await waitFor(() =>
      expect(screen.getByTestId('trajectory-layer')).toHaveAttribute('data-active')
    )
    // 对话层仍在文档里（不卸载 = 输入框草稿/焦点/在跑的流不丢），只是透明且不吃事件
    expect(screen.getByTestId('composer-input')).toBeInTheDocument()
    expect(screen.getByTestId('chat-pane')).toHaveAttribute('aria-hidden', 'true')
    await waitFor(() => expect(screen.getByTestId('trajectory-row-0')).toBeInTheDocument())
    expect(vi.mocked(fetchThreadMessages)).toHaveBeenCalledWith(THREAD_ID)
  })

  it('切回「对话」：轨迹层让位、对话层回来（选中态留在轨迹组件里）', async () => {
    await mountSession()
    fireEvent.click(screen.getByTestId('view-tab-trajectory'))
    await screen.findByTestId('trajectory-row-0')

    fireEvent.click(screen.getByTestId('view-tab-chat'))

    await waitFor(() =>
      expect(screen.getByTestId('trajectory-layer')).not.toHaveAttribute('data-active')
    )
    expect(screen.getByTestId('chat-pane')).not.toHaveAttribute('aria-hidden')
    // 轨迹层还在（只是透明），切回去不必重新挂载
    expect(screen.getByTestId('trajectory-view')).toBeInTheDocument()
  })
})
