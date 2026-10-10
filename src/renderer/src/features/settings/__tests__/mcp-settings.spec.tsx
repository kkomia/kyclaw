import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { mcpServersProblems, type McpTestResult } from '@shared/mcp'
import type { McpServerConfig } from '@shared/settings'
import { McpSettings } from '../McpSettings'

/**
 * 设置页「工具与 MCP」组（T12，RTL）：server 列表 / 新增（stdio、HTTP）/ 编辑保存 / 启停 / 删除 /
 * 测试连接（工具清单 + 单工具"只读"开关）。
 *
 * 服务端（PUT /api/mcp/servers）的校验用 shared/mcp 的同一份实现模拟：启用的 server 配置不完整
 * 就回 400——界面必须把原因行内说出来，不假装成功。
 */
function serverConfig(patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'echo',
    name: '回显服务',
    transport: 'stdio',
    command: 'node',
    args: ['echo.mjs'],
    enabled: true,
    readOnlyTools: [],
    ...patch
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response
}

interface MockApi {
  state: { servers: McpServerConfig[] }
  testResults: Map<string, McpTestResult>
  puts: Array<McpServerConfig[]>
}

function installMockApi(initial: McpServerConfig[]): MockApi {
  const api: MockApi = { state: { servers: [...initial] }, testResults: new Map(), puts: [] }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname
      const method = init?.method ?? 'GET'

      if (path === '/api/mcp/servers' && method === 'GET') {
        return jsonResponse({ servers: api.state.servers })
      }
      if (path === '/api/mcp/servers' && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { servers: McpServerConfig[] }
        const problems = mcpServersProblems(body.servers)
        if (problems.length > 0) {
          return jsonResponse({ error: `invalid-input: ${problems.join('；')}` }, 400)
        }
        api.state.servers = body.servers
        api.puts.push(body.servers)
        return jsonResponse({ servers: api.state.servers })
      }
      const test = /^\/api\/mcp\/servers\/(.+)\/test$/.exec(path)
      if (test && method === 'POST') {
        const id = decodeURIComponent(test[1])
        const result =
          api.testResults.get(id) ??
          ({
            ok: true,
            latencyMs: 128,
            tools: [{ name: 'echo', description: '原样回显' }]
          } satisfies McpTestResult)
        return jsonResponse(result)
      }
      return jsonResponse({ error: 'not-found' }, 404)
    })
  )

  return api
}

beforeEach(() => {
  installKyclawBridge()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  clearKyclawBridge()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('MCP 组 · 列表与新增', () => {
  it('空列表：一句空态 + 两个添加入口', async () => {
    installMockApi([])
    render(<McpSettings />)

    expect(await screen.findByTestId('mcp-empty')).toHaveTextContent('还没有 MCP 服务')
    expect(screen.getByTestId('mcp-add-stdio')).toHaveTextContent('本地命令（stdio）')
    expect(screen.getByTestId('mcp-add-http')).toHaveTextContent('远程地址（HTTP）')
  })

  it('列出 server：名称、传输、启停状态；停用的不显示为启用', async () => {
    installMockApi([
      serverConfig(),
      serverConfig({
        id: 'remote',
        name: '远程',
        transport: 'http',
        url: 'http://127.0.0.1:9/mcp',
        command: undefined,
        args: undefined,
        enabled: false
      })
    ])
    render(<McpSettings />)

    expect(await screen.findByTestId('mcp-server-0')).toHaveTextContent('回显服务')
    expect(screen.getByTestId('mcp-server-0')).toHaveTextContent('stdio')
    expect(screen.getByTestId('mcp-server-0-enable')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('mcp-server-1')).toHaveTextContent('远程')
    expect(screen.getByTestId('mcp-server-1')).toHaveTextContent('HTTP')
    expect(screen.getByTestId('mcp-server-1-disable')).toHaveAttribute('aria-pressed', 'true')
  })

  it('新增 stdio：以停用落盘（半截配置不进运行期），列表里出现编辑字段', async () => {
    const api = installMockApi([])
    render(<McpSettings />)
    await screen.findByTestId('mcp-empty')

    fireEvent.click(screen.getByTestId('mcp-add-stdio'))

    await waitFor(() =>
      expect(api.state.servers).toEqual([
        expect.objectContaining({ transport: 'stdio', enabled: false, command: '' })
      ])
    )
    expect(await screen.findByTestId('mcp-server-0-command')).toBeInTheDocument()
  })
})

describe('MCP 组 · 编辑 / 启停 / 删除', () => {
  it('保存草稿：改名称与命令 → PUT 收到新值；草稿回到落盘后的真相', async () => {
    const api = installMockApi([serverConfig({ enabled: false })])
    render(<McpSettings />)
    await screen.findByTestId('mcp-server-0')

    fireEvent.change(screen.getByTestId('mcp-server-0-name'), { target: { value: '我的回显' } })
    fireEvent.change(screen.getByTestId('mcp-server-0-command'), { target: { value: 'node' } })
    fireEvent.click(screen.getByTestId('mcp-server-0-save'))

    await waitFor(() => expect(api.state.servers[0].name).toBe('我的回显'))
    expect(api.state.servers[0].command).toBe('node')
  })

  it('启用缺命令的 server：服务端拒绝 → 行内报原因，状态不变', async () => {
    installMockApi([serverConfig({ enabled: false, command: '' })])
    render(<McpSettings />)
    await screen.findByTestId('mcp-server-0')

    fireEvent.click(screen.getByTestId('mcp-server-0-enable'))

    expect(await screen.findByTestId('mcp-server-0-error')).toHaveTextContent('启动命令')
    expect(screen.getByTestId('mcp-server-0-enable')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('mcp-server-0-disable')).toHaveAttribute('aria-pressed', 'true')
  })

  it('启停切换：点「停用」→ 落盘 enabled=false；切回来 → true', async () => {
    const api = installMockApi([serverConfig()])
    render(<McpSettings />)
    await screen.findByTestId('mcp-server-0')

    fireEvent.click(screen.getByTestId('mcp-server-0-disable'))
    await waitFor(() => expect(api.state.servers[0].enabled).toBe(false))

    fireEvent.click(screen.getByTestId('mcp-server-0-enable'))
    await waitFor(() => expect(api.state.servers[0].enabled).toBe(true))
  })

  it('删除：那一行消失，其余不动', async () => {
    const api = installMockApi([
      serverConfig(),
      serverConfig({
        id: 'remote',
        name: '远程',
        transport: 'http',
        url: 'http://x/mcp',
        command: undefined,
        args: undefined,
        enabled: false
      })
    ])
    render(<McpSettings />)
    await screen.findByTestId('mcp-server-0')

    fireEvent.click(screen.getByTestId('mcp-server-0-remove'))

    await waitFor(() => expect(api.state.servers.map((server) => server.id)).toEqual(['remote']))
    expect(await screen.findByTestId('mcp-server-0')).toHaveTextContent('远程')
  })
})

describe('MCP 组 · 测试连接与只读标记', () => {
  it('测试连接成功：工具清单出现；点「只读」标记那个工具', async () => {
    const api = installMockApi([serverConfig({ enabled: false })])
    render(<McpSettings />)
    await screen.findByTestId('mcp-server-0')

    fireEvent.click(screen.getByTestId('mcp-server-0-test'))

    expect(await screen.findByTestId('mcp-server-0-test-result')).toHaveTextContent('连接正常')
    await screen.findByTestId('mcp-server-0-tools')
    expect(screen.getByTestId('mcp-server-0-tool-echo-readonly')).toHaveAttribute(
      'aria-pressed',
      'false'
    )

    fireEvent.click(screen.getByTestId('mcp-server-0-tool-echo-readonly'))

    await waitFor(() => expect(api.state.servers[0].readOnlyTools).toEqual(['echo']))
    await waitFor(() =>
      expect(screen.getByTestId('mcp-server-0-tool-echo-readonly')).toHaveAttribute(
        'aria-pressed',
        'true'
      )
    )

    fireEvent.click(screen.getByTestId('mcp-server-0-tool-echo-readonly'))
    await waitFor(() => expect(api.state.servers[0].readOnlyTools).toEqual([]))
  })

  it('测试连接失败：行内显示分类后的人话，不列工具', async () => {
    const api = installMockApi([serverConfig({ enabled: false })])
    api.testResults.set('echo', {
      ok: false,
      kind: 'spawn',
      message: '服务没能启动或立刻退出：ENOENT'
    })
    render(<McpSettings />)
    await screen.findByTestId('mcp-server-0')

    fireEvent.click(screen.getByTestId('mcp-server-0-test'))

    expect(await screen.findByTestId('mcp-server-0-test-result')).toHaveTextContent(
      '连接失败：服务没能启动或立刻退出'
    )
    expect(screen.queryByTestId('mcp-server-0-tools')).not.toBeInTheDocument()
  })

  it('测试连接前有未保存的改动：先保存再测（服务端测的是落盘那份）', async () => {
    const api = installMockApi([serverConfig({ enabled: false })])
    render(<McpSettings />)
    await screen.findByTestId('mcp-server-0')

    fireEvent.change(screen.getByTestId('mcp-server-0-command'), { target: { value: 'node' } })
    fireEvent.change(screen.getByTestId('mcp-server-0-args'), { target: { value: 'echo2.mjs' } })
    fireEvent.click(screen.getByTestId('mcp-server-0-test'))

    await waitFor(() => expect(api.state.servers[0].args).toEqual(['echo2.mjs']))
    expect(await screen.findByTestId('mcp-server-0-test-result')).toHaveTextContent('连接正常')
  })

  it('读不到列表（服务没起）：页面级错误行内可见，不静默', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401))
    )
    render(<McpSettings />)

    expect(await screen.findByTestId('mcp-page-error')).toHaveTextContent('unauthorized')
  })
})
