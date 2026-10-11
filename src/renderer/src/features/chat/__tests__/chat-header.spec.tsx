import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { resetProjectsStore } from '@renderer/features/projects/projects-store'
import { resetSessionsStore, useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { defaultSettings } from '@shared/settings'
import { ChatHeader } from '../ChatHeader'

/**
 * 对话页顶部栏（round 24）：与 chat 同底色的一栏（无独立底色/分隔线/描边、40px）；
 * 左上角对话名称（文本 + chevron、hover 灰底无描边），点击出**与侧栏同款**的菜单
 * （SessionActionsMenu——同一份实现：动作经 store，标题/置顶状态即时同步）。
 */
vi.mock('@renderer/lib/threads-api', () => ({
  fetchThreads: vi.fn(async () => []),
  fetchThreadMessages: vi.fn(async () => []),
  createThread: vi.fn(async (id: string, title?: string) => ({
    id,
    title: title ?? null,
    updatedAt: new Date().toISOString()
  })),
  renameThread: vi.fn(async (id: string, title: string) => ({
    id,
    title,
    updatedAt: new Date().toISOString()
  })),
  deleteThread: vi.fn(async () => undefined),
  truncateThread: vi.fn(async () => 0),
  generateThreadTitle: vi.fn(async () => ({ title: '', generated: false })),
  fetchThreadCompaction: vi.fn(async () => null),
  compactThread: vi.fn(async () => ({ compacted: false, compaction: null }))
}))

vi.mock('@renderer/lib/projects-api', () => ({
  fetchSessionProjects: vi.fn(async () => []),
  putSessionProject: vi.fn(async () => undefined)
}))

import { renameThread, createThread } from '@renderer/lib/threads-api'

const THREAD_ID = 't1'

function mount(options: { listed?: boolean } = {}): KyclawBridgeStubs {
  const initial = defaultSettings()
  const bridge = installKyclawBridge(initial)
  useSettingsStore.setState({ settings: initial, loaded: true })
  useSessionsStore.setState({
    threads:
      options.listed === false
        ? []
        : [{ id: THREAD_ID, title: '会话甲', updatedAt: '2026-10-11T00:00:00.000Z' }],
    activeId: THREAD_ID,
    loaded: true,
    error: null,
    notices: {}
  })
  render(
    <MemoryRouter>
      <ChatHeader threadId={THREAD_ID} />
    </MemoryRouter>
  )
  return bridge
}

beforeEach(() => {
  resetSessionsStore()
  resetProjectsStore()
  vi.mocked(renameThread).mockClear()
  vi.mocked(createThread).mockClear()
})

afterEach(() => {
  clearKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

describe('ChatHeader · 结构', () => {
  it('一栏 40px、与 chat 不区分（没有独立底色/描边/分隔线）', () => {
    mount()

    const header = screen.getByTestId('chat-header')
    expect(header).toHaveClass('h-10')
    // 无独立底色 / 无描边 / 无分隔线：只排布局，不画面
    const classes = header.className
    expect(classes).not.toMatch(/\bbg-/)
    expect(classes).not.toMatch(/\bborder/)
    expect(classes).not.toMatch(/\bdivide-/)
  })

  it('左上角名称 = 会话标题（文本 + chevron、无描边文字按钮）；左缘与消息列口径对齐（pl-2 + px-2 = pl-4）', () => {
    mount()

    expect(screen.getByTestId('chat-header')).toHaveClass('pl-2', 'pr-14')
    const trigger = screen.getByTestId('chat-title')
    expect(trigger).toHaveTextContent('会话甲')
    expect(trigger).toHaveClass('h-8', 'px-2', 'rounded-control', 'hover:bg-hover')
    expect(trigger.className).not.toMatch(/\bborder/)
    expect(trigger.querySelector('svg')).not.toBeNull() // chevron
  })

  it('草稿（还没落成线程）：名称按钮照常在（新会话），动作菜单可用（round 26）', () => {
    mount({ listed: false })

    expect(screen.getByTestId('chat-title')).toHaveTextContent('新会话')
    fireEvent.keyDown(screen.getByTestId('chat-title'), { key: 'ArrowDown' })
    expect(screen.getByTestId('session-pin-t1')).toBeInTheDocument()
    expect(screen.getByTestId('session-move-t1')).toBeInTheDocument()
    expect(screen.getByTestId('session-rename-t1')).toBeInTheDocument()
    expect(screen.getByTestId('session-archive-t1')).toBeInTheDocument()
    expect(screen.getByTestId('session-delete-t1')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-title-static')).not.toBeInTheDocument()
  })
})

describe('ChatHeader · 名称菜单（与侧栏同款实现）', () => {
  it('点击名称出同款菜单：置顶 / 移至项目 ▸ / 在文件资源管理器中打开 / 重命名 / 归档 / 删除', () => {
    mount()
    fireEvent.keyDown(screen.getByTestId('chat-title'), { key: 'ArrowDown' })

    for (const id of [
      'session-pin-t1',
      'session-move-t1',
      'session-open-t1',
      'session-rename-t1',
      'session-archive-t1',
      'session-delete-t1'
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
  })

  it('动作与侧栏同一份连线：置顶 → settings.pinnedThreads', async () => {
    const bridge = mount()
    fireEvent.keyDown(screen.getByTestId('chat-title'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByTestId('session-pin-t1'), { key: 'Enter' })

    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ pinnedThreads: [THREAD_ID] }))
  })

  it('重命名后顶栏标题即时跟着变（与侧栏同读 sessions-store）', async () => {
    mount()
    fireEvent.keyDown(screen.getByTestId('chat-title'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByTestId('session-rename-t1'), { key: 'Enter' })

    const input = await screen.findByTestId('session-rename-input')
    fireEvent.change(input, { target: { value: '改过的名字' } })
    fireEvent.click(screen.getByTestId('session-rename-save'))

    await waitFor(() => expect(screen.getByTestId('chat-title')).toHaveTextContent('改过的名字'))
  })

  it('动作失败：顶栏下方露一行（不静默）', async () => {
    const bridge = mount()
    bridge.update.mockRejectedValueOnce(new Error('设置落盘失败'))
    fireEvent.keyDown(screen.getByTestId('chat-title'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByTestId('session-pin-t1'), { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByTestId('chat-header-error')).toHaveTextContent('设置落盘失败')
    })
  })

  it('草稿置顶（round 26）：先物化成真实线程（POST），再写 pinnedThreads', async () => {
    const bridge = mount({ listed: false })
    fireEvent.keyDown(screen.getByTestId('chat-title'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByTestId('session-pin-t1'), { key: 'Enter' })

    await waitFor(() => expect(vi.mocked(createThread)).toHaveBeenCalledWith(THREAD_ID, undefined))
    await waitFor(() => expect(bridge.update).toHaveBeenCalledWith({ pinnedThreads: [THREAD_ID] }))
  })

  it('草稿重命名（round 26 就地）：本地标题即时改、不发 PATCH', async () => {
    mount({ listed: false })
    fireEvent.keyDown(screen.getByTestId('chat-title'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByTestId('session-rename-t1'), { key: 'Enter' })

    const input = await screen.findByTestId('session-rename-input')
    expect(input).toHaveValue('')
    fireEvent.change(input, { target: { value: '草稿名' } })
    fireEvent.click(screen.getByTestId('session-rename-save'))

    await waitFor(() => expect(screen.getByTestId('chat-title')).toHaveTextContent('草稿名'))
    expect(vi.mocked(renameThread)).not.toHaveBeenCalled()
  })
})
