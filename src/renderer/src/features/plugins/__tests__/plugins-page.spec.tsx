import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearKyclawBridge,
  installKyclawBridge,
  type KyclawBridgeStubs
} from '@renderer/__tests__/kyclaw-bridge'
import { useSettingsStore } from '@renderer/lib/settings-store'
import { mcpServersProblems, URL_PROBLEM, type McpTestResult } from '@shared/mcp'
import type { PluginsOverview, MarketplacePluginView, MarketplaceView } from '@shared/plugins'
import { WEB_SEARCH_PRESET } from '@shared/search'
import { defaultSettings, type InstalledPlugin, type McpServerConfig } from '@shared/settings'
import { PluginsPage } from '../PluginsPage'

/**
 * 插件页（round 5 起，round 10 三分区）：**插件｜MCP｜技能**（默认「插件」）。
 * 「插件」分区 = 插件市场（添加/刷新/移除）+ 跨市场插件汇总（安装/卸载），数据走 `plugins:overview` 桥；
 * 「MCP」分区沿用 round 9 的行式列表（开关启停 + 齿轮编辑 + ＋新增菜单，fetch 面；round 11 起
 * 「测试连接」在编辑对话框里，保存成功即关框）；
 * 「技能」分区 = 内置技能一组 + 插件技能一组（round 64：内置技能也进 `installedSkills`，
 * 按回包的 `source` 分两组）。
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

/** 切到 MCP tab（round 10 起默认 tab 是「插件」） */
function openMcpTab(): void {
  fireEvent.click(screen.getByTestId('plugins-tab-mcp'))
}

/** 打开第 index 行的编辑对话框 */
function openEditor(index = 0): void {
  fireEvent.click(screen.getByTestId(`mcp-server-${index}-edit`))
}

/* ---- round 10：插件分区的总览 fixture 与桥 ---- */

const EMPTY_OVERVIEW: PluginsOverview = { marketplaces: [], installed: [], installedSkills: [] }

function pluginView(patch: Partial<MarketplacePluginView> = {}): MarketplacePluginView {
  return {
    name: 'p1',
    description: '一个本地插件',
    source: { kind: 'relative', path: './plugins/p1' },
    skills: ['s1'],
    mcpServers: ['web'],
    supported: true,
    icon: false,
    ...patch
  }
}

function marketplaceView(patch: Partial<MarketplaceView> = {}): MarketplaceView {
  return {
    id: 'demo',
    name: 'demo-market',
    source: 'owner/repo',
    kind: 'git',
    path: 'C:/data/plugins/marketplaces/demo',
    addedAt: '2026-10-11T00:00:00.000Z',
    plugins: [pluginView()],
    ...patch
  }
}

function installedRecord(patch: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: 'demo-p1',
    marketplaceId: 'demo',
    name: 'p1',
    installedAt: '2026-10-11T00:00:00.000Z',
    mcpServerIds: ['plugin-demo-p1-web'],
    skillDirs: ['demo-p1-s1'],
    installDir: null,
    ...patch
  }
}

/** 装桥并把插件总览的一次拉取喂成 fixture（用例再按需替换单个方法） */
function installPluginsBridge(overview: PluginsOverview): KyclawBridgeStubs {
  const bridge = installKyclawBridge()
  bridge.plugins.overview.mockResolvedValue(overview)
  return bridge
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

describe('插件页 · 三个分区（round 10）', () => {
  it('默认「插件」：标签 + 计数 + 副标题；插件区空态、MCP 区才有 mcp-add、技能区没有新增', async () => {
    installMockApi([])
    installPluginsBridge(EMPTY_OVERVIEW)
    render(<PluginsPage />)

    expect(screen.getByTestId('plugins-page')).toBeInTheDocument()
    // round 11：标题区随 tab（h1 + 副标题）
    expect(screen.getByTestId('plugins-title')).toHaveTextContent('插件')
    expect(screen.getByTestId('plugins-subtitle')).toHaveTextContent('从插件市场安装与管理插件')
    expect(screen.getByTestId('plugins-tab-plugins')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('plugins-tab-mcp')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByTestId('plugins-tab-skills')).toHaveAttribute('aria-selected', 'false')
    // 计数：插件 1（round 48 起内置插件常驻，也算一行）/ MCP 0 / 技能 0（round 13：技能计数 = 已安装数，内置技能下线）
    expect(screen.getByTestId('plugins-tab-plugins-count')).toHaveTextContent('1')
    expect(screen.getByTestId('plugins-tab-mcp-count')).toHaveTextContent('0')
    expect(screen.getByTestId('plugins-tab-skills-count')).toHaveTextContent('0')

    // 插件区：市场与插件的空态；新增入口是「添加插件市场」（mcp-add 不出现）
    expect(await screen.findByTestId('marketplace-empty')).toHaveTextContent('还没有插件市场')
    expect(screen.getByTestId('plugin-empty')).toHaveTextContent('添加市场后')
    expect(screen.getByTestId('plugins-add')).toHaveTextContent('新增')
    expect(screen.queryByTestId('mcp-add')).not.toBeInTheDocument()

    openMcpTab()
    expect(screen.getByTestId('plugins-tab-mcp')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('plugins-title')).toHaveTextContent('MCP')
    expect(screen.getByTestId('plugins-subtitle')).toHaveTextContent('连接外部工具服务')
    expect(screen.getByTestId('mcp-add')).toHaveTextContent('新增')
    expect(await screen.findByTestId('mcp-empty')).toHaveTextContent('还没有 MCP 服务')

    // 技能区：插件技能一组 + 空态（这份 fixture 没有技能，内置一组不出标题）；计数 = 清单条数
    fireEvent.click(screen.getByTestId('plugins-tab-skills'))
    expect(screen.getByTestId('plugins-title')).toHaveTextContent('技能')
    expect(screen.getByTestId('plugins-subtitle')).toHaveTextContent('查看内置与插件技能')
    expect(screen.getByTestId('skills-plugins')).toHaveTextContent('插件技能')
    expect(screen.getByTestId('skills-plugins-empty')).toHaveTextContent('还没有插件带来的技能')
    // 没有内置技能就不留一个空标题
    expect(screen.queryByTestId('skills-builtin')).not.toBeInTheDocument()
    expect(screen.queryByText('内置技能')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mcp-add')).not.toBeInTheDocument()
    expect(screen.queryByTestId('plugins-add')).not.toBeInTheDocument()
  })

  it('底部常驻添加 chips 已删除（round 5）：新增走右上角菜单（round 9 起含「从 JSON 导入」）', async () => {
    installMockApi([])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-empty')

    // 新增走右上角菜单：按钮点了才出现选项
    expect(screen.queryByTestId('mcp-add-stdio')).not.toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('mcp-add'), { key: 'ArrowDown' })
    expect(screen.getByTestId('mcp-add-stdio')).toHaveTextContent('本地命令（stdio）')
    expect(screen.getByTestId('mcp-add-http')).toHaveTextContent('远程地址（HTTP）')
    expect(screen.getByTestId('mcp-add-json')).toHaveTextContent('从 JSON 导入')
  })

  it('＋新增（stdio）：点菜单项直接开对话框；填好保存才落盘（停用）→ 列表出现新行', async () => {
    const api = installMockApi([])
    render(<PluginsPage />)

    // 技能 tab 上新增入口不出现；切到 MCP 后走菜单新增
    openMcpTab()
    await screen.findByTestId('mcp-empty')
    fireEvent.keyDown(screen.getByTestId('mcp-add'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('mcp-add-stdio'))

    // round 9：直接开对话框填配置——不再先往列表落一条空草稿
    expect(api.state.servers).toEqual([])
    expect(screen.getByTestId('mcp-add-command')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('mcp-add-name'), { target: { value: '回显测试' } })
    fireEvent.change(screen.getByTestId('mcp-add-command'), { target: { value: 'node' } })
    fireEvent.change(screen.getByTestId('mcp-add-args'), { target: { value: 'server.mjs' } })
    fireEvent.click(screen.getByTestId('mcp-add-save'))

    await waitFor(() =>
      expect(api.state.servers).toEqual([
        expect.objectContaining({
          name: '回显测试',
          transport: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          enabled: false
        })
      ])
    )
    // 对话框关掉、行列表里出现新条目
    await waitFor(() => expect(screen.queryByTestId('mcp-add-save')).not.toBeInTheDocument())
    expect(await screen.findByTestId('mcp-server-0')).toHaveTextContent('回显测试')
  })

  it('＋新增：校验不过时保存禁用 + 行内给原因；取消什么都不发生', async () => {
    const api = installMockApi([])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-empty')
    fireEvent.keyDown(screen.getByTestId('mcp-add'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('mcp-add-http'))

    expect(screen.getByTestId('mcp-add-save')).toBeDisabled()
    expect(screen.getByTestId('mcp-add-problems')).toHaveTextContent('HTTP 服务需要填写地址')

    fireEvent.change(screen.getByTestId('mcp-add-url'), { target: { value: 'ftp://x/mcp' } })
    expect(screen.getByTestId('mcp-add-problems')).toHaveTextContent('HTTP 地址要是完整的')

    fireEvent.change(screen.getByTestId('mcp-add-url'), {
      target: { value: 'https://api.example/mcp' }
    })
    expect(screen.getByTestId('mcp-add-save')).toBeEnabled()

    // HTTP 新增：Headers 键值行编辑器（填一行）
    fireEvent.click(screen.getByTestId('mcp-add-headers-add'))
    fireEvent.change(screen.getByTestId('mcp-add-headers-name-0'), {
      target: { value: 'Authorization' }
    })
    fireEvent.change(screen.getByTestId('mcp-add-headers-value-0'), {
      target: { value: 'Bearer T' }
    })

    // 取消：不落盘、关对话框
    fireEvent.click(screen.getByTestId('mcp-add-cancel'))
    await waitFor(() => expect(screen.queryByTestId('mcp-add-save')).not.toBeInTheDocument())
    expect(api.state.servers).toEqual([])

    // 再开一次：表单是新的（上一次填的没带去）
    fireEvent.keyDown(screen.getByTestId('mcp-add'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('mcp-add-http'))
    expect(screen.getByTestId('mcp-add-url')).toHaveValue('')
    expect(screen.queryByTestId('mcp-add-headers-name-0')).not.toBeInTheDocument()
  })

  it('从 JSON 导入：整段 mcpServers 多条都进（停用 + headers 原样）；失败行内报错且保留输入', async () => {
    const api = installMockApi([])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-empty')
    fireEvent.keyDown(screen.getByTestId('mcp-add'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('mcp-add-json'))

    // 坏 JSON：行内错误、输入保留（不清空）、不落盘
    const textarea = screen.getByTestId('mcp-add-json-text')
    fireEvent.change(textarea, { target: { value: '{oops' } })
    fireEvent.click(screen.getByTestId('mcp-add-json-import'))
    expect(await screen.findByTestId('mcp-add-json-error')).toHaveTextContent('不是合法的 JSON')
    expect(textarea).toHaveValue('{oops')
    expect(api.state.servers).toEqual([])

    // 用户原话那种整段 JSON：http（带 headers）+ stdio 一起导入
    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          mcpServers: {
            perfsight: {
              type: 'http',
              url: 'https://api.perfsight.qq.com/mcp',
              headers: { Authorization: 'Bearer YOUR_API_KEY' }
            },
            echo: { command: 'node', args: ['echo.mjs'] }
          }
        })
      }
    })
    fireEvent.click(screen.getByTestId('mcp-add-json-import'))

    await waitFor(() => expect(api.state.servers).toHaveLength(2))
    expect(api.state.servers[0]).toMatchObject({
      id: 'perfsight',
      transport: 'http',
      headers: { Authorization: 'Bearer YOUR_API_KEY' },
      enabled: false
    })
    expect(api.state.servers[1]).toMatchObject({
      id: 'echo',
      transport: 'stdio',
      command: 'node',
      enabled: false
    })
    // 对话框关掉、列表出现两条（顺序 = 导入顺序）
    await waitFor(() => expect(screen.queryByTestId('mcp-add-json-text')).not.toBeInTheDocument())
    expect(await screen.findByTestId('mcp-server-0')).toHaveTextContent('perfsight')
    expect(screen.getByTestId('mcp-server-1')).toHaveTextContent('echo')
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

  it('齿轮编辑：保存落盘并关对话框；重开改字段再取消 → 不写（round 11：保存要有返回）', async () => {
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
    // round 11 用户实拍：保存成功 → 关闭对话框（这就是点保存的"返回"）
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // 重开：改了字段但点取消，不落盘
    openEditor()
    fireEvent.change(screen.getByTestId('mcp-server-0-name'), { target: { value: '不保存' } })
    fireEvent.click(screen.getByTestId('mcp-edit-cancel'))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.state.servers[0].name).toBe('我的回显')
  })

  it('保存失败：行内报原因、对话框留在原地（round 11）', async () => {
    const api = installMockApi([serverConfig()])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    openEditor()
    // 清掉命令：启用中的 server 保存会被服务端拦下（400）
    fireEvent.change(screen.getByTestId('mcp-server-0-command'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('mcp-server-0-save'))

    expect(await screen.findByTestId('mcp-server-0-error')).toHaveTextContent('启动命令')
    expect(screen.getByTestId('mcp-server-0-save')).toBeInTheDocument()
    // 没落盘：磁盘上仍是原命令
    expect(api.state.servers[0].command).toBe('node')
  })

  it('编辑对话框（http）：Headers 键值行编辑器——填一行保存落盘（round 9）', async () => {
    const api = installMockApi([
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
    await screen.findByTestId('mcp-server-0')

    openEditor()
    // stdio 的字段不出现；Headers 编辑器在
    expect(screen.queryByTestId('mcp-server-0-command')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mcp-server-0-headers-add'))
    fireEvent.change(screen.getByTestId('mcp-server-0-headers-name-0'), {
      target: { value: 'Authorization' }
    })
    fireEvent.change(screen.getByTestId('mcp-server-0-headers-value-0'), {
      target: { value: 'Bearer T' }
    })
    fireEvent.click(screen.getByTestId('mcp-server-0-save'))

    await waitFor(() => expect(api.state.servers[0].headers).toEqual({ Authorization: 'Bearer T' }))
  })

  it('编辑对话框（stdio）：环境变量编辑器复用同一组件；空行在保存时丢弃（round 9）', async () => {
    const api = installMockApi([serverConfig({ env: { API_KEY: 'old' }, enabled: false })])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    openEditor()
    // 已有的 env 预填成一行
    expect(screen.getByTestId('mcp-server-0-env-name-0')).toHaveValue('API_KEY')
    expect(screen.getByTestId('mcp-server-0-env-value-0')).toHaveValue('old')

    // 加一行只填值（名字空着）→ 保存时应被丢弃
    fireEvent.click(screen.getByTestId('mcp-server-0-env-add'))
    fireEvent.change(screen.getByTestId('mcp-server-0-env-value-1'), {
      target: { value: '丢弃' }
    })
    fireEvent.click(screen.getByTestId('mcp-server-0-save'))

    await waitFor(() => expect(api.puts.length).toBeGreaterThan(0))
    expect(api.state.servers[0].env).toEqual({ API_KEY: 'old' })
  })

  it('测试连接搬进编辑对话框：行内没有；开框测试出结果 + 工具清单 + 免审批开关（round 11）', async () => {
    const api = installMockApi([serverConfig({ enabled: false })])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    // 行内不再有「测试连接」（按钮搬进对话框）
    expect(screen.queryByTestId('mcp-server-0-test')).not.toBeInTheDocument()

    openEditor()
    fireEvent.click(screen.getByTestId('mcp-server-0-test'))
    expect(await screen.findByTestId('mcp-server-0-test-result')).toHaveTextContent('连接正常')
    // 对话框没被内部保存/测试的流转关掉
    expect(screen.getByTestId('mcp-server-0-save')).toBeInTheDocument()

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

  it('dirty 先存再测：对话框里改了没保存的字段，点「测试连接」先落盘再真连（PUT → 测试），内部保存不关框', async () => {
    const api = installMockApi([serverConfig({ enabled: false })])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    openEditor()
    fireEvent.change(screen.getByTestId('mcp-server-0-name'), { target: { value: '改过的名字' } })

    api.calls.length = 0
    fireEvent.click(screen.getByTestId('mcp-server-0-test'))
    expect(await screen.findByTestId('mcp-server-0-test-result')).toHaveTextContent('连接正常')

    expect(api.calls).toEqual(['PUT', 'POST-test'])
    expect(api.state.servers[0].name).toBe('改过的名字')
    // 「关对话框」只属于「保存」按钮：测试触发的内部自动保存不关
    expect(screen.getByTestId('mcp-server-0-save')).toBeInTheDocument()
  })

  it('测试连接失败（结果 ok:false）：对话框里显示失败原因，工具清单不出', async () => {
    const api = installMockApi([serverConfig({ enabled: false })])
    api.testResults.set('echo', { ok: false, kind: 'spawn', message: '启动命令找不到' })
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    openEditor()
    fireEvent.click(screen.getByTestId('mcp-server-0-test'))

    expect(await screen.findByTestId('mcp-server-0-test-result')).toHaveTextContent(
      '连接失败：启动命令找不到'
    )
    // 失败是"测试结果"不是"保存错误"：错误位不亮、工具清单不出
    expect(screen.queryByTestId('mcp-server-0-error')).not.toBeInTheDocument()
    expect(screen.queryByTestId('mcp-server-0-tools')).not.toBeInTheDocument()
  })

  it('半截地址（http://）：行内 problems 当场说出来；启用被服务端拦下，开关不变', async () => {
    installMockApi([
      serverConfig({
        id: 'remote',
        name: '远程',
        transport: 'http',
        url: 'http://',
        command: undefined,
        args: undefined,
        enabled: false
      })
    ])
    render(<PluginsPage />)
    openMcpTab()
    await screen.findByTestId('mcp-server-0')

    // 半截串过得了前缀检查、过不了 new URL：等连接期才炸就太晚了（界面用服务端同一份校验）
    expect(screen.getByTestId('mcp-server-0-problems')).toHaveTextContent(URL_PROBLEM)

    fireEvent.click(screen.getByTestId('mcp-server-0-enable'))
    expect(await screen.findByTestId('mcp-server-0-error')).toHaveTextContent(URL_PROBLEM)
    expect(screen.getByTestId('mcp-server-0-enable')).toHaveAttribute('aria-checked', 'false')
  })
})

describe('插件页 · 插件分区（round 10：市场 / 安装 / 卸载）', () => {
  it('市场行与插件行：名称/来源/n 个插件；相对来源显示组件摘要，unsupported 行没有安装按钮', async () => {
    installMockApi([])
    installPluginsBridge({
      marketplaces: [
        marketplaceView({
          plugins: [
            pluginView(),
            pluginView({
              name: 'p2',
              description: '',
              source: { kind: 'unsupported', label: 'npm' },
              skills: [],
              mcpServers: [],
              supported: false
            })
          ]
        })
      ],
      installed: [],
      installedSkills: []
    })
    render(<PluginsPage />)

    const row = await screen.findByTestId('marketplace-demo')
    expect(row).toHaveTextContent('demo-market')
    expect(row).toHaveTextContent('owner/repo')
    expect(row).toHaveTextContent('2 个插件')
    // 计数 = 内置 1 + 市场上的 2（round 48）
    expect(screen.getByTestId('plugins-tab-plugins-count')).toHaveTextContent('3')

    const p1 = screen.getByTestId('plugin-demo-p1')
    expect(p1).toHaveTextContent('一个本地插件')
    expect(p1).toHaveTextContent('技能 1 · MCP 1')
    expect(screen.getByTestId('plugin-demo-p1-install')).toHaveTextContent('安装')

    const p2 = screen.getByTestId('plugin-demo-p2')
    expect(p2).toHaveTextContent('这种来源暂不支持')
    expect(screen.queryByTestId('plugin-demo-p2-install')).not.toBeInTheDocument()
  })

  it('添加市场：来源空时禁用；提交把三字段带给主进程，成功后关框、列表换新', async () => {
    installMockApi([])
    const bridge = installPluginsBridge(EMPTY_OVERVIEW)
    bridge.plugins.addMarketplace.mockResolvedValue({
      marketplaces: [marketplaceView()],
      installed: [],
      installedSkills: []
    })
    render(<PluginsPage />)

    await screen.findByTestId('marketplace-empty')
    fireEvent.keyDown(screen.getByTestId('plugins-add'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('marketplace-add'))

    const save = screen.getByTestId('marketplace-save')
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByTestId('marketplace-source'), { target: { value: 'owner/repo' } })
    expect(save).toBeEnabled()
    fireEvent.change(screen.getByTestId('marketplace-ref'), { target: { value: 'v1' } })
    // 稀疏路径：每行一条，空行与首尾空白被丢
    fireEvent.change(screen.getByTestId('marketplace-sparse'), {
      target: { value: 'plugins/foo\n\nplugins/bar ' }
    })
    fireEvent.click(save)

    await waitFor(() =>
      expect(bridge.plugins.addMarketplace).toHaveBeenCalledWith({
        source: 'owner/repo',
        ref: 'v1',
        sparsePaths: ['plugins/foo', 'plugins/bar']
      })
    )
    await waitFor(() => expect(screen.queryByTestId('marketplace-save')).not.toBeInTheDocument())
    expect(await screen.findByTestId('marketplace-demo')).toBeInTheDocument()
  })

  it('添加市场失败：行内 marketplace-error 说原因，框不关、输入保留', async () => {
    installMockApi([])
    const bridge = installPluginsBridge(EMPTY_OVERVIEW)
    bridge.plugins.addMarketplace.mockRejectedValue(new Error('克隆失败：repository not found'))
    render(<PluginsPage />)

    await screen.findByTestId('marketplace-empty')
    fireEvent.keyDown(screen.getByTestId('plugins-add'), { key: 'ArrowDown' })
    fireEvent.click(screen.getByTestId('marketplace-add'))
    fireEvent.change(screen.getByTestId('marketplace-source'), { target: { value: 'owner/nope' } })
    fireEvent.click(screen.getByTestId('marketplace-save'))

    expect(await screen.findByTestId('marketplace-error')).toHaveTextContent(
      '克隆失败：repository not found'
    )
    expect(screen.getByTestId('marketplace-save')).toBeInTheDocument()
    expect(screen.getByTestId('marketplace-source')).toHaveValue('owner/nope')
    expect(screen.queryByTestId('marketplace-demo')).not.toBeInTheDocument()
  })

  it('刷新：调 refreshMarketplace 并用回包换市场行', async () => {
    installMockApi([])
    const bridge = installPluginsBridge({
      marketplaces: [marketplaceView()],
      installed: [],
      installedSkills: []
    })
    bridge.plugins.refreshMarketplace.mockResolvedValue({
      marketplaces: [marketplaceView({ name: 'demo-market-v2' })],
      installed: [],
      installedSkills: []
    })
    render(<PluginsPage />)

    await screen.findByTestId('marketplace-demo')
    fireEvent.click(screen.getByTestId('marketplace-demo-refresh'))

    await waitFor(() => expect(bridge.plugins.refreshMarketplace).toHaveBeenCalledWith('demo'))
    expect(await screen.findByTestId('marketplace-demo')).toHaveTextContent('demo-market-v2')
  })

  it('移除市场：先确认（可取消，不发请求）；确认后调 removeMarketplace，行消失回空态', async () => {
    installMockApi([])
    const bridge = installPluginsBridge({
      marketplaces: [marketplaceView()],
      installed: [],
      installedSkills: []
    })
    bridge.plugins.removeMarketplace.mockResolvedValue(EMPTY_OVERVIEW)
    render(<PluginsPage />)

    await screen.findByTestId('marketplace-demo')
    fireEvent.click(screen.getByTestId('marketplace-demo-remove'))
    expect(screen.getByRole('dialog')).toHaveTextContent('移除这个插件市场？')
    fireEvent.click(screen.getByTestId('marketplace-remove-cancel'))
    expect(bridge.plugins.removeMarketplace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('marketplace-demo-remove'))
    fireEvent.click(screen.getByTestId('marketplace-remove-confirm'))
    await waitFor(() => expect(bridge.plugins.removeMarketplace).toHaveBeenCalledWith('demo'))
    await waitFor(() => expect(screen.queryByTestId('marketplace-demo')).not.toBeInTheDocument())
    expect(await screen.findByTestId('marketplace-empty')).toBeInTheDocument()
  })

  it('安装：调 install 后行变「已安装」；卸载先确认再调 uninstall，行回到「安装」', async () => {
    installMockApi([])
    const base: PluginsOverview = {
      marketplaces: [marketplaceView()],
      installed: [],
      installedSkills: []
    }
    const bridge = installPluginsBridge(base)
    bridge.plugins.install.mockResolvedValue({
      marketplaces: base.marketplaces,
      installed: [installedRecord()],
      installedSkills: [{ dir: 'demo-p1-s1', name: 's1', pluginId: 'demo-p1', pluginName: 'p1' }]
    })
    bridge.plugins.uninstall.mockResolvedValue(base)
    render(<PluginsPage />)

    await screen.findByTestId('plugin-demo-p1')
    fireEvent.click(screen.getByTestId('plugin-demo-p1-install'))
    await waitFor(() => expect(bridge.plugins.install).toHaveBeenCalledWith('demo', 'p1'))
    expect(await screen.findByTestId('plugin-demo-p1-state')).toHaveTextContent('已安装')

    fireEvent.click(screen.getByTestId('plugin-demo-p1-uninstall'))
    expect(screen.getByRole('dialog')).toHaveTextContent('卸载这个插件？')
    fireEvent.click(screen.getByTestId('plugin-uninstall-confirm'))
    await waitFor(() => expect(bridge.plugins.uninstall).toHaveBeenCalledWith('demo-p1'))
    await waitFor(() =>
      expect(screen.queryByTestId('plugin-demo-p1-state')).not.toBeInTheDocument()
    )
    expect(screen.getByTestId('plugin-demo-p1-install')).toBeInTheDocument()
  })

  it('安装失败：页级 plugins-error 说出原因，不假装装上', async () => {
    installMockApi([])
    const bridge = installPluginsBridge({
      marketplaces: [marketplaceView()],
      installed: [],
      installedSkills: []
    })
    bridge.plugins.install.mockRejectedValue(new Error('这个插件暂时装不了'))
    render(<PluginsPage />)

    await screen.findByTestId('plugin-demo-p1')
    fireEvent.click(screen.getByTestId('plugin-demo-p1-install'))

    expect(await screen.findByTestId('plugins-error')).toHaveTextContent('这个插件暂时装不了')
    expect(screen.getByTestId('plugin-demo-p1-install')).toBeInTheDocument()
  })

  it('总览读不到：页级 plugins-error 说原因（不静默当空列表）', async () => {
    installMockApi([])
    const bridge = installKyclawBridge()
    bridge.plugins.overview.mockRejectedValue(new Error('插件通道不可用（window.kyclaw 缺失）'))
    render(<PluginsPage />)

    expect(await screen.findByTestId('plugins-error')).toHaveTextContent('插件通道不可用')
  })

  it('技能分区：内置与插件分两组，内置的不写「来自插件」，插件行写清来自谁（round 64）', async () => {
    installMockApi([])
    installPluginsBridge({
      marketplaces: [marketplaceView()],
      installed: [installedRecord()],
      installedSkills: [
        { dir: 'pptx', name: 'pptx', pluginId: null, pluginName: null, source: 'builtin' },
        { dir: 'docx', name: 'docx', pluginId: null, pluginName: null, source: 'builtin' },
        // 插件技能：老回包不带 source；带 source: 'plugin' 的也归插件一组
        { dir: 'demo-p1-s1', name: 's1', pluginId: 'demo-p1', pluginName: 'p1' },
        { dir: 'demo-p1-s2', name: 's2', pluginId: 'demo-p1', pluginName: 'p1', source: 'plugin' },
        // 认不出是哪个插件的技能（老回包的 pluginName 为 null）
        { dir: 'orphan-x', name: 'x', pluginId: null, pluginName: null }
      ]
    })
    render(<PluginsPage />)

    fireEvent.click(screen.getByTestId('plugins-tab-skills'))

    // 内置一组在前：只有名字，不出现「来自插件」这类错误归属
    const builtin = await screen.findByTestId('skills-builtin')
    expect(builtin).toHaveTextContent('内置技能')
    const builtinRow = within(builtin).getByTestId('skill-installed-pptx')
    expect(builtinRow).toHaveTextContent('pptx')
    expect(builtinRow).not.toHaveTextContent('来自')
    expect(within(builtin).getByTestId('skill-installed-docx')).toBeInTheDocument()

    // 插件一组：来自哪个插件写在行上；认不出归属的行不给这一行（标题已经说明它来自插件）
    const plugins = screen.getByTestId('skills-plugins')
    expect(plugins).toHaveTextContent('插件技能')
    expect(within(plugins).getByTestId('skill-installed-demo-p1-s1')).toHaveTextContent('来自 p1')
    expect(within(plugins).getByTestId('skill-installed-demo-p1-s2')).toHaveTextContent('来自 p1')
    expect(within(plugins).getByTestId('skill-installed-orphan-x')).not.toHaveTextContent(
      '来自插件'
    )
    // 内置技能不进插件一组；两组不重不漏
    expect(within(plugins).queryByTestId('skill-installed-pptx')).not.toBeInTheDocument()
    expect(within(builtin).getAllByTestId(/^skill-installed-/)).toHaveLength(2)
    expect(within(plugins).getAllByTestId(/^skill-installed-/)).toHaveLength(3)

    // 计数 = 清单条数（内置也在这份清单里）
    expect(screen.getByTestId('plugins-tab-skills-count')).toHaveTextContent('5')
    expect(screen.queryByTestId('skills-plugins-empty')).not.toBeInTheDocument()
  })

  it('技能分区：只有内置技能时内置照列、插件一组给空态（round 64）', async () => {
    installMockApi([])
    installPluginsBridge({
      marketplaces: [],
      installed: [],
      installedSkills: [
        { dir: 'pptx', name: 'pptx', pluginId: null, pluginName: null, source: 'builtin' },
        { dir: 'docx', name: 'docx', pluginId: null, pluginName: null, source: 'builtin' },
        { dir: 'xlsx', name: 'xlsx', pluginId: null, pluginName: null, source: 'builtin' },
        { dir: 'pdf', name: 'pdf', pluginId: null, pluginName: null, source: 'builtin' }
      ]
    })
    render(<PluginsPage />)

    fireEvent.click(screen.getByTestId('plugins-tab-skills'))

    const builtin = await screen.findByTestId('skills-builtin')
    expect(builtin).toHaveTextContent('内置技能')
    expect(within(builtin).getAllByTestId(/^skill-installed-/)).toHaveLength(4)
    expect(builtin).not.toHaveTextContent('来自')
    // 真正的空态是"没有插件技能"：内置技能不拿来填这一组
    expect(screen.getByTestId('skills-plugins-empty')).toHaveTextContent(
      '还没有插件带来的技能：去「插件」里安装一个插件。'
    )
    const pluginGroup = screen.getByTestId('skills-plugins')
    expect(within(pluginGroup).queryByTestId('skill-installed-pptx')).not.toBeInTheDocument()
    expect(within(pluginGroup).queryByTestId(/^skill-installed-/)).not.toBeInTheDocument()
    expect(screen.getByTestId('plugins-tab-skills-count')).toHaveTextContent('4')
  })
})

describe('round 48 · 内置插件（联网搜索）', () => {
  beforeEach(() => {
    // 内置插件的设置面读渲染端的设置副本：每个用例都从默认值起，免得跟着别处的改动漂
    useSettingsStore.setState({ settings: defaultSettings() })
  })

  it('常驻：0 市场 0 插件也在「内置插件」一组里；没有安装 / 卸载，市场的两个空态照旧', async () => {
    installPluginsBridge(EMPTY_OVERVIEW)
    render(<PluginsPage />)

    const row = await screen.findByTestId('builtin-plugin-web-search')
    expect(screen.getByTestId('builtin-plugins')).toHaveTextContent('内置插件')
    expect(row).toHaveTextContent('联网搜索')
    expect(row).toHaveAttribute('aria-expanded', 'false')
    // 不是市场来的插件：没有安装 / 卸载 / 已安装态
    for (const testId of [
      'builtin-plugin-web-search-install',
      'builtin-plugin-web-search-uninstall',
      'builtin-plugin-web-search-state'
    ]) {
      expect(screen.queryByTestId(testId), testId).not.toBeInTheDocument()
    }
    // 市场的空态照旧；标签计数把常驻的内置插件算成一行
    expect(screen.getByTestId('marketplace-empty')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-empty')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-tab-plugins-count')).toHaveTextContent('1')
  })

  it('点行展开它的设置面；没点过不上 DOM，也不提前读密钥状态', async () => {
    const bridge = installPluginsBridge(EMPTY_OVERVIEW)
    render(<PluginsPage />)

    const row = await screen.findByTestId('builtin-plugin-web-search')
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByTestId('web-search-settings')).not.toBeInTheDocument()
    expect(bridge.search.keyStates).not.toHaveBeenCalled()

    fireEvent.click(row)

    expect(row).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('trace-fold')).toHaveAttribute('data-open', 'true')
    expect(screen.getByTestId('builtin-plugin-web-search-settings')).toBeInTheDocument()
    expect(await screen.findByTestId('web-search-mode-free')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('web-search-reader-endpoint')).toBeInTheDocument()
    await waitFor(() => expect(bridge.search.keyStates).toHaveBeenCalled())
  })

  it('再点收起：不硬切（内容留在 DOM 里参与折叠过渡）', async () => {
    installPluginsBridge(EMPTY_OVERVIEW)
    render(<PluginsPage />)

    const row = await screen.findByTestId('builtin-plugin-web-search')
    fireEvent.click(row)
    fireEvent.click(row)

    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('trace-fold')).toHaveAttribute('data-open', 'false')
    // 收起 ≠ 卸载：设置面还在 DOM 里（雷点 5）
    expect(screen.getByTestId('web-search-settings')).toBeInTheDocument()
  })

  it('展开后的配置真能用：切自定义档当场落盘；地址与 Key 保存走各自的通道', async () => {
    const bridge = installPluginsBridge(EMPTY_OVERVIEW)
    render(<PluginsPage />)

    fireEvent.click(await screen.findByTestId('builtin-plugin-web-search'))

    fireEvent.click(screen.getByTestId('web-search-mode-custom'))
    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith(
        expect.objectContaining({ webSearch: expect.objectContaining({ mode: 'custom' }) })
      )
    )
    expect(screen.getByTestId('web-search-exa-key')).toBeInTheDocument()

    fireEvent.change(screen.getByTestId('web-search-reader-endpoint'), {
      target: { value: 'https://reader.example.com' }
    })
    fireEvent.change(screen.getByTestId('web-search-exa-key'), { target: { value: 'exa-1' } })
    fireEvent.click(screen.getByTestId('web-search-save'))

    await waitFor(() =>
      expect(bridge.update).toHaveBeenCalledWith({
        webSearch: {
          mode: 'custom',
          provider: 'exa',
          exaEndpoint: WEB_SEARCH_PRESET.exaEndpoint,
          readerEndpoint: 'https://reader.example.com'
        }
      })
    )
    await waitFor(() => expect(bridge.search.setKey).toHaveBeenCalledWith('exa', 'exa-1'))
  })

  it('与市场的安装态互不干扰：装了市场插件内置条目照旧，卸载也不动它', async () => {
    const bridge = installPluginsBridge({
      marketplaces: [marketplaceView()],
      installed: [installedRecord()],
      installedSkills: []
    })
    render(<PluginsPage />)

    expect(await screen.findByTestId('plugin-demo-p1-uninstall')).toBeInTheDocument()
    expect(screen.queryByTestId('builtin-plugin-web-search-uninstall')).not.toBeInTheDocument()

    bridge.plugins.uninstall.mockResolvedValue({
      marketplaces: [marketplaceView()],
      installed: [],
      installedSkills: []
    })
    fireEvent.click(screen.getByTestId('plugin-demo-p1-uninstall'))
    fireEvent.click(screen.getByTestId('plugin-uninstall-confirm'))

    await waitFor(() => expect(bridge.plugins.uninstall).toHaveBeenCalledWith('demo-p1'))
    expect(screen.getByTestId('builtin-plugin-web-search')).toBeInTheDocument()
    // 计数 = 内置 1 + 市场上的 1
    expect(screen.getByTestId('plugins-tab-plugins-count')).toHaveTextContent('2')
  })
})

describe('round 23 · 头像 / 图标 / 错误位置', () => {
  it('市场行与插件行都有头像；没有图标资源 = 字母头像（首字母 + 稳定底色）', async () => {
    installPluginsBridge({
      marketplaces: [marketplaceView({ name: 'demo-market' })],
      installed: [],
      installedSkills: []
    })
    render(<PluginsPage />)
    await screen.findByTestId('marketplace-demo')

    const marketAvatar = within(screen.getByTestId('marketplace-demo')).getByTestId('plugin-avatar')
    expect(marketAvatar).toHaveTextContent('D')
    const pluginAvatar = within(screen.getByTestId('plugin-demo-p1')).getByTestId('plugin-avatar')
    expect(pluginAvatar).toHaveTextContent('P')
    // 底色来自 Fills 三档之一（中性、稳定；同名永远同色由 avatar.ts 的单测钉）
    expect(
      ['bg-hover', 'bg-selected', 'bg-active'].some((tone) => pluginAvatar.classList.contains(tone))
    ).toBe(true)
  })

  it('icon=true：走 plugins:icon 取 data URL 并渲染 <img>（不是纯文字了）', async () => {
    const bridge = installPluginsBridge({
      marketplaces: [marketplaceView({ plugins: [pluginView({ icon: true })] })],
      installed: [],
      installedSkills: []
    })
    bridge.plugins.icon.mockResolvedValueOnce({ dataUrl: 'data:image/png;base64,AAAA' })

    render(<PluginsPage />)
    await screen.findByTestId('marketplace-demo')

    await waitFor(() => expect(bridge.plugins.icon).toHaveBeenCalledWith('demo', 'p1'))
    const img = await within(screen.getByTestId('plugin-demo-p1')).findByTestId('plugin-avatar-img')
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA')
  })

  it('icon=false：不发 icon 请求（没有图标资源就不消费 IPC）', async () => {
    const bridge = installPluginsBridge({
      marketplaces: [marketplaceView()],
      installed: [],
      installedSkills: []
    })
    render(<PluginsPage />)
    await screen.findByTestId('marketplace-demo')

    expect(bridge.plugins.icon).not.toHaveBeenCalled()
  })

  it('移除失败：错误行出现在面板**上方**（贴近动作；"没反应"的根修之一）', async () => {
    const bridge = installPluginsBridge({
      marketplaces: [marketplaceView()],
      installed: [],
      installedSkills: []
    })
    bridge.plugins.removeMarketplace.mockRejectedValueOnce(
      new Error('删除被占用：C:/data/plugins/marketplaces/demo（关掉占用它的程序后重试）')
    )
    render(<PluginsPage />)
    await screen.findByTestId('marketplace-demo')

    fireEvent.click(screen.getByTestId('marketplace-demo-remove'))
    fireEvent.click(screen.getByTestId('marketplace-remove-confirm'))

    const error = await screen.findByTestId('plugins-error')
    expect(error).toHaveTextContent('删除被占用')
    // DOM 顺序：错误行在面板容器之前（面板紧随其后）
    const panel = screen.getByTestId('plugins-plugin-panel')
    expect(error.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('round 25 · 卸载彻底清理与错误人话化', () => {
  it('移除市场确认框按 kind 分叉：git 说明本机下载的内容会一起删，local 说明不动本机目录', async () => {
    installMockApi([])
    installPluginsBridge({
      marketplaces: [
        marketplaceView({ id: 'g', name: 'git 市场', kind: 'git' }),
        marketplaceView({ id: 'l', name: '本地市场', kind: 'local', source: 'D:\\插件目录' })
      ],
      installed: [],
      installedSkills: []
    })
    render(<PluginsPage />)

    await screen.findByTestId('marketplace-g')
    fireEvent.click(screen.getByTestId('marketplace-g-remove'))
    expect(screen.getByRole('dialog')).toHaveTextContent('本机下载的这份市场内容会一起删除')
    fireEvent.click(screen.getByTestId('marketplace-remove-cancel'))

    fireEvent.click(screen.getByTestId('marketplace-l-remove'))
    expect(screen.getByRole('dialog')).toHaveTextContent('移除不会动你本机的这个目录')
  })

  it('卸载确认框说明会一起移除：插件带来的 MCP 服务、技能与本机下载的文件', async () => {
    installMockApi([])
    installPluginsBridge({
      marketplaces: [marketplaceView()],
      installed: [installedRecord()],
      installedSkills: [{ dir: 'demo-p1-s1', name: 's1', pluginId: 'demo-p1', pluginName: 'p1' }]
    })
    render(<PluginsPage />)

    await screen.findByTestId('plugin-demo-p1-uninstall')
    fireEvent.click(screen.getByTestId('plugin-demo-p1-uninstall'))
    expect(screen.getByRole('dialog')).toHaveTextContent(
      '带来的 MCP 服务、技能与本机下载的文件会一起移除'
    )
  })

  it('失败原因过了 IPC 包装也不露机器话（unwrapIpcError 展示）', async () => {
    installMockApi([])
    const bridge = installPluginsBridge({
      marketplaces: [marketplaceView()],
      installed: [],
      installedSkills: []
    })
    bridge.plugins.removeMarketplace.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'plugins:remove-marketplace': Error: 删除被占用：C:\\x（关掉占用它的程序后重试）"
      )
    )
    render(<PluginsPage />)
    await screen.findByTestId('marketplace-demo')

    fireEvent.click(screen.getByTestId('marketplace-demo-remove'))
    fireEvent.click(screen.getByTestId('marketplace-remove-confirm'))

    const error = await screen.findByTestId('plugins-error')
    expect(error).toHaveTextContent('删除被占用')
    expect(error).not.toHaveTextContent('Error invoking remote method')
  })
})
