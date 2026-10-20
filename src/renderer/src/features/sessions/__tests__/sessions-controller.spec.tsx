import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tick } from '@renderer/components/ui/__tests__/tick'
import {
  clearKyclawBridge,
  installKyclawBridge,
  PICKED_FOLDER
} from '@renderer/__tests__/kyclaw-bridge'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import { useThreadRunStore } from '@renderer/features/chat/thread-run-store'
import { resetProjectsStore, useProjectsStore } from '@renderer/features/projects/projects-store'
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
 * 0.2.2：映射路由 501 后项目区改由「内核 cwd + settings.projects」推导，见文件末尾的 describe。
 */
interface ThreadRow {
  id: string
  title: string | null
  updatedAt: string
  /** 0.2.2：内核 session 的 cwd（假服务按 POST 的 projectId 回填，模拟服务端用项目 path 当 cwd） */
  cwd?: string
}

interface MappingRow {
  threadId: string
  projectId: string
}

function installFakeServer(
  initial: ThreadRow[] = [],
  mappings: MappingRow[] = [],
  options: { mappingsUnavailable?: boolean } = {}
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
      if (url.pathname === '/api/threads' && method === 'POST') {
        const { threadId, title, projectId } = JSON.parse(String(init.body)) as {
          threadId: string
          title?: string
          projectId?: string
        }
        // 0.2.2：真服务端带 projectId 时用项目 path 当内核 cwd（见 kernel-threads 的 POST）
        const project =
          projectId === undefined
            ? undefined
            : useSettingsStore.getState().settings.projects.find((item) => item.id === projectId)
        const row: ThreadRow = {
          id: threadId,
          title: title ?? null,
          updatedAt: new Date().toISOString(),
          ...(project === undefined ? {} : { cwd: project.path })
        }
        if (!server.threads.some((thread) => thread.id === threadId)) {
          server.threads = [row, ...server.threads]
        }
        return respond(row)
      }
      if (url.pathname === '/api/projects/mappings' && method === 'GET') {
        if (options.mappingsUnavailable === true) {
          return new Response(
            JSON.stringify({
              error: 'feature-disabled',
              feature: 'projects',
              availableIn: '0.2.x'
            }),
            { status: 501, headers: { 'content-type': 'application/json' } }
          )
        }
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
  it('拉服务端列表：无项目会话平铺进「任务」组、最近一条选中', async () => {
    installFakeServer(THREADS)
    renderController()

    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toHaveTextContent('今天的会话')
    })
    // round 61：无项目会话都归「任务」组，组内平铺（不再有 今天/更早 分组头）
    expect(screen.getByTestId('tasks-sessions')).toContainElement(
      screen.getByTestId('session-item-t-a')
    )
    expect(screen.getByTestId('tasks-sessions')).toContainElement(
      screen.getByTestId('session-item-t-b')
    )
    expect(screen.queryByTestId('session-group-today')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-group-earlier')).not.toBeInTheDocument()
    // round 20：选中填充挂在**行容器**上（标题 + ⋯ 同一个圆角内），按钮自己只留 aria-current
    expect(screen.getByTestId('session-row-t-a')).toHaveClass('bg-selected')
    // round 50：导航滚动容器挂静置隐藏的滚动条（机制与实测见 styles/__tests__/scrollbar-contract.spec.ts）
    expect(screen.getByTestId('sidebar-nav-scroll')).toHaveClass('scrollbar-auto-hide')
  })

  /**
   * 0.2.1（PB-053）时映射下架 = 整块项目区消失；0.2.2 用户拍板**恢复项目区**：501 下归属改由
   * 内核 session 的 cwd 推导，组头 / 管理菜单 / 项目行照常出现，但那条"永远失败的重试"红字不出现
   * （PB-053 的中性化纪律不变）。
   */
  it('映射路由下架（501）：项目区照常渲染、无「项目加载失败」红字；会话按内核 cwd 归组', async () => {
    const PROJECT = {
      id: 'p-old',
      name: '旧项目',
      path: 'D:\\ws\\插件',
      createdAt: '2026-10-11T00:00:00.000Z'
    }
    installFakeServer(
      [
        { id: 't-a', title: '今天的会话', updatedAt: TODAY },
        // cwd 落在项目路径下 → 归到旧项目；没登记过任何映射（映射通道本就 501）
        { id: 't-b', title: '插件里的会话', updatedAt: EARLIER, cwd: 'D:\\ws\\插件\\src' }
      ],
      [],
      { mappingsUnavailable: true }
    )
    useSettingsStore.setState({
      settings: { ...defaultSettings(), projects: [PROJECT] }
    })
    renderController()

    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(useProjectsStore.getState().unavailable).toBe(true)
    })

    // 0.2.2：项目区恢复（组头 + 管理菜单 + 项目行），不再整块消失
    expect(screen.getByTestId('project-section')).toBeInTheDocument()
    expect(screen.getByTestId('project-section-title')).toHaveTextContent('项目')
    expect(screen.getByTestId('project-add')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('project-item-p-old')).toHaveTextContent('旧项目')
    })
    // PB-053 纪律：501 不是"加载失败"，没有红字、没有永远失败的重试
    expect(screen.queryByTestId('project-error')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-retry')).not.toBeInTheDocument()
    expect(screen.queryByText('项目加载失败', { exact: false })).not.toBeInTheDocument()

    // 会话按内核 cwd 自动归到对应项目；没有 cwd 的留在「任务」组
    await waitFor(() => {
      expect(screen.getByTestId('project-sessions-p-old')).toContainElement(
        screen.getByTestId('session-item-t-b')
      )
    })
    expect(screen.getByTestId('tasks-sessions')).toContainElement(
      screen.getByTestId('session-item-t-a')
    )
  })

  it('501 且一个项目都没有：项目区在、给可点的空态（不是光秃秃一行标题）', async () => {
    installFakeServer(THREADS, [], { mappingsUnavailable: true })
    renderController()

    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(useProjectsStore.getState().unavailable).toBe(true)
    })
    expect(screen.getByTestId('project-section')).toBeInTheDocument()
    expect(screen.getByTestId('project-empty')).toHaveTextContent('使用现有文件夹')
    expect(screen.queryByTestId('project-error')).not.toBeInTheDocument()
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
      // round 26：草稿也有 ⋯（不再"灰着不让用"；置顶/归档/移至项目会先物化）
      expect(screen.getByTestId(`session-more-${draftId}`)).toBeInTheDocument()
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

  it('项目名下的会话挂在项目下（「任务」组里不再重复出现）', async () => {
    await mountWithProjects([{ threadId: 't-b', projectId: 'p1' }])

    expect(screen.getByTestId('project-group-p1')).toContainElement(
      screen.getByTestId('session-item-t-b')
    )
    // round 61：「任务」组只剩没有项目的那条；项目名下的不在这里
    expect(screen.getByTestId('tasks-sessions')).toContainElement(
      screen.getByTestId('session-item-t-a')
    )
    expect(screen.getByTestId('tasks-sessions')).not.toContainElement(
      screen.getByTestId('session-item-t-b')
    )
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

  it('删除项目：projects:remove(id)，名下会话归属被摘掉、回到「任务」组', async () => {
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
      expect(screen.getByTestId('tasks-sessions')).toContainElement(
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
  it('置顶：写 settings.pinnedThreads，行排到最前（带图钉标识）', async () => {
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
    // round 61：不再有"置顶分组"——置顶的会话排到列表最前（顺序由 composeSidebarSessions 给）
    await waitFor(() => {
      expect(
        screen.getAllByTestId(/^session-row-/).map((row) => row.getAttribute('data-testid'))
      ).toEqual(['session-row-t-a', 'session-row-t-b'])
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

describe('SessionsController·round 25：置顶项目 / ⊕ 新建会话 / 重命名 / 归档', () => {
  const TWO_PROJECTS: AppSettings['projects'] = [
    { id: 'p1', name: '甲项目', path: 'D:\\ws\\甲', createdAt: '2026-10-11T00:00:00.000Z' },
    { id: 'p2', name: '乙项目', path: 'D:\\ws\\乙', createdAt: '2026-10-11T00:00:00.000Z' }
  ]

  async function mountProjects(
    options: {
      path?: string
      mappings?: MappingRow[]
      configure?: (bridge: ReturnType<typeof installKyclawBridge>) => void
    } = {}
  ): Promise<{
    server: ReturnType<typeof installFakeServer>
    bridge: ReturnType<typeof installKyclawBridge>
  }> {
    const server = installFakeServer(THREADS, options.mappings ?? [])
    clearKyclawBridge()
    const bridge = installKyclawBridge({ ...defaultSettings(), projects: TWO_PROJECTS })
    options.configure?.(bridge)
    await useSettingsStore.getState().load()
    renderController(options.path ?? '/chat')
    await waitFor(() => {
      expect(screen.getByTestId('project-item-p1')).toBeInTheDocument()
    })
    return { server, bridge }
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.localStorage.clear()
  })

  const projectRowOrder = (): string[] =>
    screen.getAllByTestId(/^project-item-/).map((row) => row.getAttribute('data-testid') ?? '')

  it('置顶项目：写 settings.pinnedProjects，行排到最前、带图钉标识；取消置顶还原', async () => {
    const { bridge } = await mountProjects()
    expect(projectRowOrder()).toEqual(['project-item-p1', 'project-item-p2'])

    pick('project-more-p2', 'project-pin-p2')

    await waitFor(() => {
      expect(bridge.update).toHaveBeenCalledWith({ pinnedProjects: ['p2'] })
    })
    await waitFor(() => {
      expect(projectRowOrder()).toEqual(['project-item-p2', 'project-item-p1'])
    })
    expect(screen.getByTestId('project-pin-mark-p2')).toBeInTheDocument()

    // 已置顶：菜单变「取消置顶项目」，写回空表、顺序还原
    pick('project-more-p2', 'project-pin-p2')
    await waitFor(() => {
      expect(bridge.update).toHaveBeenLastCalledWith({ pinnedProjects: [] })
    })
    await waitFor(() => {
      expect(projectRowOrder()).toEqual(['project-item-p1', 'project-item-p2'])
    })
    expect(screen.queryByTestId('project-pin-mark-p2')).not.toBeInTheDocument()
  })

  it('⊕：在该项目下开新会话（草稿挂进项目 + PUT 映射 + 回对话页）', async () => {
    const { server } = await mountProjects({ path: '/settings' })
    const before = useSessionsStore.getState().activeId

    fireEvent.click(screen.getByTestId('project-new-session-p2'))

    await waitFor(() => {
      const draftId = useSessionsStore.getState().activeId
      expect(draftId).not.toBe(before)
      expect(server.mappings).toEqual([{ threadId: draftId, projectId: 'p2' }])
      expect(screen.getByTestId('project-group-p2')).toContainElement(
        screen.getByTestId(`session-item-${draftId}`)
      )
    })
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })

  /* round 55：全局「新建会话」不再继承"最后浏览的项目"——不挂映射、不 PUT、不落进项目分组 */
  it('全局「新建会话」：当前会话属于 p2 时新草稿仍无项目（无映射、无 PUT、不在 p2 组下）', async () => {
    const { server } = await mountProjects({ mappings: [{ threadId: 't-a', projectId: 'p2' }] })
    await waitFor(() => {
      expect(screen.getByTestId('project-sessions-p2')).toContainElement(
        screen.getByTestId('session-item-t-a')
      )
    })
    // 首屏选中的就是 p2 里那条（"最后浏览的项目"最容易被继承的情形）
    expect(useSessionsStore.getState().activeId).toBe('t-a')

    fireEvent.click(screen.getByTestId('new-session'))

    await waitFor(() => {
      const draftId = useSessionsStore.getState().activeId
      expect(draftId).not.toBe('t-a')
      // 服务端那边的映射没有任何变化：新草稿不在里面，也没有 PUT 发出去
      expect(server.mappings).toEqual([{ threadId: 't-a', projectId: 'p2' }])
      expect(server.calls.some((call) => call.method === 'PUT')).toBe(false)
      // 新草稿不在 p2 组下（项目分组里没有它），它在「任务」组里正常渲染
      const draftRow = screen.getByTestId(`session-item-${draftId}`)
      expect(draftRow.closest('[data-testid="project-sessions-p2"]')).toBeNull()
      expect(screen.getByTestId('tasks-sessions')).toContainElement(draftRow)
      expect(screen.getByTestId(`session-row-${draftId}`)).toHaveClass('bg-selected')
    })
    expect(screen.getByTestId('location')).toHaveTextContent('/chat')
  })

  it('重命名项目：projects:rename(id, name)，行名换成落盘回吐', async () => {
    const { bridge } = await mountProjects()

    pick('project-more-p1', 'project-rename-p1')
    fireEvent.change(screen.getByTestId('project-rename-input'), { target: { value: '甲甲' } })
    fireEvent.click(screen.getByTestId('project-rename-save'))

    await waitFor(() => {
      expect(bridge.projects.rename).toHaveBeenCalledWith('p1', '甲甲')
    })
    await waitFor(() => {
      expect(screen.getByTestId('project-item-p1')).toHaveTextContent('甲甲')
    })
  })

  it('在文件资源管理器中打开项目：projects:openInExplorer；失败露 project-error（剥 IPC 包装）', async () => {
    const { bridge } = await mountProjects()

    pick('project-more-p1', 'project-open-p1')
    await waitFor(() => {
      expect(bridge.projects.openInExplorer).toHaveBeenCalledWith('p1')
    })

    bridge.projects.openInExplorer.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'projects:open-in-explorer': Error: 打不开这个文件夹：拒绝访问"
      )
    )
    pick('project-more-p1', 'project-open-p1')
    await waitFor(() => {
      expect(screen.getByTestId('project-error')).toHaveTextContent('拒绝访问')
    })
    expect(screen.getByTestId('project-error')).not.toHaveTextContent(
      'Error invoking remote method'
    )
  })

  it('归档项目：写快照（名称/路径/时间）进 settings.archivedProjects，行与名下会话一起消失；取消归档一并回来', async () => {
    const { bridge } = await mountProjects({ mappings: [{ threadId: 't-b', projectId: 'p2' }] })
    await waitFor(() => {
      expect(screen.getByTestId('project-sessions-p2')).toContainElement(
        screen.getByTestId('session-item-t-b')
      )
    })

    pick('project-more-p2', 'project-archive-p2')

    await waitFor(() => {
      const patch = bridge.update.mock.calls.at(-1)?.[0] as {
        archivedProjects?: {
          projectId: string
          name: string
          path: string
          archivedAt: string
        }[]
      }
      expect(patch.archivedProjects?.[0]).toMatchObject({
        projectId: 'p2',
        name: '乙项目',
        path: 'D:\\ws\\乙'
      })
      expect(typeof patch.archivedProjects?.[0]?.archivedAt).toBe('string')
    })
    // 项目行与它名下的会话一起从侧栏消失；p1 与无项目会话不受影响
    await waitFor(() => {
      expect(screen.queryByTestId('project-item-p2')).not.toBeInTheDocument()
      expect(screen.queryByTestId('session-item-t-b')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('project-item-p1')).toBeInTheDocument()
    expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()

    // 取消归档（设置页走同一只 store 方法）：项目与名下会话一并回来
    const archived = useSettingsStore.getState().settings.archivedProjects
    await useSettingsStore.getState().unarchiveProject(archived[0].projectId)
    await waitFor(() => {
      expect(screen.getByTestId('project-item-p2')).toBeInTheDocument()
      expect(screen.getByTestId('project-sessions-p2')).toContainElement(
        screen.getByTestId('session-item-t-b')
      )
    })
  })

  it('归档失败：行还在、project-error 露原因', async () => {
    const { bridge } = await mountProjects()
    bridge.update.mockRejectedValueOnce(new Error('设置通道不可用'))

    pick('project-more-p2', 'project-archive-p2')

    await waitFor(() => {
      expect(screen.getByTestId('project-error')).toHaveTextContent('设置通道不可用')
    })
    expect(screen.getByTestId('project-item-p2')).toBeInTheDocument()
  })
})

describe('SessionsController·round 26：草稿会话的动作（侧栏）', () => {
  async function draftAfterNewSession(): Promise<string> {
    renderController()
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByTestId('new-session'))
    return useSessionsStore.getState().activeId!
  }

  it('草稿置顶：先物化（POST /api/threads）再写 pinnedThreads，行排到最前', async () => {
    const server = installFakeServer(THREADS)
    const draftId = await draftAfterNewSession()

    pick(`session-more-${draftId}`, `session-pin-${draftId}`)

    await waitFor(() => {
      expect(server.calls).toContainEqual({
        method: 'POST',
        path: '/api/threads',
        body: { threadId: draftId }
      })
    })
    await waitFor(() => {
      expect(useSettingsStore.getState().settings.pinnedThreads).toEqual([draftId])
    })
    await waitFor(() => {
      expect(
        screen.getAllByTestId(/^session-row-/).map((row) => row.getAttribute('data-testid'))
      ).toEqual([`session-row-${draftId}`, 'session-row-t-a', 'session-row-t-b'])
    })
    expect(screen.getByTestId(`session-pin-mark-${draftId}`)).toBeInTheDocument()
  })

  it('草稿移至项目：先物化，再走映射通道（PUT）；会话进项目分组', async () => {
    const initial = {
      ...defaultSettings(),
      projects: [
        { id: 'p1', name: '项目一', path: 'D:\\p1', createdAt: '2026-10-11T00:00:00.000Z' }
      ]
    }
    installKyclawBridge(initial)
    useSettingsStore.setState({ settings: initial, loaded: true })
    const server = installFakeServer(THREADS)
    const draftId = await draftAfterNewSession()

    fireEvent.keyDown(screen.getByTestId(`session-more-${draftId}`), { key: 'ArrowDown' })
    const trigger = screen.getByTestId(`session-move-${draftId}`)
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'ArrowRight' })
    await tick()
    fireEvent.click(screen.getByTestId(`session-move-${draftId}-p1`))

    await waitFor(() => {
      expect(server.calls).toContainEqual({
        method: 'POST',
        path: '/api/threads',
        body: { threadId: draftId }
      })
    })
    await waitFor(() => {
      expect(server.mappings).toEqual([{ threadId: draftId, projectId: 'p1' }])
    })
    await waitFor(() => {
      expect(screen.getByTestId('project-sessions-p1')).toContainElement(
        screen.getByTestId(`session-item-${draftId}`)
      )
    })
  })

  it('草稿重命名（就地）：侧栏行显示本地标题、不发 PATCH', async () => {
    const server = installFakeServer(THREADS)
    const draftId = await draftAfterNewSession()

    pick(`session-more-${draftId}`, `session-rename-${draftId}`)
    const input = await screen.findByTestId('session-rename-input')
    fireEvent.change(input, { target: { value: '草稿名' } })
    fireEvent.click(screen.getByTestId('session-rename-save'))

    await waitFor(() => {
      expect(screen.getByTestId(`session-item-${draftId}`)).toHaveTextContent('草稿名')
    })
    expect(server.calls.some((call) => call.method === 'PATCH')).toBe(false)
  })

  it('草稿删除（就地）：行消失、不发 DELETE，选中接力回最近的真实会话', async () => {
    const server = installFakeServer(THREADS)
    const draftId = await draftAfterNewSession()

    pick(`session-more-${draftId}`, `session-delete-${draftId}`)
    fireEvent.click(await screen.findByTestId('session-delete-confirm'))

    await waitFor(() => {
      expect(screen.queryByTestId(`session-item-${draftId}`)).not.toBeInTheDocument()
    })
    expect(server.calls.some((call) => call.method === 'DELETE')).toBe(false)
    expect(useSessionsStore.getState().activeId).toBe('t-a')
  })
})

describe('SessionsController·round 61：「任务」组（没有项目的会话）', () => {
  const PROJECTS: AppSettings['projects'] = [
    { id: 'p1', name: '插件', path: 'D:\\ws\\插件', createdAt: '2026-10-11T00:00:00.000Z' }
  ]

  /** 挂上"有一个项目"的侧栏；默认没有映射 = 所有会话都没有项目 */
  async function mountTasks(
    mappings: MappingRow[] = []
  ): Promise<ReturnType<typeof installFakeServer>> {
    const server = installFakeServer(THREADS, mappings)
    clearKyclawBridge()
    installKyclawBridge({ ...defaultSettings(), projects: PROJECTS })
    await useSettingsStore.getState().load()
    renderController()
    await waitFor(() => {
      expect(screen.getByTestId('project-item-p1')).toBeInTheDocument()
    })
    return server
  }

  const rowOrder = (): (string | null)[] =>
    screen.getAllByTestId(/^session-row-/).map((row) => row.getAttribute('data-testid'))

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.localStorage.clear()
  })

  it('分桶：无项目会话在「任务」组里平铺；项目名下的只在项目下（不再有 今天/更早 子分组）', async () => {
    await mountTasks([{ threadId: 't-b', projectId: 'p1' }])
    await waitFor(() => {
      expect(screen.getByTestId('project-sessions-p1')).toContainElement(
        screen.getByTestId('session-item-t-b')
      )
    })

    const tasks = screen.getByTestId('session-group-tasks')
    expect(tasks).toHaveTextContent('任务')
    expect(tasks).toContainElement(screen.getByTestId('session-item-t-a'))
    expect(tasks).not.toContainElement(screen.getByTestId('session-item-t-b'))
    // 组内平铺：行直接排在「任务」组的那一个列表里（没有 今天/更早/置顶 这类子分组）
    const tasksList = tasks.querySelector('[data-testid="session-list"]')
    expect(tasksList).not.toBeNull()
    expect(tasksList).toContainElement(screen.getByTestId('session-row-t-a'))
    for (const stale of ['session-group-today', 'session-group-earlier', 'session-group-pinned']) {
      expect(screen.queryByTestId(stale)).not.toBeInTheDocument()
    }
  })

  it('点组头折叠/展开：aria-expanded 与 data-open 切换，收起状态记进 localStorage（与项目折叠同一份存储）', async () => {
    await mountTasks()
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })

    const head = screen.getByTestId('tasks-item')
    const fold = screen.getByTestId('tasks-sessions')
    expect(head).toHaveAttribute('aria-expanded', 'true')
    expect(fold).toHaveAttribute('data-open', 'true')

    fireEvent.click(head)

    expect(head).toHaveAttribute('aria-expanded', 'false')
    expect(fold).toHaveAttribute('data-open', 'false')
    expect(window.localStorage.getItem('kyclaw.projects.collapsed')).toContain('__tasks__')
    // 收起 ≠ 卸载：内容留在 DOM 里走 .trace-fold 的过渡
    expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()

    fireEvent.click(head)
    expect(fold).toHaveAttribute('data-open', 'true')
  })

  it('重启后保持：存储里记着 __tasks__ 时首屏就是收起的', async () => {
    window.localStorage.setItem('kyclaw.projects.collapsed', JSON.stringify(['__tasks__']))
    await mountTasks()
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })

    expect(screen.getByTestId('tasks-sessions')).toHaveAttribute('data-open', 'false')
    expect(screen.getByTestId('tasks-item')).toHaveAttribute('aria-expanded', 'false')
  })

  it('无项目会话为 0 时：整组不渲染（组头也不留）', async () => {
    await mountTasks([
      { threadId: 't-a', projectId: 'p1' },
      { threadId: 't-b', projectId: 'p1' }
    ])
    await waitFor(() => {
      expect(screen.getByTestId('project-sessions-p1')).toContainElement(
        screen.getByTestId('session-item-t-a')
      )
    })

    expect(screen.queryByTestId('session-group-tasks')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tasks-item')).not.toBeInTheDocument()
    expect(screen.queryByTestId('tasks-sessions')).not.toBeInTheDocument()
  })

  it('置顶的会话在「任务」组里排最前（组内顺序由 composeSidebarSessions 给）', async () => {
    useSettingsStore.setState({
      settings: { ...defaultSettings(), projects: PROJECTS, pinnedThreads: ['t-b'] },
      loaded: true
    })
    installFakeServer(THREADS)
    renderController()
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-b')).toBeInTheDocument()
    })

    expect(rowOrder()).toEqual(['session-row-t-b', 'session-row-t-a'])
    expect(screen.getByTestId('session-pin-mark-t-b')).toBeInTheDocument()
  })

  it('010：后台会话在跑 → 行上画灰圈（切走也看得见）；跑完撤下', async () => {
    await mountTasks()
    await waitFor(() => {
      expect(screen.getByTestId('session-item-t-a')).toBeInTheDocument()
    })

    act(() => useThreadRunStore.getState().setRunning('t-b', true))

    expect(screen.getByTestId('tasks-sessions')).toContainElement(
      screen.getByTestId('session-running-t-b')
    )
    // 当前会话（首屏选中 t-a）不受影响
    expect(screen.queryByTestId('session-running-t-a')).not.toBeInTheDocument()

    act(() => useThreadRunStore.getState().setRunning('t-b', false))
    expect(screen.queryByTestId('session-running-t-b')).not.toBeInTheDocument()
  })

  it('010：项目名下的会话在跑 → 项目分组里同样画灰圈（只画一处，不重复）', async () => {
    await mountTasks([{ threadId: 't-b', projectId: 'p1' }])
    await waitFor(() => {
      expect(screen.getByTestId('project-sessions-p1')).toContainElement(
        screen.getByTestId('session-item-t-b')
      )
    })

    act(() => useThreadRunStore.getState().setRunning('t-b', true))

    expect(screen.getByTestId('project-sessions-p1')).toContainElement(
      screen.getByTestId('session-running-t-b')
    )
    expect(screen.getAllByTestId(/^session-running-/)).toHaveLength(1)
  })
})

/**
 * 0.2.2（用户 2026-10-20 拍板）：501 下恢复侧栏「项目」区，且**新会话必须落进项目目录**。
 *
 * 501 下归属由内核 session 的 cwd 推导（projects-store.syncFromCwd），所以"落进项目"不能靠
 * 旧映射表——靠物化 `POST /api/threads` 带 projectId（服务端把项目 path 变成内核 cwd）。
 * 这里从侧栏的真实入口走一遍：项目行 ⊕、新建项目后自动开会话、删项目后会话回「任务」组。
 */
describe('0.2.2：501 下的项目区（恢复 + 新会话落项目目录）', () => {
  const PROJECTS: AppSettings['projects'] = [
    { id: 'p1', name: '插件', path: 'D:\\ws\\插件', createdAt: '2026-10-11T00:00:00.000Z' }
  ]

  /** 挂一个"映射通道 501、项目清单里有 p1"的侧栏，并等落位与推导完成 */
  async function mountUnavailable(
    threads: ThreadRow[] = []
  ): Promise<{ server: ReturnType<typeof installFakeServer> }> {
    const server = installFakeServer(threads, [], { mappingsUnavailable: true })
    clearKyclawBridge()
    installKyclawBridge({ ...defaultSettings(), projects: PROJECTS })
    await useSettingsStore.getState().load()
    renderController('/settings')
    await waitFor(() => {
      expect(useProjectsStore.getState().unavailable).toBe(true)
    })
    await waitFor(() => {
      expect(screen.getByTestId('project-item-p1')).toBeInTheDocument()
    })
    return { server }
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.localStorage.clear()
  })

  it('项目行 ⊕：草稿挂进项目（不写映射通道）；物化时 POST 带 projectId 落进项目目录', async () => {
    const { server } = await mountUnavailable([])

    fireEvent.click(screen.getByTestId('project-new-session-p1'))

    const draftId = useSessionsStore.getState().activeId!
    await waitFor(() => {
      expect(screen.getByTestId('project-sessions-p1')).toContainElement(
        screen.getByTestId(`session-item-${draftId}`)
      )
    })
    // 501 下没有映射写入（写通道本版没有）
    expect(server.calls.some((call) => call.method === 'PUT')).toBe(false)

    await act(async () => {
      await useSessionsStore.getState().materialize(draftId)
    })

    // 物化带 projectId：服务端据此把内核 cwd 设成项目 path（会话真落进项目目录）
    expect(server.calls).toContainEqual({
      method: 'POST',
      path: '/api/threads',
      body: { threadId: draftId, projectId: 'p1' }
    })
    // 物化回包带 cwd 后，会话仍挂在项目下（这次靠的是 cwd 归组，不是草稿记账）
    await waitFor(() => {
      expect(screen.getByTestId('project-sessions-p1')).toContainElement(
        screen.getByTestId(`session-item-${draftId}`)
      )
    })
    expect(useProjectsStore.getState().draftProjectOf(draftId)).toBeNull()
  })

  it('新建项目（使用现有文件夹）→ 自动开一条该项目下的会话；物化同样带 projectId', async () => {
    const { server } = await mountUnavailable([])

    // 组头 ＋ → 使用现有文件夹（创建本身走 local IPC，不受 501 影响）
    pick('project-add', 'project-create-folder')
    const nameInput = await screen.findByTestId('project-name-input')
    fireEvent.change(nameInput, { target: { value: '新项目' } })
    fireEvent.click(screen.getByTestId('project-path-field'))
    await waitFor(() => {
      expect(screen.getByTestId('project-path-value')).toHaveTextContent(PICKED_FOLDER)
    })
    fireEvent.click(screen.getByTestId('project-create-save'))

    await waitFor(() => {
      expect(useSettingsStore.getState().settings.projects).toHaveLength(2)
    })
    const created = useSettingsStore
      .getState()
      .settings.projects.find((project) => project.name === '新项目')
    expect(created).toBeDefined()
    const draftId = useSessionsStore.getState().activeId!
    expect(draftId).not.toBe('')
    await waitFor(() => {
      expect(screen.getByTestId(`project-group-${created!.id}`)).toContainElement(
        screen.getByTestId(`session-item-${draftId}`)
      )
    })
    expect(server.calls.some((call) => call.method === 'PUT')).toBe(false)

    await act(async () => {
      await useSessionsStore.getState().materialize(draftId)
    })
    expect(server.calls).toContainEqual({
      method: 'POST',
      path: '/api/threads',
      body: { threadId: draftId, projectId: created!.id }
    })
  })

  it('删项目：项目行消失，名下会话按 cwd 不再命中任何项目 → 回到「任务」组', async () => {
    await mountUnavailable([
      { id: 't-a', title: '无项目会话', updatedAt: TODAY },
      { id: 't-b', title: '插件里的会话', updatedAt: EARLIER, cwd: 'D:\\ws\\插件\\src' }
    ])
    await waitFor(() => {
      expect(screen.getByTestId('project-sessions-p1')).toContainElement(
        screen.getByTestId('session-item-t-b')
      )
    })

    pick('project-more-p1', 'project-delete-p1')
    fireEvent.click(await screen.findByTestId('project-delete-confirm'))

    await waitFor(() => {
      expect(screen.queryByTestId('project-item-p1')).not.toBeInTheDocument()
    })
    // 项目没了 → cwd 推不出归属：会话回到「任务」组（不是永远挂在已删项目下）
    await waitFor(() => {
      expect(screen.getByTestId('tasks-sessions')).toContainElement(
        screen.getByTestId('session-item-t-b')
      )
    })
  })
})
