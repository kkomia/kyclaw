import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tick } from '@renderer/components/ui/__tests__/tick'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import { resetProjectsStore } from '@renderer/features/projects/projects-store'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings } from '@shared/settings'
import type { AppSettings } from '@shared/settings'
import { SessionsController } from '../SessionsController'
import { resetSessionsStore, useSessionsStore } from '../sessions-store'

/**
 * 侧栏会话区的装配（SessionsController + store + SessionList）：
 * 首屏拉列表、新建/切换/重命名/删除四条交互真的打到 HTTP（假 fetch）上，
 * 以及列表载入失败时的就地错误行 + 重试。
 * T18 起侧栏中部还有「项目」区（它自己拉 /api/projects/mappings），所以假服务也实现那两条口子。
 */
interface ThreadRow {
  id: string
  title: string | null
  updatedAt: string
}

interface MappingRow {
  threadId: string
  projectId: string
}

function installFakeServer(
  initial: ThreadRow[] = [],
  mappings: MappingRow[] = []
): {
  threads: ThreadRow[]
  mappings: MappingRow[]
  calls: { method: string; path: string; body: unknown }[]
  failNext: (error: Error) => void
} {
  let failure: Error | null = null
  const server = {
    threads: [...initial],
    mappings: [...mappings],
    calls: [] as { method: string; path: string; body: unknown }[],
    /** 让下一次**会话列表**请求失败（映射请求不受影响：两条路各拉各的） */
    failNext(error: Error) {
      failure = error
    }
  }
  const respond = (payload: unknown): Response =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const method = init.method ?? 'GET'
      server.calls.push({
        method,
        path: url.pathname,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      })
      if (failure !== null && url.pathname === '/api/threads' && method === 'GET') {
        const error = failure
        failure = null
        throw error
      }
      if (url.pathname === '/api/threads' && method === 'GET') {
        return respond({ threads: server.threads })
      }
      if (url.pathname === '/api/projects/mappings' && method === 'GET') {
        return respond({ sessions: server.mappings })
      }
      if (url.pathname === '/api/projects/mappings' && method === 'PUT') {
        const { threadId, projectId } = JSON.parse(String(init.body)) as {
          threadId: string
          projectId: string | null
        }
        server.mappings = server.mappings.filter((row) => row.threadId !== threadId)
        if (projectId !== null) server.mappings.push({ threadId, projectId })
        return respond({ ok: true })
      }
      const match = /^\/api\/threads\/([^/]+)$/.exec(url.pathname)
      if (match && method === 'PATCH') {
        const id = decodeURIComponent(match[1])
        const next = server.threads.find((row) => row.id === id)!
        const updated = { ...next, title: (init.body ? JSON.parse(String(init.body)) : {}).title }
        server.threads = server.threads.map((row) => (row.id === id ? updated : row))
        return respond(updated)
      }
      if (match && method === 'DELETE') {
        server.threads = server.threads.filter((row) => row.id !== decodeURIComponent(match[1]))
        return respond({ ok: true })
      }
      throw new Error(`假服务没实现：${method} ${url.pathname}`)
    })
  )
  return server
}

const TODAY = new Date().toISOString()
const EARLIER = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString()
const THREADS: ThreadRow[] = [
  { id: 't-a', title: '今天的会话', updatedAt: TODAY },
  { id: 't-b', title: '前天的会话', updatedAt: EARLIER }
]

function LocationProbe(): React.JSX.Element {
  return <div data-testid="location">{useLocation().pathname}</div>
}

function renderController(path = '/chat'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <SessionsController />
      <LocationProbe />
    </MemoryRouter>
  )
}

/** Radix 菜单：键盘打开（ArrowDown）后在条目上回车选中 */
function pick(triggerTestId: string, itemTestId: string): void {
  fireEvent.keyDown(screen.getByTestId(triggerTestId), { key: 'ArrowDown' })
  fireEvent.keyDown(screen.getByTestId(itemTestId), { key: 'Enter' })
}

beforeEach(() => {
  installKyclawBridge()
  resetSessionsStore()
  resetProjectsStore()
  resetThreadChats()
  // round 20：置顶/归档都写 settings——每个用例从默认设置起（模块级 store 不随 render 重置）
  useSettingsStore.setState({ settings: defaultSettings(), loaded: false })
})

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
})

describe('SessionsController：首屏与列表', () => {
  it('拉服务端列表：今天/更早分组、最近一条选中', async () => {
    installFakeServer(THREADS)
    renderController()

    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toHaveTextContent('今天的会话')
    })
    expect(screen.getByTestId('session-group-today')).toContainElement(
      screen.getByTestId('session-item-t-a')
    )
    expect(screen.getByTestId('session-group-earlier')).toContainElement(
      screen.getByTestId('session-item-t-b')
    )
    // round 20：选中填充挂在**行容器**上（标题 + ⋯ 同一个圆角内），按钮自己只留 aria-current
    expect(screen.getByTestId('session-row-t-a')).toHaveClass('bg-selected')
  })

  it('点会话：选中它并回到对话页', async () => {
    installFakeServer(THREADS)
    renderController('/settings')
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-b')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTestId('session-item-t-b'))

    await waitFor(() => {
      expect(useSessionsStore.getState().activeId).toBe('t-b')
    })
    expect(screen.getByTestId('session-row-t-b')).toHaveClass('bg-selected')
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })

  it('已存在的会话按服务端标题显示', async () => {
    installFakeServer([{ id: 't-x', title: null, updatedAt: TODAY }])
    renderController()

    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-x')).toHaveTextContent('新会话')
    })
  })
})

describe('SessionsController：新建', () => {
  it('点新建：换上草稿（侧栏出现选中的"新会话"），并回到对话页', async () => {
    installFakeServer(THREADS)
    renderController('/settings')
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })
    const before = useSessionsStore.getState().activeId

    fireEvent.click(screen.getByTestId('new-session'))

    await waitFor(() => {
      const draftId = useSessionsStore.getState().activeId
      expect(draftId).not.toBe(before)
      expect(screen.getByTestId(`session-item-${draftId}`)).toHaveTextContent('新会话')
      expect(screen.getByTestId(`session-row-${draftId}`)).toHaveClass('bg-selected')
      // 草稿还没落库：不给重命名/删除（服务端没有它）
      expect(screen.queryByTestId(`session-more-${draftId}`)).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })
})

describe('SessionsController：重命名', () => {
  it('菜单 → 重命名 → 保存：打 PATCH、侧栏更新', async () => {
    const server = installFakeServer(THREADS)
    renderController()
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })

    pick('session-more-t-a', 'session-rename-t-a')
    await waitFor(() => {
      expect(screen.getByTestId('session-rename-input')).toBeInTheDocument()
    })
    fireEvent.change(screen.getByTestId('session-rename-input'), {
      target: { value: '改过的标题' }
    })
    fireEvent.click(screen.getByTestId('session-rename-save'))

    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toHaveTextContent('改过的标题')
    })
    expect(server.calls).toContainEqual({
      method: 'PATCH',
      path: '/api/threads/t-a',
      body: { title: '改过的标题' }
    })
  })
})

describe('SessionsController：删除（二次确认）', () => {
  it('菜单 → 删除 → 确认：打 DELETE、列表里消失', async () => {
    const server = installFakeServer(THREADS)
    renderController()
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })

    pick('session-more-t-a', 'session-delete-t-a')
    await waitFor(() => {
      expect(screen.getByTestId('session-delete-confirm')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('session-delete-confirm'))

    await waitFor(() => {
      expect(screen.queryByTestId('session-item-t-a')).not.toBeInTheDocument()
    })
    expect(
      server.calls.some((call) => call.method === 'DELETE' && call.path === '/api/threads/t-a')
    ).toBe(true)
    // 删的是活跃会话：接力到剩下那条
    expect(useSessionsStore.getState().activeId).toBe('t-b')
  })
})

describe('SessionsController：加载失败', () => {
  it('错误行 + 重试：重试成功后列表出现', async () => {
    const server = installFakeServer(THREADS)
    server.failNext(new Error('连接被拒绝'))
    renderController()

    // 界面只说"加载失败"（雷点 2.2：不把后端错误原文写给用户看），原文留给控制台
    await waitFor(() => {
      expect(screen.getByTestId('session-load-error')).toHaveTextContent('会话列表加载失败')
    })
    expect(screen.getByTestId('session-load-error')).not.toHaveTextContent('连接被拒绝')

    fireEvent.click(screen.getByTestId('session-load-retry'))

    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('session-load-error')).not.toBeInTheDocument()
  })
})

describe('SessionsController：项目区（T18）', () => {
  const PROJECTS: AppSettings['projects'] = [
    { id: 'p1', name: '插件', path: 'D:\\ws\\插件', createdAt: '2026-10-11T00:00:00.000Z' }
  ]

  async function mountWithProjects(
    mappings: MappingRow[] = [],
    configure?: (bridge: ReturnType<typeof installKyclawBridge>) => void
  ): Promise<{
    server: ReturnType<typeof installFakeServer>
    bridge: ReturnType<typeof installKyclawBridge>
  }> {
    const server = installFakeServer(THREADS, mappings)
    clearKyclawBridge()
    const bridge = installKyclawBridge({ ...defaultSettings(), projects: PROJECTS })
    configure?.(bridge)
    await useSettingsStore.getState().load()
    renderController()
    await waitFor(() => {
      expect(screen.getByTestId('project-item-p1')).toBeInTheDocument()
    })
    return { server, bridge }
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.localStorage.clear()
  })

  it('项目名下的会话挂在项目下（平铺区里不再重复出现）', async () => {
    await mountWithProjects([{ threadId: 't-b', projectId: 'p1' }])

    expect(screen.getByTestId('project-group-p1')).toContainElement(
      screen.getByTestId('session-item-t-b')
    )
    // 平铺区（今天）只剩没有项目的那条
    expect(screen.getByTestId('session-group-today')).toContainElement(
      screen.getByTestId('session-item-t-a')
    )
    expect(screen.queryByTestId('session-group-earlier')).not.toBeInTheDocument()
  })

  it('点项目行：展开/折叠名下会话（round 16 起不再开会话；折叠记 localStorage）', async () => {
    const { server } = await mountWithProjects([{ threadId: 't-b', projectId: 'p1' }])

    const projectRow = screen.getByTestId('project-item-p1')
    const fold = (): HTMLElement => screen.getByTestId('project-sessions-p1')
    const activeBefore = useSessionsStore.getState().activeId
    expect(fold()).toHaveAttribute('data-open', 'true')

    fireEvent.click(projectRow)

    expect(fold()).toHaveAttribute('data-open', 'false')
    expect(projectRow).toHaveAttribute('aria-expanded', 'false')
    expect(window.localStorage.getItem('kyclaw.projects.collapsed')).toContain('"p1"')
    // 点击语义只有折叠：没有新会话、没有新映射
    expect(useSessionsStore.getState().activeId).toBe(activeBefore)
    expect(server.mappings).toEqual([{ threadId: 't-b', projectId: 'p1' }])

    fireEvent.click(projectRow)
    expect(fold()).toHaveAttribute('data-open', 'true')
  })

  it('点项目名下的会话：选中它并回到对话页', async () => {
    await mountWithProjects([{ threadId: 't-b', projectId: 'p1' }])

    fireEvent.click(screen.getByTestId('session-item-t-b'))

    expect(useSessionsStore.getState().activeId).toBe('t-b')
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })

  it('删除项目：projects:remove(id)，名下会话归属被摘掉、回到平铺区', async () => {
    const { server } = await mountWithProjects([{ threadId: 't-b', projectId: 'p1' }])

    pick('project-more-p1', 'project-delete-p1')
    await waitFor(() => {
      expect(screen.getByTestId('project-delete-confirm')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('project-delete-confirm'))

    await waitFor(() => {
      expect(screen.queryByTestId('project-item-p1')).not.toBeInTheDocument()
    })
    expect(useSettingsStore.getState().settings.projects).toEqual([])
    // 归属也摘了（含服务端那一行）
    await waitFor(() => {
      expect(server.mappings).toEqual([])
    })
    await waitFor(() => {
      expect(screen.getByTestId('session-group-earlier')).toContainElement(
        screen.getByTestId('session-item-t-b')
      )
    })
  })

  it('失败就不装：projects:remove 抛错时行内报原因', async () => {
    const { bridge } = await mountWithProjects([], (installed) => {
      installed.projects.remove.mockRejectedValueOnce(new Error('项目通道不可用'))
    })
    void bridge

    pick('project-more-p1', 'project-delete-p1')
    await waitFor(() => {
      expect(screen.getByTestId('project-delete-confirm')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('project-delete-confirm'))

    await waitFor(() => {
      expect(screen.getByTestId('project-error')).toHaveTextContent('项目通道不可用')
    })
    expect(screen.getByTestId('project-item-p1')).toBeInTheDocument()
  })
})

describe('SessionsController·round 20：置顶 / 移至项目 / 资源管理器 / 归档', () => {
  it('置顶：写 settings.pinnedThreads，行移到置顶分组（带图钉标识）', async () => {
    const bridge = installKyclawBridge()
    installFakeServer(THREADS)
    renderController()
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })

    pick('session-more-t-a', 'session-pin-t-a')

    await waitFor(() => {
      expect(bridge.update).toHaveBeenCalledWith({ pinnedThreads: ['t-a'] })
    })
    await waitFor(() => {
      expect(screen.getByTestId('session-group-pinned')).toContainElement(
        screen.getByTestId('session-row-t-a')
      )
    })
    expect(screen.getByTestId('session-pin-mark-t-a')).toBeInTheDocument()
  })

  it('移至项目：走 T18 映射通道（PUT），会话挪进项目分组', async () => {
    const initial = {
      ...defaultSettings(),
      projects: [
        { id: 'p1', name: '项目一', path: 'D:\\p1', createdAt: '2026-10-11T00:00:00.000Z' }
      ]
    }
    installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    const server = installFakeServer(THREADS)
    renderController()
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })

    // 子菜单要先展开（Radix：聚焦子菜单触发器 + ArrowRight）
    fireEvent.keyDown(screen.getByTestId('session-more-t-a'), { key: 'ArrowDown' })
    const trigger = screen.getByTestId('session-move-t-a')
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    await tick()
    fireEvent.click(screen.getByTestId('session-move-t-a-p1'))

    await waitFor(() => {
      expect(server.mappings).toEqual([{ threadId: 't-a', projectId: 'p1' }])
    })
    await waitFor(() => {
      expect(screen.getByTestId('project-sessions-p1')).toContainElement(
        screen.getByTestId('session-item-t-a')
      )
    })
  })

  it('在文件资源管理器中打开：打 workspace:open-in-explorer；失败露一行原因（不静默）', async () => {
    // 会话根可判（唯一授权目录）→ 菜单项可用
    const initial = { ...defaultSettings(), workspaces: [{ path: 'D:\\ws', mode: 'ask' as const }] }
    const bridge = installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    installFakeServer(THREADS)
    renderController()
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })

    pick('session-more-t-a', 'session-open-t-a')
    await waitFor(() => {
      expect(bridge.workspace.openInExplorer).toHaveBeenCalledWith('t-a')
    })

    // 第二回：主进程回人话错误 → 侧栏露一行
    bridge.workspace.openInExplorer.mockRejectedValueOnce(new Error('打不开这个文件夹：拒绝访问'))
    pick('session-more-t-a', 'session-open-t-a')
    await waitFor(() => {
      expect(screen.getByTestId('session-action-error')).toHaveTextContent('拒绝访问')
    })
  })

  it('归档：写快照（标题/项目/时间）进 settings.archivedThreads，行从侧栏消失、数据不删；选中让给下一条', async () => {
    const bridge = installKyclawBridge()
    installFakeServer(THREADS)
    renderController()
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })
    // 首屏选中的是最近一条 t-a
    expect(useSessionsStore.getState().activeId).toBe('t-a')

    pick('session-more-t-a', 'session-archive-t-a')

    await waitFor(() => {
      const patch = bridge.update.mock.calls.at(-1)?.[0] as {
        archivedThreads?: {
          threadId: string
          title: string | null
          projectId: string | null
          archivedAt: string
        }[]
      }
      expect(patch.archivedThreads?.[0]).toMatchObject({
        threadId: 't-a',
        title: '今天的会话',
        projectId: null
      })
      expect(typeof patch.archivedThreads?.[0]?.archivedAt).toBe('string')
    })
    // 行消失（数据没删：服务端列表与线程都还在，只是从侧栏过滤）
    await waitFor(() => {
      expect(screen.queryByTestId('session-item-t-a')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('session-item-t-b')).toBeInTheDocument()
    // 归档的是当前会话：选中让给下一条可见会话
    await waitFor(() => {
      expect(useSessionsStore.getState().activeId).toBe('t-b')
    })
  })

  it('归档失败：行还在、露一行原因', async () => {
    const bridge = installKyclawBridge()
    bridge.update.mockRejectedValueOnce(new Error('设置通道不可用'))
    installFakeServer(THREADS)
    renderController()
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })

    pick('session-more-t-a', 'session-archive-t-a')

    await waitFor(() => {
      expect(screen.getByTestId('session-action-error')).toHaveTextContent('设置通道不可用')
    })
    expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
  })
})
