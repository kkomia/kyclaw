import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import type { OutgoingMessage } from '@renderer/features/chat/composer-attachments'
import {
  resetPptTemplatesStore,
  usePptTemplatesStore
} from '@renderer/features/chat/ppt-templates-store'
import { resetThreadChats } from '@renderer/features/chat/thread-chats'
import { resetSessionsStore, useSessionsStore } from '../sessions-store'

/**
 * 会话状态（T9）：线程数据以服务端为准——列表/重命名/删除/标题生成都是 HTTP；
 * store 只做镜像 + 活跃态 + 完成提醒。
 * 网络用一个假 fetch 打桩（按路径路由），断言直接看"发了什么请求、store 变成了什么"。
 */
interface ThreadRow {
  id: string
  title: string | null
  updatedAt: string
}

interface FakeServer {
  threads: ThreadRow[]
  calls: { method: string; path: string; body: unknown }[]
  failNext: (error: Error) => void
  messages: Record<string, unknown[]>
}

function installFakeServer(initial: ThreadRow[] = []): FakeServer {
  let failure: Error | null = null
  const server: FakeServer = {
    threads: [...initial],
    messages: {},
    calls: [],
    failNext(error) {
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
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
      server.calls.push({ method, path: url.pathname, body })

      if (failure !== null) {
        const error = failure
        failure = null
        throw error
      }

      if (url.pathname === '/api/threads' && method === 'GET') {
        return respond({ threads: server.threads })
      }
      if (url.pathname === '/api/threads' && method === 'POST') {
        const { threadId, title } = body as { threadId: string; title?: string }
        const row: ThreadRow = {
          id: threadId,
          title: title ?? null,
          updatedAt: new Date().toISOString()
        }
        if (!server.threads.some((thread) => thread.id === threadId)) {
          server.threads = [row, ...server.threads]
        }
        return respond(row)
      }
      // round 66：会话↔PPT 模板映射（草稿物化那一刻补写的就是它）
      if (url.pathname === '/api/ppt/templates' && method === 'PUT') {
        return respond({ ok: true })
      }
      const renameMatch = /^\/api\/threads\/([^/]+)$/.exec(url.pathname)
      if (renameMatch && method === 'PATCH') {
        const id = decodeURIComponent(renameMatch[1])
        const updated = { ...server.threads.find((row) => row.id === id)! }
        updated.title = (body as { title: string }).title
        server.threads = server.threads.map((row) => (row.id === id ? updated : row))
        return respond(updated)
      }
      if (renameMatch && method === 'DELETE') {
        const id = decodeURIComponent(renameMatch[1])
        server.threads = server.threads.filter((row) => row.id !== id)
        return respond({ ok: true })
      }
      const titleMatch = /^\/api\/threads\/([^/]+)\/title$/.exec(url.pathname)
      if (titleMatch && method === 'POST') {
        const id = decodeURIComponent(titleMatch[1])
        const row = server.threads.find((thread) => thread.id === id)
        const title = row?.title ?? '生成的标题'
        server.threads = server.threads.map((thread) =>
          thread.id === id ? { ...thread, title } : thread
        )
        return respond({ title, generated: row?.title == null })
      }
      const messagesMatch = /^\/api\/threads\/([^/]+)\/messages$/.exec(url.pathname)
      if (messagesMatch) {
        return respond({ messages: server.messages[decodeURIComponent(messagesMatch[1])] ?? [] })
      }
      throw new Error(`假服务没实现这条路由：${method} ${url.pathname}`)
    })
  )

  return server
}

/** Web Notification 的假件：记下被构造的通知 */
class FakeNotification {
  static permission: NotificationPermission = 'granted'
  static instances: FakeNotification[] = []
  constructor(
    readonly title: string,
    readonly options?: { body?: string }
  ) {
    FakeNotification.instances.push(this)
  }
  static requestPermission = vi.fn(async () => 'granted' as NotificationPermission)
}

const THREADS: ThreadRow[] = [
  { id: 't-new', title: '最近的会话', updatedAt: '2026-10-10T09:00:00.000Z' },
  { id: 't-old', title: '更早的会话', updatedAt: '2026-10-08T09:00:00.000Z' }
]

/** 失败用例会往控制台打原始 error（产品的排障落点）：这里统一静音，只有断言日志的用例读它 */
let errorLog: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  installKyclawBridge()
  resetSessionsStore()
  resetPptTemplatesStore()
  resetThreadChats()
  FakeNotification.instances = []
  vi.stubGlobal('Notification', FakeNotification)
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ensureLoaded / refresh', () => {
  it('首屏拉列表：选中最近一条，loaded 置位', async () => {
    installFakeServer(THREADS)

    await useSessionsStore.getState().ensureLoaded()

    const state = useSessionsStore.getState()
    expect(state.loaded).toBe(true)
    expect(state.threads.map((thread) => thread.id)).toEqual(['t-new', 't-old'])
    expect(state.activeId).toBe('t-new')
    expect(state.error).toBeNull()
  })

  it('重复调用只打一次 HTTP（对话页和侧栏会同时来要）', async () => {
    const server = installFakeServer(THREADS)

    await Promise.all([
      useSessionsStore.getState().ensureLoaded(),
      useSessionsStore.getState().ensureLoaded()
    ])
    await useSessionsStore.getState().ensureLoaded()

    expect(server.calls.filter((call) => call.path === '/api/threads')).toHaveLength(1)
  })

  it('列表为空：开一个草稿（activeId 有值但不是服务端线程）', async () => {
    installFakeServer([])

    await useSessionsStore.getState().ensureLoaded()

    const state = useSessionsStore.getState()
    expect(state.threads).toEqual([])
    expect(state.activeId).not.toBeNull()
  })

  it('加载失败：落 error、开草稿顶着（对话还能继续），loaded 也置位', async () => {
    const server = installFakeServer(THREADS)
    server.failNext(new Error('连接被拒绝'))

    await useSessionsStore.getState().ensureLoaded()

    const state = useSessionsStore.getState()
    expect(state.loaded).toBe(true)
    expect(state.error).toContain('连接被拒绝')
    expect(state.activeId).not.toBeNull()
  })

  it('失败时原始 error 落 console.error（界面文案产品化，排障有落点）', async () => {
    const server = installFakeServer(THREADS)
    const failure = new Error('connect ECONNREFUSED 127.0.0.1:60239')
    server.failNext(failure)

    await useSessionsStore.getState().ensureLoaded()
    server.failNext(new Error('500 内部错误'))
    await useSessionsStore.getState().refresh()

    // 落的是原始 Error 对象本身（不是只剩 message 的字符串）
    expect(errorLog).toHaveBeenCalledWith('[kyclaw] 会话列表加载失败', failure)
    expect(errorLog).toHaveBeenCalledWith('[kyclaw] 刷新会话列表失败', expect.any(Error))
  })

  it('refresh 成功后清掉错误（重试路径）', async () => {
    const server = installFakeServer(THREADS)
    server.failNext(new Error('boom'))
    await useSessionsStore.getState().ensureLoaded()
    expect(useSessionsStore.getState().error).toContain('boom')

    await useSessionsStore.getState().refresh()

    expect(useSessionsStore.getState().error).toBeNull()
    expect(useSessionsStore.getState().threads).toHaveLength(2)
  })
})

describe('新建 / 切换 / 删除 / 重命名', () => {
  it('新建：换一个全新的草稿 id', async () => {
    installFakeServer(THREADS)
    await useSessionsStore.getState().ensureLoaded()
    const before = useSessionsStore.getState().activeId

    useSessionsStore.getState().startNew()

    const after = useSessionsStore.getState().activeId
    expect(after).not.toBeNull()
    expect(after).not.toBe(before)
    expect(useSessionsStore.getState().threads.some((thread) => thread.id === after)).toBe(false)
  })

  it('切换：activeId 跟着走，并把该会话的完成点清掉', async () => {
    installFakeServer(THREADS)
    await useSessionsStore.getState().ensureLoaded()
    useSessionsStore.setState({ notices: { 't-old': true } })

    useSessionsStore.getState().select('t-old')

    expect(useSessionsStore.getState().activeId).toBe('t-old')
    expect(useSessionsStore.getState().notices['t-old']).toBeUndefined()
  })

  it('重命名：PATCH 到服务端并更新镜像', async () => {
    const server = installFakeServer(THREADS)
    await useSessionsStore.getState().ensureLoaded()

    await useSessionsStore.getState().rename('t-new', '改过的名字')

    expect(server.calls).toContainEqual({
      method: 'PATCH',
      path: '/api/threads/t-new',
      body: { title: '改过的名字' }
    })
    expect(useSessionsStore.getState().threads[0].title).toBe('改过的名字')
  })

  it('重命名失败：error 置位（不抛给调用方），原始 error 落控制台', async () => {
    const server = installFakeServer(THREADS)
    await useSessionsStore.getState().ensureLoaded()
    const failure = new Error('500')
    server.failNext(failure)

    await useSessionsStore.getState().rename('t-new', 'x')

    expect(useSessionsStore.getState().error).toContain('500')
    expect(useSessionsStore.getState().threads[0].title).toBe('最近的会话')
    expect(errorLog).toHaveBeenCalledWith('[kyclaw] 重命名会话失败', failure)
  })

  it('删除活跃会话：删掉后选中剩下的第一条', async () => {
    const server = installFakeServer(THREADS)
    await useSessionsStore.getState().ensureLoaded()

    await useSessionsStore.getState().remove('t-new')

    expect(server.calls.some((call) => call.method === 'DELETE')).toBe(true)
    const state = useSessionsStore.getState()
    expect(state.threads.map((thread) => thread.id)).toEqual(['t-old'])
    expect(state.activeId).toBe('t-old')
  })

  it('删除非活跃会话：activeId 不动', async () => {
    installFakeServer(THREADS)
    await useSessionsStore.getState().ensureLoaded()
    useSessionsStore.getState().select('t-new')

    await useSessionsStore.getState().remove('t-old')

    expect(useSessionsStore.getState().activeId).toBe('t-new')
    expect(useSessionsStore.getState().threads.map((thread) => thread.id)).toEqual(['t-new'])
  })

  it('删除失败：error 置位、列表不动', async () => {
    const server = installFakeServer(THREADS)
    await useSessionsStore.getState().ensureLoaded()
    server.failNext(new Error('db 锁了'))

    await useSessionsStore.getState().remove('t-new')

    expect(useSessionsStore.getState().error).toContain('db 锁了')
    expect(useSessionsStore.getState().threads).toHaveLength(2)
  })
})

describe('handleTurnEnd：标题 + 完成通知', () => {
  it('人不在这个会话：置完成点 + 发系统通知（带标题）', async () => {
    const server = installFakeServer(THREADS)
    await useSessionsStore.getState().ensureLoaded()
    useSessionsStore.getState().select('t-new') // 人在 t-new，完成的是 t-old

    await useSessionsStore.getState().handleTurnEnd('t-old')

    expect(useSessionsStore.getState().notices['t-old']).toBe(true)
    expect(FakeNotification.instances).toHaveLength(1)
    expect(FakeNotification.instances[0].options?.body).toContain('更早的会话')
    // 标题照常生成（有标题就跳过；t-old 已有标题）
    expect(server.calls.some((call) => call.path === '/api/threads/t-old/title')).toBe(true)
  })

  it('人在这个会话：不发通知（回复就在眼前）', async () => {
    installFakeServer(THREADS)
    await useSessionsStore.getState().ensureLoaded()
    useSessionsStore.getState().select('t-old')

    await useSessionsStore.getState().handleTurnEnd('t-old')

    expect(useSessionsStore.getState().notices['t-old']).toBeUndefined()
    expect(FakeNotification.instances).toHaveLength(0)
  })

  it('草稿首轮结束：会话进列表（先乐观占位），标题生成后替换', async () => {
    const server = installFakeServer([])
    await useSessionsStore.getState().ensureLoaded()
    const draftId = useSessionsStore.getState().activeId!

    // 服务端在对话过程中建了线程（这里模拟刷新能看到的形态：无标题）
    server.threads = [{ id: draftId, title: null, updatedAt: new Date().toISOString() }]

    await useSessionsStore.getState().handleTurnEnd(draftId)

    const state = useSessionsStore.getState()
    expect(state.threads.map((thread) => thread.id)).toEqual([draftId])
    expect(state.threads[0].title).toBe('生成的标题')
    // 标题从"没有"变成真标题：generated=true 的那次 POST 真的发过
    expect(server.calls).toContainEqual({
      method: 'POST',
      path: `/api/threads/${draftId}/title`,
      body: undefined
    })
  })

  it('标题生成失败不翻车：列表保留乐观条目，error 不动（提示留给对话页）', async () => {
    const server = installFakeServer([])
    await useSessionsStore.getState().ensureLoaded()
    const draftId = useSessionsStore.getState().activeId!
    server.failNext(new Error('标题服务 500'))

    await useSessionsStore.getState().handleTurnEnd(draftId)

    const state = useSessionsStore.getState()
    expect(state.threads.map((thread) => thread.id)).toEqual([draftId])
    expect(state.threads[0].title).toBeNull()
  })
})

describe('round 26：草稿物化（materialize）与就地编辑', () => {
  it('materialize：创建线程（POST）并并进镜像；本地草稿标题带过去、随后交棒', async () => {
    const server = installFakeServer([])
    await useSessionsStore.getState().ensureLoaded()
    const draftId = useSessionsStore.getState().activeId!
    useSessionsStore.getState().setDraftTitle(draftId, '草稿名')

    await useSessionsStore.getState().materialize(draftId)

    expect(server.calls).toContainEqual({
      method: 'POST',
      path: '/api/threads',
      body: { threadId: draftId, title: '草稿名' }
    })
    const state = useSessionsStore.getState()
    expect(state.threads.map((thread) => thread.id)).toEqual([draftId])
    expect(state.threads[0]?.title).toBe('草稿名')
    // 本地草稿标题到此交棒（物化后由服务端标题接管）
    expect(state.draftTitles[draftId]).toBeUndefined()
  })

  it('materialize：没有本地标题时不带 title 字段（服务端建"无标题"线程）', async () => {
    const server = installFakeServer([])
    await useSessionsStore.getState().ensureLoaded()
    const draftId = useSessionsStore.getState().activeId!

    await useSessionsStore.getState().materialize(draftId)

    expect(server.calls).toContainEqual({
      method: 'POST',
      path: '/api/threads',
      body: { threadId: draftId }
    })
    expect(useSessionsStore.getState().threads[0]?.title).toBeNull()
  })

  // round 66：会话级的 PPT 模板选择在**草稿**阶段只记本地（服务端还不认识这个会话 id），
  // 物化完成这一刻补写那一笔 —— 发出去的第一轮 create_ppt 因此读得到它。
  it('materialize：把草稿挑的 PPT 模板补写一条（草稿期间一个字节都不写）', async () => {
    const server = installFakeServer([])
    await useSessionsStore.getState().ensureLoaded()
    const draftId = useSessionsStore.getState().activeId!
    usePptTemplatesStore.getState().rememberDraft(draftId, '酒红')
    expect(server.calls.some((call) => call.path === '/api/ppt/templates')).toBe(false)

    await useSessionsStore.getState().materialize(draftId)

    expect(server.calls).toContainEqual({
      method: 'PUT',
      path: '/api/ppt/templates',
      body: { threadId: draftId, template: '酒红' }
    })
  })

  it('materialize：草稿期间没挑过模板 → 不做任何模板写入（不凭空记账）', async () => {
    const server = installFakeServer([])
    await useSessionsStore.getState().ensureLoaded()
    const draftId = useSessionsStore.getState().activeId!

    await useSessionsStore.getState().materialize(draftId)

    expect(server.calls.some((call) => call.path === '/api/ppt/templates')).toBe(false)
  })

  it('materialize：已在镜像里的会话是空操作（不发请求）；重复物化幂等', async () => {
    const server = installFakeServer(THREADS)
    await useSessionsStore.getState().ensureLoaded()
    server.calls.length = 0

    await useSessionsStore.getState().materialize('t-new')

    expect(server.calls).toEqual([])
    expect(useSessionsStore.getState().threads).toHaveLength(2)
  })

  it('materialize 失败：抛给调用方（不吞），镜像与草稿标题都不动', async () => {
    const server = installFakeServer([])
    await useSessionsStore.getState().ensureLoaded()
    const draftId = useSessionsStore.getState().activeId!
    useSessionsStore.getState().setDraftTitle(draftId, '草稿名')
    server.failNext(new Error('线程服务返回 500'))

    await expect(useSessionsStore.getState().materialize(draftId)).rejects.toThrow(
      '线程服务返回 500'
    )

    const state = useSessionsStore.getState()
    expect(state.threads).toEqual([])
    expect(state.draftTitles[draftId]).toBe('草稿名')
  })

  it('materialize 之后轮末：镜像里不重复插（物化已并入），标题生成与刷新照常', async () => {
    const server = installFakeServer([])
    await useSessionsStore.getState().ensureLoaded()
    const draftId = useSessionsStore.getState().activeId!

    // round 49：发送路径先物化 —— 轮末 handleTurnEnd 走的正是这条状态（草稿已经在镜像里）
    await useSessionsStore.getState().materialize(draftId)
    await useSessionsStore.getState().handleTurnEnd(draftId)

    const threads = useSessionsStore.getState().threads
    expect(threads.map((thread) => thread.id)).toEqual([draftId])
    expect(threads[0]?.title).toBe('生成的标题')
    // 刷新仍以服务端为准
    expect(
      server.calls.filter((call) => call.method === 'GET' && call.path === '/api/threads').length
    ).toBeGreaterThan(1)
  })

  it('草稿重命名：就地改本地标题（不发 PATCH）', async () => {
    const server = installFakeServer([])
    await useSessionsStore.getState().ensureLoaded()
    const draftId = useSessionsStore.getState().activeId!
    server.calls.length = 0

    await useSessionsStore.getState().rename(draftId, '草稿名')

    expect(server.calls).toEqual([])
    expect(useSessionsStore.getState().draftTitles[draftId]).toBe('草稿名')
  })

  it('草稿删除：就地丢弃（不发 DELETE），选中接力到新草稿', async () => {
    const server = installFakeServer([])
    await useSessionsStore.getState().ensureLoaded()
    const draftId = useSessionsStore.getState().activeId!
    server.calls.length = 0

    await useSessionsStore.getState().remove(draftId)

    expect(server.calls).toEqual([])
    const state = useSessionsStore.getState()
    expect(state.activeId).not.toBe(draftId)
    expect(state.threads).toEqual([])
  })
})

/**
 * round 62（P0）：排队队列按会话存在 store 上（原来是对话页组件内的 ref，切会话就随卸载蒸发）。
 * 这里钉住 store 这一层的基本语义：先进先出、取走即出队、跨会话各存各的、删会话连队列一起丢。
 */
describe('round 62：发送队列（按会话存，切会话不丢）', () => {
  const message = (text: string): OutgoingMessage => ({ text, files: [] })

  it('入队 / 出队：先进先出；取空后这一格也收掉（不攒空数组）', () => {
    useSessionsStore.getState().enqueueMessage('t1', message('一'))
    useSessionsStore.getState().enqueueMessage('t1', message('二'))
    useSessionsStore.getState().enqueueMessage('t2', message('别的会话'))

    expect(useSessionsStore.getState().queues.t1?.map((item) => item.text)).toEqual(['一', '二'])
    expect(useSessionsStore.getState().takeQueuedMessage('t1')?.text).toBe('一')
    expect(useSessionsStore.getState().takeQueuedMessage('t1')?.text).toBe('二')
    expect(useSessionsStore.getState().takeQueuedMessage('t1')).toBeNull()
    expect('t1' in useSessionsStore.getState().queues).toBe(false)
    // 别的会话那一格不受影响
    expect(useSessionsStore.getState().queues.t2?.map((item) => item.text)).toEqual(['别的会话'])
  })

  it('删除会话：它的排队内容一起丢掉（不会再有人去补发）', async () => {
    installFakeServer(THREADS)
    await useSessionsStore.getState().ensureLoaded()
    useSessionsStore.getState().enqueueMessage('t-new', message('排队中'))
    useSessionsStore.getState().enqueueMessage('t-old', message('别的会话的排队'))

    await useSessionsStore.getState().remove('t-new')

    const queues = useSessionsStore.getState().queues
    expect('t-new' in queues).toBe(false)
    expect(queues['t-old']?.map((item) => item.text)).toEqual(['别的会话的排队'])
  })
})
