import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { resetSessionsStore, useSessionsStore } from '@renderer/features/sessions/sessions-store'
import { MemoryPage } from '../MemoryPage'

/**
 * 记忆页（T14；round 58 起按会话隔离）：查看 / 编辑 / 清空三态，全部打在假服务上
 * （HTTP 层断言方法 + 查询串里的 threadId + body）。
 * 页面在四页壳里由路由挂载，这里只渲它自己（routes.spec 管壳）。
 *
 * 记忆跟着**当前活动会话**走（round 58）：所以每个用例先把会话 store 摆好——
 * 有活动会话 = 列表里有它；草稿 / 没有会话 = 不发请求、给空态（`memory-no-session`，
 * 与"有会话但还没记东西"的 `memory-empty` 分开说）。
 *
 * 本轮（设置页重组）：独立页的标题从「记忆」改成「记忆空间」；设置页「记忆」栏里另有一个
 * 「记忆空间」入口弹窗（复用同一个 MemoryPanel）——那一段在 settings-page.spec 里钉。
 */
function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

interface FakeMemoryServer {
  /** 按会话存的内容（key = threadId） */
  contents: Record<string, string | null>
  calls: { method: string; path: string; threadId: string | null; body: unknown }[]
  /** 让下一次请求失败（按顺序消耗） */
  failNext(error: Error): void
}

function installFakeMemory(initial: Record<string, string> = {}): FakeMemoryServer {
  const failures: Error[] = []
  const server: FakeMemoryServer = {
    contents: { ...initial },
    calls: [],
    failNext(error) {
      failures.push(error)
    }
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input))
      const method = init.method ?? 'GET'
      // round 28：记忆页还会读一次语义召回状态（状态行）。它不进 calls（下面的断言按"记忆接口"
      // 的最后一次调用看方法/入参），也不参与 failNext 的排队——那是给记忆接口准备的一次性失败。
      if (url.pathname === '/api/memory/recall') {
        return json({
          // 形状照 shared/memory 的 recallStatusSchema（source 只有 remote / localEngine 两档）
          recall: {
            state: 'off',
            active: false,
            enabled: false,
            source: 'remote',
            detail: '未开启'
          }
        })
      }
      const threadId = url.searchParams.get('threadId')
      server.calls.push({
        method,
        path: url.pathname,
        threadId,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      })
      const failure = failures.shift()
      if (failure !== undefined) throw failure

      if (url.pathname !== '/api/memory') throw new Error(`假服务没实现：${method} ${url.pathname}`)
      const key = threadId ?? ''
      if (method === 'GET') return json({ content: server.contents[key] ?? null })
      if (method === 'PUT') {
        const body =
          init.body === undefined ? {} : (JSON.parse(String(init.body)) as { content?: unknown })
        const trimmed = String(body.content ?? '').trim()
        server.contents[key] = trimmed === '' ? null : trimmed
        return json({ content: server.contents[key] })
      }
      if (method === 'DELETE') {
        server.contents[key] = null
        return json({ ok: true })
      }
      throw new Error(`假服务没实现：${method} ${url.pathname}`)
    })
  )
  return server
}

/** 把会话 store 摆成"当前会话 = threadId"（草稿 / 没有会话用下面那个） */
function setActiveSession(threadId: string): void {
  useSessionsStore.setState({
    threads: [{ id: threadId, title: null, updatedAt: new Date().toISOString() }],
    activeId: threadId,
    loaded: true,
    error: null
  })
}

/** 草稿会话（还没落库、不在列表里）：记忆页按"没有会话"处理 */
function setDraftSession(threadId: string): void {
  useSessionsStore.setState({ threads: [], activeId: threadId, loaded: true, error: null })
}

beforeEach(() => {
  installKyclawBridge()
  setActiveSession('thread-1')
})

afterEach(() => {
  clearKyclawBridge()
  resetSessionsStore()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('记忆页：查看', () => {
  it('标题是「记忆空间」（本轮与设置页那一块统一取名）', () => {
    installFakeMemory()
    render(<MemoryPage />)

    expect(screen.getByRole('heading', { level: 1, name: '记忆空间' })).toBeInTheDocument()
  })

  it('有活动会话：按会话拉取（请求带 threadId），回来后显示内容与两个动作', async () => {
    const server = installFakeMemory({ 'thread-1': '# 用户信息\n- 姓名：张三\n- 城市：杭州' })
    render(<MemoryPage />)

    expect(screen.getByTestId('memory-loading')).toBeInTheDocument()
    expect(await screen.findByTestId('memory-content')).toHaveTextContent('张三')
    expect(screen.getByTestId('memory-content')).toHaveTextContent('杭州')
    expect(screen.getByTestId('memory-edit')).toBeInTheDocument()
    expect(screen.getByTestId('memory-clear')).toBeEnabled()
    expect(server.calls[0]).toMatchObject({
      method: 'GET',
      path: '/api/memory',
      threadId: 'thread-1'
    })
  })

  it('没有记忆时给空态；清空按钮此时不可点', async () => {
    installFakeMemory()
    render(<MemoryPage />)

    expect(await screen.findByTestId('memory-empty')).toHaveTextContent('还没有记忆')
    expect(screen.getByTestId('memory-empty')).toHaveClass('font-serif')
    expect(screen.queryByTestId('memory-content')).not.toBeNull()
    expect(screen.getByTestId('memory-clear')).toBeDisabled()
  })

  it('没有活动会话 / 草稿：给"没有会话"空态（不是"还没有记忆"）且一次请求都不发', async () => {
    const server = installFakeMemory({ 'thread-1': '不该被读到的内容' })
    setDraftSession('draft-1')
    render(<MemoryPage />)

    expect(await screen.findByTestId('memory-no-session')).toHaveTextContent('当前没有会话')
    expect(screen.queryByTestId('memory-empty')).not.toBeInTheDocument()
    expect(screen.queryByTestId('memory-edit')).not.toBeInTheDocument()
    expect(server.calls).toHaveLength(0)
  })

  it('载入失败：错误行 + 重试后成功', async () => {
    const server = installFakeMemory({ 'thread-1': '你好' })
    server.failNext(new Error('连接被拒绝'))
    render(<MemoryPage />)

    expect(await screen.findByTestId('memory-error')).toHaveTextContent('连接被拒绝')

    fireEvent.click(screen.getByTestId('memory-retry'))

    expect(await screen.findByTestId('memory-content')).toHaveTextContent('你好')
    expect(screen.queryByTestId('memory-error')).not.toBeInTheDocument()
  })

  it('切换会话：重拉并换成那个会话的记忆（编辑中的草稿作废）', async () => {
    installFakeMemory({ 'thread-1': 'A 会话的记忆', 'thread-2': 'B 会话的记忆' })
    render(<MemoryPage />)
    expect(await screen.findByTestId('memory-content')).toHaveTextContent('A 会话的记忆')

    // 编辑到一半切走：草稿属于上一个会话，不该带过去
    fireEvent.click(screen.getByTestId('memory-edit'))
    fireEvent.change(screen.getByTestId('memory-input'), { target: { value: '改到一半' } })

    act(() => setActiveSession('thread-2'))

    expect(await screen.findByTestId('memory-content')).toHaveTextContent('B 会话的记忆')
    expect(screen.queryByTestId('memory-input')).not.toBeInTheDocument()
  })
})

describe('记忆页：编辑', () => {
  it('点编辑进入编辑态（草稿 = 当前内容），保存打 PUT 并显示服务端回吐的内容', async () => {
    const server = installFakeMemory({ 'thread-1': '# 用户信息\n- 姓名：张三' })
    render(<MemoryPage />)
    await screen.findByTestId('memory-content')

    fireEvent.click(screen.getByTestId('memory-edit'))
    const input = screen.getByTestId('memory-input') as HTMLTextAreaElement
    expect(input.value).toBe('# 用户信息\n- 姓名：张三')

    fireEvent.change(input, { target: { value: '# 用户信息\n- 姓名：李四' } })
    fireEvent.click(screen.getByTestId('memory-save'))

    await screen.findByTestId('memory-content')
    expect(server.calls.at(-1)).toMatchObject({
      method: 'PUT',
      path: '/api/memory',
      threadId: 'thread-1',
      body: { content: '# 用户信息\n- 姓名：李四' }
    })
    expect(screen.getByTestId('memory-content')).toHaveTextContent('李四')
    expect(screen.queryByTestId('memory-input')).not.toBeInTheDocument()
  })

  it('取消：丢弃草稿，内容不变，不发请求', async () => {
    const server = installFakeMemory({ 'thread-1': '# 用户信息\n- 姓名：张三' })
    render(<MemoryPage />)
    await screen.findByTestId('memory-content')
    const callsBefore = server.calls.length

    fireEvent.click(screen.getByTestId('memory-edit'))
    fireEvent.change(screen.getByTestId('memory-input'), { target: { value: '改坏了' } })
    fireEvent.click(screen.getByTestId('memory-cancel'))

    expect(screen.getByTestId('memory-content')).toHaveTextContent('张三')
    expect(server.calls.length).toBe(callsBefore)
  })

  it('保存失败：留在编辑态、草稿不丢、错误行给出原因', async () => {
    const server = installFakeMemory({ 'thread-1': '旧内容' })
    render(<MemoryPage />)
    await screen.findByTestId('memory-content')

    fireEvent.click(screen.getByTestId('memory-edit'))
    fireEvent.change(screen.getByTestId('memory-input'), { target: { value: '新内容' } })
    server.failNext(new Error('记忆服务返回 500'))
    fireEvent.click(screen.getByTestId('memory-save'))

    expect(await screen.findByTestId('memory-action-error')).toHaveTextContent('记忆服务返回 500')
    expect(screen.getByTestId('memory-input')).toHaveValue('新内容')
    expect(screen.queryByTestId('memory-save')).toBeInTheDocument()
  })
})

describe('记忆页：清空', () => {
  it('清空要先确认：取消不发请求；确认打 DELETE 并回到空态', async () => {
    const server = installFakeMemory({ 'thread-1': '# 用户信息\n- 姓名：张三' })
    render(<MemoryPage />)
    await screen.findByTestId('memory-content')
    const callsBefore = server.calls.length

    fireEvent.click(screen.getByTestId('memory-clear'))
    fireEvent.click(screen.getByTestId('memory-clear-cancel'))
    expect(server.calls.length).toBe(callsBefore)

    fireEvent.click(screen.getByTestId('memory-clear'))
    fireEvent.click(screen.getByTestId('memory-clear-confirm'))

    expect(await screen.findByTestId('memory-empty')).toHaveTextContent('还没有记忆')
    expect(screen.getByTestId('memory-empty')).toHaveClass('font-serif')
    expect(server.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/api/memory',
      threadId: 'thread-1'
    })
  })

  it('清空失败：错误行给出原因，内容不动', async () => {
    const server = installFakeMemory({ 'thread-1': '还要留着' })
    render(<MemoryPage />)
    await screen.findByTestId('memory-content')

    fireEvent.click(screen.getByTestId('memory-clear'))
    server.failNext(new Error('记忆服务返回 500'))
    fireEvent.click(screen.getByTestId('memory-clear-confirm'))

    expect(await screen.findByTestId('memory-action-error')).toHaveTextContent('记忆服务返回 500')
    await waitFor(() => expect(screen.getByTestId('memory-content')).toHaveTextContent('还要留着'))
  })
})
