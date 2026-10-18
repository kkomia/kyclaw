import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Link, MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@renderer/App'
import {
  clearKyclawBridge,
  installKyclawBridge,
  officeDocumentFixture
} from '@renderer/__tests__/kyclaw-bridge'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import { resetOfficeActionsForTest } from '@renderer/features/office/office-actions'
import {
  resetOfficeTabsStore,
  useOfficeTabsStore
} from '@renderer/features/office/office-tabs-store'
import { resetOfficeUiStore } from '@renderer/features/office/office-ui-store'
import { resetProjectsStore } from '@renderer/features/projects/projects-store'
import { resetSessionsStore, useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { resetWorkbenchStore } from '@renderer/features/workbench/workbench-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { useShellStore } from '@renderer/lib/shell-store'
import { defaultSettings } from '@shared/settings'

/**
 * 一级模块宿主（0.2.0 应用壳）的三条硬口径：
 *   1. 主对话在模块间切换时**不卸载**（hidden + inert 的常驻宿主）——草稿 / 附件 / 滚动 / 页签都留着；
 *   2. 工作台由 AppShell 常驻，模块切换不销毁（终端 PTY / webview / 预览依赖它）；
 *   3. 深链直接进 /notes 时 sessions-store 也已经初始化（activeId 已落位）。
 */

const NOW = new Date().toISOString()

function respond(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

/** 只实现渲染端首屏真正会打的那几条口子；其余 404 由调用方按错误态处理。 */
function stubAgentApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname
      if (path === '/api/threads') {
        return respond({ threads: [{ id: 't-a', title: '会话 A', updatedAt: NOW }] })
      }
      if (path === '/api/projects/mappings') return respond({ sessions: [] })
      if (path === '/api/ppt/templates') return respond({ sessions: [] })
      if (/^\/api\/threads\/[^/]+\/messages$/.test(path)) return respond({ messages: [] })
      if (/^\/api\/threads\/[^/]+\/compaction$/.test(path)) return respond({ compaction: null })
      return new Response('{}', { status: 404 })
    })
  )
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>
  )
}

/** 等主对话这一挂的历史回灌收尾（测试结束前把请求清干净，别落到已摘掉的桥上） */
async function waitForChatReady(title = '会话 A'): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('chat-title')).toHaveTextContent(title)
  })
}

beforeEach(() => {
  installKyclawBridge()
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
  resetSessionsStore()
  resetProjectsStore()
  resetThreadChats()
  resetWorkbenchStore()
  resetOfficeTabsStore()
  resetOfficeUiStore()
  resetOfficeActionsForTest()
  useShellStore.setState({
    sidebarCollapsed: false,
    sidebarAutoCollapsed: false,
    workPanelOpen: false,
    workPanelWidth: 400,
    workPanelFullscreen: false,
    workPanelFit: null
  })
  stubAgentApi()
})

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
})

describe('ModuleHost 模块宿主', () => {
  it('切换一级模块：主对话不卸载（同一节点，hidden + inert），也没有第二个聊天实例', async () => {
    renderAt('/chat')
    await waitFor(() => {
      expect(useSessionsStore.getState().activeId).toBe('t-a')
    })
    await waitForChatReady()

    const chat = screen.getByTestId('chat-page')
    const chatPane = screen.getByTestId('module-chat')
    expect(chatPane).not.toHaveClass('hidden')
    // 主对话模块的二级栏仍在（会话列表是模块内的，不是全局壳）
    expect(screen.getByTestId('sidebar')).toContainElement(screen.getByTestId('session-list'))
    expect(screen.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'expanded')

    // 输入草稿跟着常驻的那一挂走：切走再切回还是同一份
    const input = screen.getByTestId('composer-input')
    fireEvent.change(input, { target: { value: '切模块不丢的草稿' } })
    expect(input).toHaveValue('切模块不丢的草稿')

    fireEvent.click(screen.getByTestId('primary-nav-notes'))

    expect(await screen.findByTestId('notes-page')).toBeInTheDocument()
    // 笔记模块不挂会话二级栏：内容卡可见左缘回到 0
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument()
    // v2（用户 2026-10-17）：顶栏侧栏开合钮恒显 —— 没有二级栏的模块里也保留这个位置，不隐藏
    expect(screen.getByTestId('sidebar-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed')
    expect(screen.getByTestId('chat-page')).toBe(chat)
    expect(screen.getAllByTestId('chat-page')).toHaveLength(1)
    expect(chatPane).toHaveClass('hidden')
    expect(chatPane).toHaveAttribute('inert')

    fireEvent.click(screen.getByTestId('primary-nav-knowledge'))
    fireEvent.click(screen.getByTestId('primary-nav-office'))
    expect(screen.getByTestId('chat-page')).toBe(chat)

    fireEvent.click(screen.getByTestId('primary-nav-chat'))

    expect(screen.getByTestId('chat-page')).toBe(chat)
    expect(screen.getByTestId('composer-input')).toBe(input)
    expect(input).toHaveValue('切模块不丢的草稿')
    expect(chatPane).not.toHaveClass('hidden')
    expect(chatPane).not.toHaveAttribute('inert')
  })

  it('直接进 /notes：sessions-store 已初始化并落位 activeId', async () => {
    renderAt('/notes')

    expect(await screen.findByTestId('notes-page')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument()
    // 没进过主对话不预挂聊天（只把会话列表初始化好）
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(useSessionsStore.getState().loaded).toBe(true)
      expect(useSessionsStore.getState().activeId).toBe('t-a')
    })
  })

  it('笔记 / 知识库 / Office 都有标题、空态与稳定 testid；离开 Office 后它仍挂载（hidden+inert）', async () => {
    renderAt('/knowledge')
    expect(await screen.findByTestId('knowledge-page')).toBeInTheDocument()
    expect(screen.getByTestId('knowledge-page-title')).toHaveTextContent('知识库')
    expect(screen.getByTestId('knowledge-empty')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('primary-nav-office'))
    expect(await screen.findByTestId('office-page')).toBeInTheDocument()
    expect(screen.getByTestId('office-page-title')).toHaveTextContent('Office')
    expect(screen.getByTestId('office-empty')).toBeInTheDocument()
    expect(screen.getByTestId('module-office')).toHaveAttribute('data-active', 'true')

    fireEvent.click(screen.getByTestId('primary-nav-notes'))
    expect(await screen.findByTestId('notes-page')).toBeInTheDocument()
    expect(screen.getByTestId('notes-page-title')).toHaveTextContent('笔记')
    expect(screen.getByTestId('notes-empty')).toBeInTheDocument()
    // M3-S4：Office 常驻，切走只 hidden+inert —— 不是 not.toBeInTheDocument()
    expect(await screen.findByTestId('office-page')).toBeInTheDocument()
    expect(screen.getByTestId('module-office')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('module-office')).toHaveClass('hidden')
    expect(screen.getByTestId('module-office')).toHaveAttribute('inert')
  })

  it('直接深链 /office：只挂 OfficePage，不预挂 ChatPage；首次进 /chat 才挂聊天且 Office 保活', async () => {
    renderAt('/office')

    expect(await screen.findByTestId('office-page')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()
    expect(screen.getByTestId('module-office')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('module-office')).not.toHaveClass('hidden')

    fireEvent.click(screen.getByTestId('primary-nav-chat'))
    await waitForChatReady()

    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
    expect(await screen.findByTestId('office-page')).toBeInTheDocument()
    expect(screen.getByTestId('module-office')).toHaveClass('hidden')
    expect(screen.getByTestId('module-office')).toHaveAttribute('inert')

    fireEvent.click(screen.getByTestId('primary-nav-office'))
    expect(screen.getByTestId('module-office')).not.toHaveClass('hidden')
    expect(await screen.findByTestId('office-page')).toBeInTheDocument()
  })

  it('Office 保活：切模块后 iframe/workspace 是同一节点，可见性随路由切换', async () => {
    installKyclawBridge()
    useOfficeTabsStore
      .getState()
      .openDocument(officeDocumentFixture({ documentId: 'doc-keep', displayName: '保活.docx' }))
    renderAt('/office')

    const officePage = await screen.findByTestId('office-page')
    const workspace = screen.getByTestId('office-workspace')
    const iframe = screen.getByTestId('office-surface-iframe')
    expect(screen.getByTestId('module-office')).not.toHaveClass('hidden')

    fireEvent.click(screen.getByTestId('primary-nav-notes'))
    expect(screen.getByTestId('office-page')).toBe(officePage)
    expect(screen.getByTestId('office-workspace')).toBe(workspace)
    expect(screen.getByTestId('office-surface-iframe')).toBe(iframe)
    expect(screen.getByTestId('module-office')).toHaveClass('hidden')
    expect(screen.getByTestId('module-office')).toHaveAttribute('inert')

    fireEvent.click(screen.getByTestId('primary-nav-chat'))
    await waitForChatReady()
    expect(screen.getByTestId('office-surface-iframe')).toBe(iframe)

    fireEvent.click(screen.getByTestId('primary-nav-office'))
    expect(await screen.findByTestId('office-page')).toBe(officePage)
    expect(screen.getByTestId('office-surface-iframe')).toBe(iframe)
    expect(screen.getByTestId('module-office')).not.toHaveClass('hidden')
    expect(screen.getByTestId('module-office')).not.toHaveAttribute('inert')
  })

  it('工作台/工作台内容由 AppShell 常驻：模块切换前后是同一节点', async () => {
    renderAt('/chat')
    await waitForChatReady()
    const panel = screen.getByTestId('work-panel')
    const bench = screen.getByTestId('workbench')

    fireEvent.click(screen.getByTestId('primary-nav-notes'))
    fireEvent.click(screen.getByTestId('primary-nav-knowledge'))
    fireEvent.click(screen.getByTestId('primary-nav-office'))

    expect(screen.getByTestId('work-panel')).toBe(panel)
    expect(screen.getByTestId('workbench')).toBe(bench)
  })

  it('Ctrl+K 在笔记模块：切回主对话并新建草稿（模块宿主复用同一挂聊天）', async () => {
    renderAt('/notes')
    await waitFor(() => {
      expect(useSessionsStore.getState().activeId).toBe('t-a')
    })

    act(() => {
      fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    })

    expect(useSessionsStore.getState().activeId).not.toBe('t-a')
    expect(screen.getByTestId('module-chat')).not.toHaveClass('hidden')
    expect(screen.queryByTestId('notes-page')).not.toBeInTheDocument()
    // 等这一挂草稿的历史回灌收尾，避免测试结束后还有请求落在已摘掉的桥上
    await waitFor(() => {
      expect(screen.getByTestId('chat-title')).toHaveTextContent('新会话')
    })
  })
})

/**
 * W7（设置往返丢草稿的根因修复）：`/settings/:section?`、`/plugins`、`/memory`、`/usage`
 * 原来挂在 ModuleHost **之外**，切过去会连宿主带常驻 ChatPage 一起卸载，输入草稿随之丢失。
 * 现在这四条也进 ModuleHost：页面由宿主的 Outlet 渲染，主对话只 hidden+inert。
 */
describe('ModuleHost · W7（设置 / 旧深链往返不丢主对话）', () => {
  it('主对话写草稿 → 打开设置 → 回主对话：同一挂 ChatPage，草稿还在', async () => {
    renderAt('/chat')
    await waitForChatReady()

    const chat = screen.getByTestId('chat-page')
    const input = screen.getByTestId('composer-input')
    fireEvent.change(input, { target: { value: '去设置前写的草稿' } })

    fireEvent.click(screen.getByTestId('primary-nav-settings'))

    // 设置页出来了，但主对话只是 hidden+inert：同一节点、没有第二个聊天
    expect(await screen.findByTestId('settings-page')).toBeInTheDocument()
    expect(screen.getByTestId('chat-page')).toBe(chat)
    expect(screen.getAllByTestId('chat-page')).toHaveLength(1)
    expect(screen.getByTestId('module-chat')).toHaveClass('hidden')
    expect(screen.getByTestId('module-chat')).toHaveAttribute('inert')
    // 设置二级栏仍由 AppShell 的 inSettings 分支给（布局口径不变）
    expect(screen.getByTestId('settings-nav')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('primary-nav-chat'))

    expect(screen.getByTestId('chat-page')).toBe(chat)
    expect(screen.getByTestId('composer-input')).toBe(input)
    expect(input).toHaveValue('去设置前写的草稿')
    expect(screen.getByTestId('module-chat')).not.toHaveClass('hidden')
    expect(screen.getByTestId('module-chat')).not.toHaveAttribute('inert')
  })

  it('设置深链不预挂聊天（与 /notes 同口径）：chat-page 不在 DOM；首次进对话才挂上', async () => {
    renderAt('/settings')

    expect(await screen.findByTestId('settings-page')).toBeInTheDocument()
    expect(screen.queryByTestId('chat-page')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('primary-nav-chat'))

    await waitForChatReady()
    expect(screen.getByTestId('chat-page')).toBeInTheDocument()
  })

  it('旧深链 /plugins /memory /usage 往返：同一个 ChatPage 节点与草稿都保住', async () => {
    render(
      <MemoryRouter initialEntries={['/chat']}>
        <AppRoutes />
        <Link to="/plugins" data-testid="go-plugins">
          插件
        </Link>
        <Link to="/memory" data-testid="go-memory">
          记忆
        </Link>
        <Link to="/usage" data-testid="go-usage">
          用量
        </Link>
        <Link to="/chat" data-testid="go-chat">
          对话
        </Link>
      </MemoryRouter>
    )
    await waitForChatReady()

    const chat = screen.getByTestId('chat-page')
    const input = screen.getByTestId('composer-input')
    fireEvent.change(input, { target: { value: '旧深链往返的草稿' } })

    const stops = [
      ['go-plugins', 'plugins-page'],
      ['go-memory', 'memory-page'],
      ['go-usage', 'usage-page']
    ] as const
    for (const [link, page] of stops) {
      fireEvent.click(screen.getByTestId(link))
      expect(await screen.findByTestId(page)).toBeInTheDocument()
      expect(screen.getByTestId('chat-page')).toBe(chat)
      expect(screen.getByTestId('module-chat')).toHaveClass('hidden')
    }

    fireEvent.click(screen.getByTestId('go-chat'))
    expect(screen.getByTestId('chat-page')).toBe(chat)
    expect(screen.getByTestId('composer-input')).toBe(input)
    expect(input).toHaveValue('旧深链往返的草稿')
  })
})
