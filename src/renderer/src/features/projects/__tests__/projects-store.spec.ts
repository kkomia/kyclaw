import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { resetProjectsStore, useProjectsStore } from '../projects-store'

/**
 * 会话↔项目映射的 store（T18）：与服务端（/api/projects/mappings）的读写口径。
 * 关注：镜像以服务端为准；写是乐观 + 失败回滚；在飞期间不被旧快照拽回去；失败落 error 不抛。
 */
interface MappingRow {
  threadId: string
  projectId: string
}

function installFakeServer(initial: MappingRow[] = []): {
  rows: MappingRow[]
  calls: { method: string; path: string; body: unknown }[]
  putStatus: number
  failNextGet: Error | null
  /** PUT 卡住用（在飞期间的观察）：非 null 时先 await 它再回包 */
  putWait: Promise<void> | null
} {
  const server = {
    rows: [...initial],
    calls: [] as { method: string; path: string; body: unknown }[],
    putStatus: 200,
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
