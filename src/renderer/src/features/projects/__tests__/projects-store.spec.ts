import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { defaultSettings, type AppSettings } from '@shared/settings'
import type { ThreadSummary } from '@shared/threads'
import { resetProjectsStore, useProjectsStore } from '../projects-store'

/**
 * 会话↔项目映射的 store（T18）：与服务端（/api/projects/mappings）的读写口径。
 * 关注：镜像以服务端为准；写是乐观 + 失败回滚；在飞期间不被旧快照拽回去；失败落 error 不抛。
 *
 * 0.2.2：501 下映射不再来自服务端，而是从**内核 session 的 cwd** 推导（见最后一个 describe）——
 * 侧栏项目区因此恢复，且不画「项目加载失败」。
 */
interface MappingRow {
  threadId: string
  projectId: string
}

function installFakeServer(initial: MappingRow[] = []): {
  rows: MappingRow[]
  calls: { method: string; path: string; body: unknown }[]
  putStatus: number
  getStatus: number
  failNextGet: Error | null
  /** PUT 卡住用（在飞期间的观察）：非 null 时先 await 它再回包 */
  putWait: Promise<void> | null
} {
  const server = {
    rows: [...initial],
    calls: [] as { method: string; path: string; body: unknown }[],
    putStatus: 200,
    getStatus: 200,
    failNextGet: null as Error | null,
    putWait: null as Promise<void> | null
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const method = init.method ?? 'GET'
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      server.calls.push({ method, path: url.pathname, body })
      if (url.pathname !== '/api/projects/mappings') {
        throw new Error(`假服务没实现：${method} ${url.pathname}`)
      }
      if (method === 'GET') {
        if (server.failNextGet !== null) {
          const error = server.failNextGet
          server.failNextGet = null
          throw error
        }
        if (server.getStatus !== 200) {
          return new Response(
            JSON.stringify({
              error: 'feature-disabled',
              feature: 'projects',
              availableIn: '0.2.x'
            }),
            { status: server.getStatus, headers: { 'content-type': 'application/json' } }
          )
        }
        return new Response(JSON.stringify({ sessions: server.rows }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (method === 'PUT') {
        await server.putWait
        if (server.putStatus !== 200) return new Response('{}', { status: server.putStatus })
        const { threadId, projectId } = body as { threadId: string; projectId: string | null }
        server.rows = server.rows.filter((row) => row.threadId !== threadId)
        if (projectId !== null) server.rows.push({ threadId, projectId })
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      throw new Error(`假服务没实现：${method} ${url.pathname}`)
    })
  )
  return server
}

beforeEach(() => {
  installKyclawBridge()
  resetProjectsStore()
})

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
})

describe('projects-store：读映射', () => {
  it('首屏拉一次（重复调用去重），映进 mappings', async () => {
    const server = installFakeServer([{ threadId: 't1', projectId: 'p1' }])

    await useProjectsStore.getState().ensureLoaded()
    await useProjectsStore.getState().ensureLoaded()

    expect(server.calls.filter((call) => call.method === 'GET')).toHaveLength(1)
    expect(useProjectsStore.getState().mappings).toEqual({ t1: 'p1' })
    expect(useProjectsStore.getState().loaded).toBe(true)
    expect(useProjectsStore.getState().projectOf('t1')).toBe('p1')
    expect(useProjectsStore.getState().projectOf('t2')).toBeNull()
    expect(useProjectsStore.getState().projectOf(null)).toBeNull()
  })

  it('拉不到：error 落位、不抛（侧栏照常工作，会话按"无项目"跑）', async () => {
    const server = installFakeServer()
    server.failNextGet = new Error('服务没起来')

    await expect(useProjectsStore.getState().ensureLoaded()).resolves.toBeUndefined()
    expect(useProjectsStore.getState().error).toContain('服务没起来')
    expect(useProjectsStore.getState().loaded).toBe(true)
  })

  /**
   * 0.2.1（PB-053）：501 feature-disabled = 本版主动下架，不是"加载失败"。
   * 不能落 error（侧栏会画红字「项目加载失败 + 重试」，而重试永远失败），映射保持空。
   */
  it('501 feature-disabled：落 unavailable、不落 error、不留映射（不是加载失败）', async () => {
    const server = installFakeServer([{ threadId: 't1', projectId: 'p1' }])
    server.getStatus = 501

    await expect(useProjectsStore.getState().ensureLoaded()).resolves.toBeUndefined()
    const state = useProjectsStore.getState()
    expect(state.unavailable).toBe(true)
    expect(state.error).toBeNull()
    expect(state.mappings).toEqual({})
    expect(state.loaded).toBe(true)
    // 已经知道不可用就不再反复打路由（重试没有意义）
    await useProjectsStore.getState().ensureLoaded()
    expect(server.calls.filter((call) => call.method === 'GET')).toHaveLength(1)
  })

  it('501 之后写映射：直接跳过（不 PUT、不报错、不假装成功）', async () => {
    const server = installFakeServer()
    server.getStatus = 501
    await useProjectsStore.getState().ensureLoaded()
    server.calls.length = 0

    await useProjectsStore.getState().assignSession('t1', 'p1')

    expect(server.calls).toEqual([])
    expect(useProjectsStore.getState().mappings).toEqual({})
    expect(useProjectsStore.getState().error).toBeNull()
  })
})

describe('projects-store：写映射', () => {
  it('新建会话归属项目：本地立刻可见 + PUT 落到服务端', async () => {
    const server = installFakeServer()
    await useProjectsStore.getState().assignSession('t1', 'p1')

    expect(useProjectsStore.getState().mappings).toEqual({ t1: 'p1' })
    expect(server.calls).toEqual([
      expect.objectContaining({
        method: 'PUT',
        path: '/api/projects/mappings',
        body: { threadId: 't1', projectId: 'p1' }
      })
    ])
    expect(server.rows).toEqual([{ threadId: 't1', projectId: 'p1' }])
  })

  it('摘出项目：projectId=null 的 PUT，本地也跟着去掉', async () => {
    const server = installFakeServer([{ threadId: 't1', projectId: 'p1' }])
    await useProjectsStore.getState().ensureLoaded()

    await useProjectsStore.getState().assignSession('t1', null)

    expect(useProjectsStore.getState().mappings).toEqual({})
    expect(server.rows).toEqual([])
  })

  it('写失败：回滚本地并落 error（服务端不知道的归属不该在侧栏显示）', async () => {
    const server = installFakeServer([{ threadId: 't1', projectId: 'p1' }])
    await useProjectsStore.getState().ensureLoaded()
    server.putStatus = 500

    await useProjectsStore.getState().assignSession('t1', 'p2')

    expect(useProjectsStore.getState().mappings).toEqual({ t1: 'p1' })
    expect(useProjectsStore.getState().error).toContain('500')
  })

  it('在飞期间来的旧快照不会把本地刚写的归属拽掉', async () => {
    const server = installFakeServer()
    // 本地先写（此时服务端快照还没包含它）
    await useProjectsStore.getState().assignSession('draft-1', 'p1')
    // 模拟"旧快照"（服务端还不知道 draft-1）——ensureLoaded 的合并规则要保留本地值
    server.rows = []
    await useProjectsStore.getState().refresh()

    expect(useProjectsStore.getState().mappings).toEqual({ 'draft-1': 'p1' })

    // 服务端知道之后，以服务端为准（这里服务端说"没有" → 本地丢掉）
    await useProjectsStore.getState().assignSession('draft-1', null)
    expect(useProjectsStore.getState().mappings).toEqual({})
  })

  it('清某个项目名下所有会话的归属（项目被删后的收尾）', async () => {
    const server = installFakeServer([
      { threadId: 't1', projectId: 'p1' },
      { threadId: 't2', projectId: 'p2' },
      { threadId: 't3', projectId: 'p1' }
    ])
    await useProjectsStore.getState().ensureLoaded()

    await useProjectsStore.getState().clearProjectMappings('p1')

    expect(useProjectsStore.getState().mappings).toEqual({ t2: 'p2' })
    expect(server.rows).toEqual([{ threadId: 't2', projectId: 'p2' }])
  })
})

describe('projects-store：在写标记（pending，round 49）', () => {
  it('写映射期间标 pending，回执落地后清掉 —— 工作台据此先不按根开工', async () => {
    const server = installFakeServer()
    let release: () => void = () => undefined
    server.putWait = new Promise((resolve) => {
      release = () => resolve()
    })

    const writing = useProjectsStore.getState().assignSession('t1', 'p1')

    // 本地立刻可见（侧栏/标题要跟手）——但服务端还没回执，主进程还按旧口径解析根
    expect(useProjectsStore.getState().mappings).toEqual({ t1: 'p1' })
    expect(useProjectsStore.getState().pending).toEqual({ t1: true })

    release()
    await writing

    expect(useProjectsStore.getState().pending).toEqual({})
    expect(server.rows).toEqual([{ threadId: 't1', projectId: 'p1' }])
  })

  it('写失败也清 pending（回滚后两边口径又一致了）', async () => {
    const server = installFakeServer([{ threadId: 't1', projectId: 'p1' }])
    await useProjectsStore.getState().ensureLoaded()
    server.putStatus = 500

    const writing = useProjectsStore.getState().assignSession('t1', 'p2')
    expect(useProjectsStore.getState().pending).toEqual({ t1: true })

    await writing

    expect(useProjectsStore.getState().pending).toEqual({})
    expect(useProjectsStore.getState().mappings).toEqual({ t1: 'p1' })
  })
})

/**
 * 0.2.2（501）：项目区的会话归属改从内核 session 的 cwd 推导（旧映射 API 下架）。
 * 这里钉住推导的触发边界（列表/项目清单变化后重算）、草稿的本地记账，以及"cwd 是真相"的优先级。
 */
describe('projects-store：0.2.2 从内核 cwd 推导归属（501）', () => {
  const ISO = '2026-10-20T00:00:00.000Z'
  const PROJECTS: AppSettings['projects'] = [
    { id: 'p1', name: '插件', path: 'D:\\ws\\插件', createdAt: ISO },
    { id: 'p2', name: '插件子项目', path: 'D:\\ws\\插件\\子项目', createdAt: ISO }
  ]

  const thread = (id: string, cwd?: string): ThreadSummary => ({
    id,
    title: null,
    updatedAt: ISO,
    ...(cwd === undefined ? {} : { cwd })
  })

  function givenProjects(projects: AppSettings['projects'] = PROJECTS): void {
    useSettingsStore.setState({
      settings: { ...defaultSettings(), projects },
      loaded: true
    })
  }

  /** 走一次 501 的加载（映射通道下架）——之后 mappings 由 syncFromCwd 负责 */
  async function enterUnavailable(): Promise<void> {
    const server = installFakeServer()
    server.getStatus = 501
    await useProjectsStore.getState().ensureLoaded()
    expect(useProjectsStore.getState().unavailable).toBe(true)
  }

  it('cwd 落在项目路径下 → 归到对应项目（嵌套取最具体）；项目外/没 cwd 的会话不动', async () => {
    givenProjects()
    await enterUnavailable()

    useProjectsStore
      .getState()
      .syncFromCwd([
        thread('t1', 'D:\\ws\\插件\\src'),
        thread('t2', 'D:\\ws\\插件\\子项目\\deep'),
        thread('t3', 'E:\\外部目录'),
        thread('t4')
      ])

    const state = useProjectsStore.getState()
    expect(state.mappings).toEqual({ t1: 'p1', t2: 'p2' })
    expect(state.projectOf('t1')).toBe('p1')
    expect(state.projectOf('t3')).toBeNull()
    // 501 仍是"写通道没有"，不是错误：不落红字、不反复重试
    expect(state.unavailable).toBe(true)
    expect(state.error).toBeNull()
  })

  it('项目清单变了要重算：删掉项目后，名下会话回到"无项目"', async () => {
    givenProjects()
    await enterUnavailable()
    useProjectsStore.getState().syncFromCwd([thread('t1', 'D:\\ws\\插件\\src')])
    expect(useProjectsStore.getState().mappings).toEqual({ t1: 'p1' })

    givenProjects(PROJECTS.slice(1))
    useProjectsStore.getState().syncFromCwd([thread('t1', 'D:\\ws\\插件\\src')])

    expect(useProjectsStore.getState().mappings).toEqual({})
  })

  it('映射通道可用（200）时 syncFromCwd 不改服务端快照（历史口径不变）', async () => {
    installFakeServer([{ threadId: 't1', projectId: 'p2' }])
    await useProjectsStore.getState().ensureLoaded()
    givenProjects()

    useProjectsStore.getState().syncFromCwd([thread('t1', 'D:\\ws\\插件')])

    expect(useProjectsStore.getState().mappings).toEqual({ t1: 'p2' })
  })

  it('草稿本地记账：侧栏先挂上 + pending；物化带出 cwd 后收敛为 cwd 归属、pending 收起', async () => {
    givenProjects()
    await enterUnavailable()

    useProjectsStore.getState().rememberDraftProject('draft-1', 'p1')
    expect(useProjectsStore.getState().mappings).toEqual({ 'draft-1': 'p1' })
    expect(useProjectsStore.getState().pending).toEqual({ 'draft-1': true })
    expect(useProjectsStore.getState().draftProjectOf('draft-1')).toBe('p1')

    // 物化回包没带 cwd（旧服务端/测试桩）：先保留本地记账，别让草稿闪到「任务」组
    useProjectsStore.getState().syncFromCwd([thread('draft-1')])
    expect(useProjectsStore.getState().mappings).toEqual({ 'draft-1': 'p1' })
    expect(useProjectsStore.getState().pending).toEqual({ 'draft-1': true })

    // 列表带出内核 cwd：归属以它为准，本地记账退场
    useProjectsStore.getState().syncFromCwd([thread('draft-1', 'D:\\ws\\插件')])
    expect(useProjectsStore.getState().mappings).toEqual({ 'draft-1': 'p1' })
    expect(useProjectsStore.getState().pending).toEqual({})
    expect(useProjectsStore.getState().draftProjectOf('draft-1')).toBeNull()
  })

  it('草稿记账与内核 cwd 冲突时以 cwd 为准（本地记账不盖过内核事实）', async () => {
    givenProjects()
    await enterUnavailable()
    useProjectsStore.getState().rememberDraftProject('draft-1', 'p1')

    useProjectsStore.getState().syncFromCwd([thread('draft-1', 'E:\\外部目录')])

    expect(useProjectsStore.getState().mappings).toEqual({})
    expect(useProjectsStore.getState().pending).toEqual({})
    expect(useProjectsStore.getState().draftProjectOf('draft-1')).toBeNull()
  })

  it('草稿指向已删项目：重算时作废（不挂在已经不存在的项目上）', async () => {
    givenProjects()
    await enterUnavailable()
    useProjectsStore.getState().rememberDraftProject('draft-1', 'p1')

    givenProjects([])
    useProjectsStore.getState().syncFromCwd([thread('draft-1')])

    expect(useProjectsStore.getState().mappings).toEqual({})
    expect(useProjectsStore.getState().pending).toEqual({})
  })

  it('forgetLocalSession：草稿删除后本地几笔（mappings / pending / 草稿记账）一起清掉', async () => {
    givenProjects()
    await enterUnavailable()
    useProjectsStore.getState().rememberDraftProject('draft-1', 'p1')

    useProjectsStore.getState().forgetLocalSession('draft-1')

    expect(useProjectsStore.getState().mappings).toEqual({})
    expect(useProjectsStore.getState().pending).toEqual({})
    expect(useProjectsStore.getState().draftProjectOf('draft-1')).toBeNull()
  })

  it('删项目：clearProjectMappings 在 501 下只清本地（不 PUT、不报错）', async () => {
    const server = installFakeServer()
    server.getStatus = 501
    await useProjectsStore.getState().ensureLoaded()
    givenProjects()
    useProjectsStore.getState().syncFromCwd([thread('t1', 'D:\\ws\\插件')])
    expect(useProjectsStore.getState().mappings).toEqual({ t1: 'p1' })
    server.calls.length = 0

    await useProjectsStore.getState().clearProjectMappings('p1')

    expect(useProjectsStore.getState().mappings).toEqual({})
    expect(useProjectsStore.getState().error).toBeNull()
    expect(server.calls).toEqual([])
  })
})
