import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { MemoryPage } from '../MemoryPage'

/**
 * 记忆页（T14）：查看 / 编辑 / 清空三态，全部打在假服务上（HTTP 层断言方法+body）。
 * 页面在四页壳里由路由挂载，这里只渲它自己（routes.spec 管壳）。
 */
function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

interface FakeMemoryServer {
  content: string | null
  calls: { method: string; path: string; body: unknown }[]
  /** 让下一次请求失败（按顺序消耗） */
  failNext(error: Error): void
}

function installFakeMemory(initial: string | null = null): FakeMemoryServer {
  const failures: Error[] = []
  const server: FakeMemoryServer = {
    content: initial,
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
          recall: { state: 'off', active: false, enabled: false, source: 'local', detail: '未开启' }
        })
      }
      server.calls.push({
        method,
        path: url.pathname,
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
      })
      const failure = failures.shift()
      if (failure !== undefined) throw failure

      if (url.pathname !== '/api/memory') throw new Error(`假服务没实现：${method} ${url.pathname}`)
      if (method === 'GET') return json({ content: server.content })
      if (method === 'PUT') {
        const body =
          init.body === undefined ? {} : (JSON.parse(String(init.body)) as { content?: unknown })
        const trimmed = String(body.content ?? '').trim()
        server.content = trimmed === '' ? null : trimmed
        return json({ content: server.content })
      }
      if (method === 'DELETE') {
        server.content = null
        return json({ ok: true })
      }
      throw new Error(`假服务没实现：${method} ${url.pathname}`)
    })
  )
  return server
}

beforeEach(() => {
  installKyclawBridge()
})

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('记忆页：查看', () => {
  it('载入中先给骨架，回来后显示记忆内容与两个动作', async () => {
    installFakeMemory('# 用户信息\n- 姓名：张三\n- 城市：杭州')
    render(<MemoryPage />)

    expect(screen.getByTestId('memory-loading')).toBeInTheDocument()
    expect(await screen.findByTestId('memory-content')).toHaveTextContent('张三')
    expect(screen.getByTestId('memory-content')).toHaveTextContent('杭州')
    expect(screen.getByTestId('memory-edit')).toBeInTheDocument()
    expect(screen.getByTestId('memory-clear')).toBeEnabled()
  })

  it('没有记忆时给空态；清空按钮此时不可点', async () => {
    installFakeMemory(null)
    render(<MemoryPage />)

    expect(await screen.findByTestId('memory-empty')).toHaveTextContent('还没有记忆')
    expect(screen.queryByTestId('memory-content')).not.toBeNull()
    expect(screen.getByTestId('memory-clear')).toBeDisabled()
  })

  it('载入失败：错误行 + 重试后成功', async () => {
    const server = installFakeMemory('你好')
    server.failNext(new Error('连接被拒绝'))
    render(<MemoryPage />)

    expect(await screen.findByTestId('memory-error')).toHaveTextContent('连接被拒绝')

    fireEvent.click(screen.getByTestId('memory-retry'))

    expect(await screen.findByTestId('memory-content')).toHaveTextContent('你好')
    expect(screen.queryByTestId('memory-error')).not.toBeInTheDocument()
  })
})

describe('记忆页：编辑', () => {
  it('点编辑进入编辑态（草稿 = 当前内容），保存打 PUT 并显示服务端回吐的内容', async () => {
    const server = installFakeMemory('# 用户信息\n- 姓名：张三')
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
      body: { content: '# 用户信息\n- 姓名：李四' }
    })
    expect(screen.getByTestId('memory-content')).toHaveTextContent('李四')
    expect(screen.queryByTestId('memory-input')).not.toBeInTheDocument()
  })

  it('取消：丢弃草稿，内容不变，不发请求', async () => {
    const server = installFakeMemory('# 用户信息\n- 姓名：张三')
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
    const server = installFakeMemory('旧内容')
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
    const server = installFakeMemory('# 用户信息\n- 姓名：张三')
    render(<MemoryPage />)
    await screen.findByTestId('memory-content')
    const callsBefore = server.calls.length

    fireEvent.click(screen.getByTestId('memory-clear'))
    fireEvent.click(screen.getByTestId('memory-clear-cancel'))
    expect(server.calls.length).toBe(callsBefore)

    fireEvent.click(screen.getByTestId('memory-clear'))
    fireEvent.click(screen.getByTestId('memory-clear-confirm'))

    expect(await screen.findByTestId('memory-empty')).toHaveTextContent('还没有记忆')
    expect(server.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/api/memory' })
  })

  it('清空失败：错误行给出原因，内容不动', async () => {
    const server = installFakeMemory('还要留着')
    render(<MemoryPage />)
    await screen.findByTestId('memory-content')

    fireEvent.click(screen.getByTestId('memory-clear'))
    server.failNext(new Error('记忆服务返回 500'))
    fireEvent.click(screen.getByTestId('memory-clear-confirm'))

    expect(await screen.findByTestId('memory-action-error')).toHaveTextContent('记忆服务返回 500')
    await waitFor(() => expect(screen.getByTestId('memory-content')).toHaveTextContent('还要留着'))
  })
})
