import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * plugins 通道 handler（round 10）：市场增/刷/删 + 插件装/卸 + 总览装配。
 * 重点：① 入参先过闸门（非法调用不碰磁盘）；② 安装/卸载连带 mcpServers 与技能的增删落在
 * settings.json（新增一律停用）；③ 总览装配（技能名去插件前缀、反查来源插件）；④ 移除市场连带
 * 卸载它名下的插件（local 市场不删用户目录）。
 */
const mocks = vi.hoisted(() => {
  type Handler = (event: unknown, ...args: unknown[]) => unknown
  return {
    handlers: new Map<string, Handler>(),
    /** round 94：原生选择器（技能导入的 file/folder 入口） */
    dialog: vi.fn(),
    /** BrowserWindow.fromWebContents 的返回值：null = 没有父窗口 */
    window: null as unknown
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  },
  BrowserWindow: { fromWebContents: () => mocks.window },
  dialog: { showOpenDialog: mocks.dialog }
}))

import { IPC_CHANNELS, IpcInputError } from '../../../shared/ipc'
import type { PluginsOverview } from '../../../shared/plugins'
import { readSettings, settingsPath, updateSettings } from '../../settings'
import { registerPluginIpc } from '../plugins'

const EVENT = { sender: { id: 1 } }

function handlerOf(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`通道没注册：${channel}`)
  return handler
}

let dir: string

beforeEach(() => {
  mocks.handlers.clear()
  mocks.dialog.mockReset()
  mocks.window = null
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-plugins-ipc-'))
  registerPluginIpc(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const settings = (): ReturnType<typeof readSettings> => readSettings(settingsPath(dir))

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function writeJson(path: string, data: unknown): void {
  writeFile(path, JSON.stringify(data, null, 2))
}

/** 一个本机市场：p-relative（一个 MCP 服务器 + 一个技能）与 p-npm（不支持） */
function makeMarket(base: string): string {
  const market = join(base, 'market')
  writeJson(join(market, '.claude-plugin', 'marketplace.json'), {
    name: 'demo-market',
    plugins: [
      { name: 'p-relative', source: './plugins/p-relative' },
      { name: 'p-npm', source: { source: 'npm', package: '@scope/x' } }
    ]
  })
  const plugin = join(market, 'plugins', 'p-relative')
  writeJson(join(plugin, '.mcp.json'), {
    mcpServers: { web: { type: 'http', url: 'https://api.example.com/mcp' } }
  })
  writeFile(join(plugin, 'skills', 'demo', 'SKILL.md'), '# demo\n')
  return market
}

describe('plugins 通道 handler：注册与入参闸门', () => {
  it('九条通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'plugins:add-marketplace',
      'plugins:add-skill-url',
      'plugins:icon',
      'plugins:import-skill-local',
      'plugins:install',
      'plugins:overview',
      'plugins:refresh-marketplace',
      'plugins:remove-marketplace',
      'plugins:uninstall'
    ])
  })

  it('入参先过闸门（非法调用不碰磁盘）', async () => {
    const add = handlerOf(IPC_CHANNELS.plugins.addMarketplace)
    for (const args of [[], [{}], [{ source: '' }], [{ source: 'x', ref: 1 }], ['x']]) {
      await expect(add(EVENT, ...args), JSON.stringify(args)).rejects.toThrow(IpcInputError)
    }

    const install = handlerOf(IPC_CHANNELS.plugins.install)
    for (const args of [
      [],
      [{}],
      [{ marketplaceId: 'demo' }],
      [{ name: 'p1' }],
      [{ marketplaceId: 'demo', name: 'p1', extra: 1 }],
      ['demo', 'p1']
    ]) {
      await expect(install(EVENT, ...args), JSON.stringify(args)).rejects.toThrow(IpcInputError)
    }

    // uninstall 是同步 handler
    expect(() => handlerOf(IPC_CHANNELS.plugins.uninstall)(EVENT, '')).toThrow(IpcInputError)

    // overview 是同步 handler
    expect(() => handlerOf(IPC_CHANNELS.plugins.overview)(EVENT, 'x')).toThrow(IpcInputError)

    expect(existsSync(settingsPath(dir))).toBe(false)
  })
})

describe('plugins:overview / add-marketplace', () => {
  it('空总览：三个数组都是空的', () => {
    expect(handlerOf(IPC_CHANNELS.plugins.overview)(EVENT)).toEqual({
      marketplaces: [],
      installed: [],
      installedSkills: []
    })
  })

  it('添加本机市场：清单先校验后落盘，总览带上插件与组件摘要', async () => {
    const market = makeMarket(dir)

    const next = (await handlerOf(IPC_CHANNELS.plugins.addMarketplace)(EVENT, {
      source: market
    })) as PluginsOverview

    expect(next.marketplaces).toHaveLength(1)
    expect(next.marketplaces[0]).toMatchObject({
      id: 'market',
      name: 'demo-market',
      kind: 'local',
      path: market
    })
    expect(next.marketplaces[0].plugins).toEqual([
      expect.objectContaining({
        name: 'p-relative',
        skills: ['demo'],
        mcpServers: ['web'],
        supported: true
      }),
      expect.objectContaining({ name: 'p-npm', supported: false })
    ])
    expect(settings().pluginMarketplaces).toHaveLength(1)
  })

  it('坏来源：抛人话错误且不落盘', async () => {
    await expect(
      handlerOf(IPC_CHANNELS.plugins.addMarketplace)(EVENT, { source: 'not-a-repo' })
    ).rejects.toThrow(/来源认不出/)
    expect(existsSync(settingsPath(dir))).toBe(false)
  })

  it('刷新不在列表里的市场：抛错', async () => {
    await expect(
      handlerOf(IPC_CHANNELS.plugins.refreshMarketplace)(EVENT, '不存在')
    ).rejects.toThrow(/不在列表里/)
  })
})

describe('plugins:install / uninstall', () => {
  async function addAndInstall(): Promise<PluginsOverview> {
    const market = makeMarket(dir)
    await handlerOf(IPC_CHANNELS.plugins.addMarketplace)(EVENT, { source: market })
    return (await handlerOf(IPC_CHANNELS.plugins.install)(EVENT, {
      marketplaceId: 'market',
      name: 'p-relative'
    })) as PluginsOverview
  }

  it('安装：记录 + MCP 条目（停用）落盘；技能复制进 userData/skills 并在总览里去掉插件前缀', async () => {
    const next = await addAndInstall()

    expect(next.installed).toEqual([
      expect.objectContaining({
        id: 'market-p-relative',
        marketplaceId: 'market',
        name: 'p-relative',
        skillDirs: ['market-p-relative-demo'],
        installDir: null
      })
    ])
    expect(next.installed[0].mcpServerIds).toEqual(['plugin-market-p-relative-web'])

    const stored = settings()
    expect(stored.mcpServers).toEqual([
      expect.objectContaining({
        id: 'plugin-market-p-relative-web',
        transport: 'http',
        url: 'https://api.example.com/mcp',
        enabled: false
      })
    ])
    expect(stored.installedPlugins).toHaveLength(1)

    expect(existsSync(join(dir, 'skills', 'market-p-relative-demo', 'SKILL.md'))).toBe(true)
    expect(next.installedSkills).toEqual([
      {
        dir: 'market-p-relative-demo',
        name: 'demo',
        pluginId: 'market-p-relative',
        pluginName: 'p-relative',
        source: 'plugin'
      }
    ])
  })

  it('重复安装 / 市场或插件名不存在：抛错', async () => {
    await addAndInstall()

    await expect(
      handlerOf(IPC_CHANNELS.plugins.install)(EVENT, {
        marketplaceId: 'market',
        name: 'p-relative'
      })
    ).rejects.toThrow(/已经安装过了/)
    await expect(
      handlerOf(IPC_CHANNELS.plugins.install)(EVENT, { marketplaceId: '不存在', name: 'p1' })
    ).rejects.toThrow(/不在列表里/)
    await expect(
      handlerOf(IPC_CHANNELS.plugins.install)(EVENT, { marketplaceId: 'market', name: '没有这个' })
    ).rejects.toThrow(/没有这个插件/)
  })

  it('卸载：记录与它带来的 MCP 条目、技能一起清掉', async () => {
    await addAndInstall()

    const next = (await handlerOf(IPC_CHANNELS.plugins.uninstall)(
      EVENT,
      'market-p-relative'
    )) as PluginsOverview

    expect(next.installed).toEqual([])
    expect(next.installedSkills).toEqual([])
    expect(settings().mcpServers).toEqual([])
    expect(settings().installedPlugins).toEqual([])
    expect(existsSync(join(dir, 'skills', 'market-p-relative-demo'))).toBe(false)

    expect(() => handlerOf(IPC_CHANNELS.plugins.uninstall)(EVENT, 'market-p-relative')).toThrow(
      /不在已安装列表里/
    )
  })
})

describe('plugins:remove-marketplace', () => {
  it('移除市场：连带卸载名下插件（MCP、技能、记录全清）；local 目录不删', async () => {
    const market = makeMarket(dir)
    await handlerOf(IPC_CHANNELS.plugins.addMarketplace)(EVENT, { source: market })
    await handlerOf(IPC_CHANNELS.plugins.install)(EVENT, {
      marketplaceId: 'market',
      name: 'p-relative'
    })

    const next = (await handlerOf(IPC_CHANNELS.plugins.removeMarketplace)(
      EVENT,
      'market'
    )) as PluginsOverview

    expect(next.marketplaces).toEqual([])
    expect(next.installed).toEqual([])
    expect(next.installedSkills).toEqual([])
    expect(settings().pluginMarketplaces).toEqual([])
    expect(settings().installedPlugins).toEqual([])
    expect(settings().mcpServers).toEqual([])
    expect(existsSync(join(dir, 'skills', 'market-p-relative-demo'))).toBe(false)
    // 本机目录是用户的，不动
    expect(existsSync(market)).toBe(true)
  })
})

describe('round 25 · 卸载彻底删净（installDir / 技能 / git 克隆）', () => {
  /** 伪造一条"从 git 装的插件"记录：克隆目录与技能目录都在盘上 */
  function forgeGitInstalled(): { installDir: string; skillDir: string; marketClone: string } {
    const installDir = join(dir, 'plugins', 'installed', 'gitmarket-p1')
    writeFile(join(installDir, '.claude-plugin', 'plugin.json'), '{}')
    const skillDir = join(dir, 'skills', 'gitmarket-p1-s1')
    writeFile(join(skillDir, 'SKILL.md'), '# s1\n')
    const marketClone = join(dir, 'plugins', 'marketplaces', 'gitmarket')
    writeJson(join(marketClone, '.claude-plugin', 'marketplace.json'), {
      name: 'git 市场',
      plugins: []
    })
    updateSettings(settingsPath(dir), {
      pluginMarketplaces: [
        {
          id: 'gitmarket',
          name: 'git 市场',
          source: 'https://github.com/a/b.git',
          kind: 'git',
          path: marketClone,
          addedAt: '2026-10-11T00:00:00.000Z'
        }
      ],
      installedPlugins: [
        {
          id: 'gitmarket-p1',
          marketplaceId: 'gitmarket',
          name: 'p1',
          installedAt: '2026-10-11T00:00:00.000Z',
          mcpServerIds: [],
          skillDirs: ['gitmarket-p1-s1'],
          installDir
        }
      ]
    })
    return { installDir, skillDir, marketClone }
  }

  it('卸载：插件克隆目录（installDir）与技能目录都从盘上删掉；市场本身不动', async () => {
    const { installDir, skillDir, marketClone } = forgeGitInstalled()

    const next = (await handlerOf(IPC_CHANNELS.plugins.uninstall)(
      EVENT,
      'gitmarket-p1'
    )) as PluginsOverview

    expect(next.installed).toEqual([])
    expect(existsSync(installDir)).toBe(false)
    expect(existsSync(skillDir)).toBe(false)
    expect(settings().installedPlugins).toEqual([])
    // 卸载插件 ≠ 移除市场：克隆目录还在（要连市场一起删走下一组用例）
    expect(existsSync(marketClone)).toBe(true)
  })

  it('移除 git 市场：克隆目录删净；local 市场（用户自己的目录）原样保留', async () => {
    const { marketClone } = forgeGitInstalled()
    const localMarket = makeMarket(dir)
    const current = settings()
    updateSettings(settingsPath(dir), {
      pluginMarketplaces: [
        ...current.pluginMarketplaces,
        {
          id: 'market',
          name: 'demo-market',
          source: localMarket,
          kind: 'local',
          path: localMarket,
          addedAt: '2026-10-11T00:00:00.000Z'
        }
      ]
    })

    const next = (await handlerOf(IPC_CHANNELS.plugins.removeMarketplace)(
      EVENT,
      'gitmarket'
    )) as PluginsOverview

    expect(next.marketplaces.map((marketplace) => marketplace.id)).toEqual(['market'])
    expect(existsSync(marketClone)).toBe(false)
    expect(existsSync(localMarket)).toBe(true)
    expect(settings().pluginMarketplaces.map((marketplace) => marketplace.id)).toEqual(['market'])
  })
})

describe('round 64 · 内置技能进总览（插件页「技能」面板 / composer 的引用菜单）', () => {
  /** 另起一份用户数据目录 + 一个内置技能目录，重新注册通道（handlers 表被覆盖，只留一份） */
  function registerWithBuiltin(builtinDir: string): void {
    mocks.handlers.clear()
    registerPluginIpc(dir, { builtinSkillsDir: builtinDir })
  }

  it('内置技能列出（带 source 标记）；插件技能与内置技能共处一张表且内置在前', async () => {
    const builtinDir = join(dir, 'builtin-skills')
    writeFile(join(builtinDir, 'pptx', 'SKILL.md'), '---\nname: pptx\ndescription: 演示\n---\n')
    writeFile(join(builtinDir, 'xlsx', 'SKILL.md'), '---\nname: xlsx\n---\n')
    registerWithBuiltin(builtinDir)

    const empty = (await handlerOf(IPC_CHANNELS.plugins.overview)(EVENT)) as PluginsOverview
    expect(empty.installedSkills).toEqual([
      { dir: 'pptx', name: 'pptx', pluginId: null, pluginName: null, source: 'builtin' },
      { dir: 'xlsx', name: 'xlsx', pluginId: null, pluginName: null, source: 'builtin' }
    ])

    // 再装一个插件：插件技能排在内置之后，且形状是老样子（不带 source）
    const market = makeMarket(dir)
    await handlerOf(IPC_CHANNELS.plugins.addMarketplace)(EVENT, { source: market })
    const next = (await handlerOf(IPC_CHANNELS.plugins.install)(EVENT, {
      marketplaceId: 'market',
      name: 'p-relative'
    })) as PluginsOverview

    expect(next.installedSkills).toEqual([
      { dir: 'pptx', name: 'pptx', pluginId: null, pluginName: null, source: 'builtin' },
      { dir: 'xlsx', name: 'xlsx', pluginId: null, pluginName: null, source: 'builtin' },
      {
        dir: 'market-p-relative-demo',
        name: 'demo',
        pluginId: 'market-p-relative',
        pluginName: 'p-relative',
        source: 'plugin'
      }
    ])
  })

  it('没有内置目录（老调用方 / 单测形状）：总览与 round 10 一致，只有插件技能', () => {
    mocks.handlers.clear()
    registerPluginIpc(dir)

    const overview = handlerOf(IPC_CHANNELS.plugins.overview)(EVENT) as PluginsOverview
    expect(overview.installedSkills).toEqual([])
  })
})

describe('plugins:icon（round 23：插件图标）', () => {
  it('没有图标资源 → { dataUrl: null }；入参先过闸门', async () => {
    const market = makeMarket(dir)
    await handlerOf(IPC_CHANNELS.plugins.addMarketplace)(EVENT, { source: market })

    expect(await handlerOf(IPC_CHANNELS.plugins.icon)(EVENT, 'market', 'p-relative')).toEqual({
      dataUrl: null
    })

    for (const args of [[], ['market'], [1, 'p'], ['market', '']]) {
      expect(() => handlerOf(IPC_CHANNELS.plugins.icon)(EVENT, ...args)).toThrow(IpcInputError)
    }
  })

  it('有图标资源 → data URL（相对来源自带的文件）', async () => {
    const market = makeMarket(dir)
    writeFile(join(market, 'plugins', 'p-relative', '.claude-plugin', 'icon.png'), 'png-bytes')
    await handlerOf(IPC_CHANNELS.plugins.addMarketplace)(EVENT, { source: market })

    const result = (await handlerOf(IPC_CHANNELS.plugins.icon)(EVENT, 'market', 'p-relative')) as {
      dataUrl: string | null
    }
    expect(result.dataUrl).toMatch(/^data:image\/png;base64,/)

    // 总览里该插件 icon=true（渲染端据此才知道要取）
    const overview = (await handlerOf(IPC_CHANNELS.plugins.overview)(EVENT)) as PluginsOverview
    expect(overview.marketplaces[0]?.plugins[0]).toMatchObject({ name: 'p-relative', icon: true })
  })

  it('市场不在列表 / 插件不存在：都回 null（不抛，界面回字母头像）', async () => {
    expect(await handlerOf(IPC_CHANNELS.plugins.icon)(EVENT, 'nope', 'p')).toEqual({
      dataUrl: null
    })

    const market = makeMarket(dir)
    await handlerOf(IPC_CHANNELS.plugins.addMarketplace)(EVENT, { source: market })
    expect(await handlerOf(IPC_CHANNELS.plugins.icon)(EVENT, 'market', '不存在')).toEqual({
      dataUrl: null
    })
  })
})

/**
 * round 94（用户反馈 004）：**单独注册一个技能**的两条通道。
 * 重点：① 入参先过闸门；② 本地文件/文件夹走原生选择器（渲染端递不了路径），
 * 取消 = `added: null` 什么都不落盘；③ URL 导入跑真后端（本机 HTTP 服务 + 真 fetch +
 * 真逐跳出站校验），白名单**现读** `settings.network.allowLocalHosts`；
 * ④ 导入后的技能进总览的「我的技能」一组（source: 'user'），并能在 agents 侧被扫到（同一目录）。
 */
describe('plugins:add-skill-url / import-skill-local（round 94）', () => {
  /** 一个本机 HTTP 服务（回固定内容）；回它的地址与白名单条目 */
  async function serve(body: Buffer | string, type = 'text/markdown'): Promise<string> {
    const started = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': type })
      response.end(body)
    })
    await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve))
    servers.push(started)
    const address = started.address()
    if (address === null || typeof address === 'string') throw new Error('服务没起来')
    return `http://127.0.0.1:${address.port}/demo/SKILL.md`
  }

  const servers: Server[] = []

  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  it('入参先过闸门（非法调用不碰磁盘、不弹选择器）', async () => {
    const url = handlerOf(IPC_CHANNELS.plugins.addSkillUrl)
    const local = handlerOf(IPC_CHANNELS.plugins.importSkillLocal)
    for (const args of [[], [{}], [{ url: '' }], [{ url: 1 }], ['https://x/y', 1]]) {
      await expect(url(EVENT, ...args), JSON.stringify(args)).rejects.toThrow(IpcInputError)
    }
    for (const args of [[], ['path'], ['md'], [1], ['file', 'x']]) {
      await expect(local(EVENT, ...args), JSON.stringify(args)).rejects.toThrow(IpcInputError)
    }
    expect(mocks.dialog).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'skills'))).toBe(false)
  })

  it('本地文件导入：走原生选择器 + 真读真写，落进「我的技能」（source: user）', async () => {
    const file = join(dir, 'invoice-helper.md')
    writeFileSync(file, '---\nname: invoice-helper\ndescription: 开发票\n---\n正文\n', 'utf8')
    mocks.dialog.mockResolvedValue({ canceled: false, filePaths: [file] })

    const result = (await handlerOf(IPC_CHANNELS.plugins.importSkillLocal)(EVENT, 'file')) as {
      overview: PluginsOverview
      added: { name: string; dir: string } | null
    }

    expect(mocks.dialog).toHaveBeenCalledWith(expect.objectContaining({ properties: ['openFile'] }))
    expect(result.added).toEqual({ name: 'invoice-helper', dir: 'invoice-helper' })
    expect(existsSync(join(dir, 'skills', 'invoice-helper', 'SKILL.md'))).toBe(true)
    expect(result.overview.installedSkills).toEqual([
      {
        dir: 'invoice-helper',
        name: 'invoice-helper',
        pluginId: null,
        pluginName: null,
        source: 'user'
      }
    ])
  })

  it('本地文件夹导入：取消（原生选择器回 canceled）= added null，什么都不落盘', async () => {
    mocks.dialog.mockResolvedValue({ canceled: true, filePaths: [] })

    const result = (await handlerOf(IPC_CHANNELS.plugins.importSkillLocal)(EVENT, 'folder')) as {
      overview: PluginsOverview
      added: unknown
    }

    expect(mocks.dialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openDirectory'] })
    )
    expect(result.added).toBeNull()
    expect(result.overview.installedSkills).toEqual([])
    expect(existsSync(join(dir, 'skills'))).toBe(false)
  })

  it('目录里没有 SKILL.md：抛人话（界面行内显示），仍不落盘', async () => {
    const empty = join(dir, 'empty-dir')
    mkdirSync(empty, { recursive: true })
    mocks.dialog.mockResolvedValue({ canceled: false, filePaths: [empty] })
    await expect(handlerOf(IPC_CHANNELS.plugins.importSkillLocal)(EVENT, 'folder')).rejects.toThrow(
      /SKILL\.md/
    )
    expect(existsSync(join(dir, 'skills'))).toBe(false)
  })

  it('URL 导入：环回默认拒（结构化 blocked，含精确 host:port 与人话），白名单现读放行', async () => {
    const href = await serve('---\nname: from-url\ndescription: 来自网址\n---\n')

    // 本机/内网这一档**不抛**：回结构化的"要你确认"（界面据此给"允许访问 <host:port>"按钮），
    // 且一个字节都没落盘
    const blocked = (await handlerOf(IPC_CHANNELS.plugins.addSkillUrl)(EVENT, { url: href })) as {
      overview: PluginsOverview
      added: unknown
      blocked: { host: string; url: string; message: string } | null
    }
    const host = new URL(href).host
    expect(blocked.added).toBeNull()
    expect(blocked.blocked?.host).toBe(host)
    expect(blocked.blocked?.message).toContain('本机（环回）地址')
    expect(blocked.blocked?.message).toContain('允许这台主机')
    expect(existsSync(join(dir, 'skills'))).toBe(false)

    // 白名单现读：改完设置（这里直接写落盘文件，等于用户点了"允许"）再点一次就通了
    writeJson(settingsPath(dir), { ...settings(), network: { allowLocalHosts: [host] } })

    const result = (await handlerOf(IPC_CHANNELS.plugins.addSkillUrl)(EVENT, { url: href })) as {
      overview: PluginsOverview
      added: { name: string; dir: string } | null
      blocked: unknown
    }
    expect(result.blocked).toBeNull()
    expect(result.added).toEqual({ name: 'from-url', dir: 'from-url' })
    expect(readFileSync(join(dir, 'skills', 'from-url', 'SKILL.md'), 'utf8')).toContain('来自网址')
    expect(result.overview.installedSkills).toEqual([
      {
        dir: 'from-url',
        name: 'from-url',
        pluginId: null,
        pluginName: null,
        source: 'user'
      }
    ])
  })
})
