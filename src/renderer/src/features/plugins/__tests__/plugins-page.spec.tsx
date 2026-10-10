import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearKyclawBridge, installKyclawBridge } from '@renderer/__tests__/kyclaw-bridge'
import { mcpServersProblems, type McpTestResult } from '@shared/mcp'
import type { McpServerConfig } from '@shared/settings'
import { PluginsPage } from '../PluginsPage'

/**
 * 插件页（R2 round 5，用户实拍 #9）：tab「技能｜MCP」/ 行式 MCP 列表（开关启停 + 齿轮编辑 + 测试连接）/
 * 右上角「＋新增」菜单（stdio、HTTP，照 ChatGPT「Add ∨」）/ 编辑对话框（保存、删除、工具免审批开关）。
 *
 * 服务端（PUT /api/mcp/servers）的校验用 shared/mcp 的同一份实现模拟：启用的 server 配置不完整
 * 就回 400——界面必须把原因行内说出来，不假装成功（行为口径与 T12 一致，换的是布局与控件）。
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
  /** 请求发生顺序（round 7 边界用例：钉"dirty 先存再测"的次序） */
  calls: string[]
}

function installMockApi(initial: McpServerConfig[]): MockApi {
  const api: MockApi = {
    state: { servers: [...initial] },
    testResults: new Map(),
    puts: [],
    calls: []
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname
      const method = init?.method ?? 'GET'

      if (path === '/api/mcp/servers' && method === 'GET') {
        api.calls.push('GET')
        return jsonResponse({ servers: api.state.servers })
      }
      if (path === '/api/mcp/servers' && method === 'PUT') {
        api.calls.push('PUT')
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
        api.calls.push('POST-test')
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

/** 切到 MCP tab（技能是默认 tab） */
function openMcpTab(): void {
  fireEvent.click(screen.getByTestId('plugins-tab-mcp'))
}

/** 打开第 index 行的编辑对话框 */
function openEditor(index = 0): void {
  fireEvent.click(screen.getByTestId(`mcp-server-${index}-edit`))
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

describe('插件页 · 两个 tab', () => {
  it('默认「技能」：内置能力只读清单（克制口吻、没有开关）；「MCP」tab 才有 ＋新增', async () => {
    installMockApi([])
    render(<PluginsPage />)

    expect(screen.getByTestId('plugins-page')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-tab-skills')).toHaveAttribute('aria-selected', 'true')
    const skills = screen.getByTestId('plugins-skills')
    for (const name of ['读取文件', '查找文件', '搜索内容', '写入文件', '修改文件']) {
      expect(skills, name).toHaveTextContent(name)
    }
    // 技能 tab 没有新增按钮（内置技能不由用户增删）
    expect(screen.queryByTestId('mcp-add')).not.toBeInTheDocument()

    openMcpTab()
    expect(screen.getByTestId('plugins-tab-mcp')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('mcp-add')).toHaveTextContent('新增')
    expect(await screen.findByTestId('mcp-empty')).toHaveTextContent('还没有 MCP 服务')
  })

  it('底部常驻添加 chips 已删除（round 5）：页面里没有旧的 mcp-add-stdio 常驻按钮', async () => {
    installMockApi([])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-empty')

    // 新增走右上角菜单：按钮点了才出现两个选项
    expect(screen.queryByTestId('mcp-add-stdio')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('mcp-add'), { key: 'ArrowDown' })
    expect(screen.getByTestId('mcp-add-stdio')).toHaveTextContent('本地命令（stdio）')
    expect(screen.getByTestId('mcp-add-http')).toHaveTextContent('远程地址（HTTP）')
  })

  it('＋新增（stdio）：以停用落盘、自动切到 MCP tab，行列表里出现新条目', async () => {
    const api = installMockApi([])
    render(<PluginsPage />)

    // 技能 tab 上新增入口不出现；切到 MCP 后走菜单新增
    openMcpTab()
    await screen.findByTestId('mcp-empty')
    fireEvent.keyDown(screen.getByTestId('mcp-add'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('mcp-add-stdio'))

    await waitFor(() =>
      expect(api.state.servers).toEqual([
        expect.objectContaining({ transport: 'stdio', enabled: false, command: '' })
      ])
    )
    expect(await screen.findByTestId('mcp-server-0')).toBeInTheDocument()
    expect(screen.getByTestId('mcp-server-0')).toHaveTextContent('stdio')
  })
})

describe('插件页 · 行式列表（开关 / 编辑 / 测试 / 删除）', () => {
  it('列出 server：名称 + 传输标签；开关的可访问名与 aria-checked 跟启用态走', async () => {
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
    render(<PluginsPage />)
    openMcpTab()

    expect(await screen.findByTestId('mcp-server-0')).toHaveTextContent('回显服务')
    expect(screen.getByTestId('mcp-server-0')).toHaveTextContent('stdio')
    expect(screen.getByTestId('mcp-server-0-enable')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('mcp-server-0-enable')).toHaveAccessibleName('启用 回显服务')
    expect(screen.getByTestId('mcp-server-1')).toHaveTextContent('远程')
    expect(screen.getByTestId('mcp-server-1')).toHaveTextContent('HTTP')
    expect(screen.getByTestId('mcp-server-1-enable')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('mcp-server-1-enable')).toHaveAccessibleName('启用 远程')
  })

  it('开关启停：拨一下 → 落盘 enabled=false；再拨回来 → true（单开关，不再是两个按钮）', async () => {
    const api = installMockApi([serverConfig()])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    fireEvent.click(screen.getByTestId('mcp-server-0-enable'))
    await waitFor(() => expect(api.state.servers[0].enabled).toBe(false))
    expect(screen.getByTestId('mcp-server-0-enable')).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(screen.getByTestId('mcp-server-0-enable'))
    await waitFor(() => expect(api.state.servers[0].enabled).toBe(true))
  })

  it('启用缺命令的 server：服务端拒绝 → 行内报原因，开关不变', async () => {
    installMockApi([serverConfig({ enabled: false, command: '' })])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    fireEvent.click(screen.getByTestId('mcp-server-0-enable'))

    expect(await screen.findByTestId('mcp-server-0-error')).toHaveTextContent('启动命令')
    expect(screen.getByTestId('mcp-server-0-enable')).toHaveAttribute('aria-checked', 'false')
  })

  it('齿轮编辑：对话框里改名称/命令 → 保存落盘；取消不写', async () => {
    const api = installMockApi([serverConfig({ enabled: false })])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    openEditor()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('mcp-server-0-name'), { target: { value: '我的回显' } })
    fireEvent.change(screen.getByTestId('mcp-server-0-command'), { target: { value: 'node' } })
    fireEvent.click(screen.getByTestId('mcp-server-0-save'))

    await waitFor(() => expect(api.state.servers[0].name).toBe('我的回显'))
    expect(api.state.servers[0].command).toBe('node')

    // 取消：改了字段但点取消，不落盘
    fireEvent.change(screen.getByTestId('mcp-server-0-name'), { target: { value: '不保存' } })
    fireEvent.click(screen.getByTestId('mcp-edit-cancel'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.state.servers[0].name).toBe('我的回显')
  })

  it('测试连接：行内出结果；打开对话框能看到工具清单 + 免审批开关', async () => {
    const api = installMockApi([serverConfig({ enabled: false })])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    fireEvent.click(screen.getByTestId('mcp-server-0-test'))
    expect(await screen.findByTestId('mcp-server-0-test-result')).toHaveTextContent('连接正常')

    openEditor()
    const readonly = await screen.findByTestId('mcp-server-0-tool-echo-readonly')
    expect(readonly).toHaveAttribute('aria-checked', 'false')

    fireEvent.click(readonly)
    await waitFor(() => expect(api.state.servers[0].readOnlyTools).toEqual(['echo']))
    await waitFor(() =>
      expect(screen.getByTestId('mcp-server-0-tool-echo-readonly')).toHaveAttribute(
        'aria-checked',
        'true'
      )
    )
  })

  it('删除：对话框底部按钮把那一行删掉，其余不动', async () => {
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
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    openEditor(0)
    fireEvent.click(screen.getByTestId('mcp-server-0-remove'))

    await waitFor(() => expect(api.state.servers.map((server) => server.id)).toEqual(['remote']))
    expect(await screen.findByTestId('mcp-server-0')).toHaveTextContent('远程')
  })
})

describe('插件页 · 边界（round 7 台账 minors①：补覆盖，不改行为）', () => {
  it('读不到列表：页面把原因说出来（mcp-page-error），不假装空列表', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('连不上本地服务')
      })
    )
    render(<PluginsPage />)
    openMcpTab()

    expect(await screen.findByTestId('mcp-page-error')).toHaveTextContent('连不上本地服务')
    // 不假装成功：没有渲染任何 server 行
    expect(screen.queryByTestId('mcp-server-0')).not.toBeInTheDocument()
  })

  it('dirty 先存再测：对话框里改了没保存的字段，点「测试连接」先落盘再真连（顺序 PUT → 测试）', async () => {
    const api = installMockApi([serverConfig({ enabled: false })])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    openEditor()
    fireEvent.change(screen.getByTestId('mcp-server-0-name'), { target: { value: '改过的名字' } })
    fireEvent.click(screen.getByTestId('mcp-edit-cancel'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    api.calls.length = 0
    fireEvent.click(screen.getByTestId('mcp-server-0-test'))
    expect(await screen.findByTestId('mcp-server-0-test-result')).toHaveTextContent('连接正常')

    expect(api.calls).toEqual(['PUT', 'POST-test'])
    expect(api.state.servers[0].name).toBe('改过的名字')
  })

  it('测试连接失败（结果 ok:false）：行内显示失败原因，工具清单不出', async () => {
    const api = installMockApi([serverConfig({ enabled: false })])
    api.testResults.set('echo', { ok: false, kind: 'spawn', message: '启动命令找不到' })
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    fireEvent.click(screen.getByTestId('mcp-server-0-test'))

    expect(await screen.findByTestId('mcp-server-0-test-result')).toHaveTextContent(
      '连接失败：启动命令找不到'
    )
    // 失败是"测试结果"不是"保存错误"：行内错误位不亮
    expect(screen.queryByTestId('mcp-server-0-error')).not.toBeInTheDocument()
  })
})
