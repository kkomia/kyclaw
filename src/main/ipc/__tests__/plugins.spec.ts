import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  return { handlers: new Map<string, Handler>() }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler)
    }
  }
}))

import { IPC_CHANNELS, IpcInputError } from '../../../shared/ipc'
import type { PluginsOverview } from '../../../shared/plugins'
import { readSettings, settingsPath } from '../../settings'
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
  it('七条通道都注册了', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      'plugins:add-marketplace',
      'plugins:icon',
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
        pluginName: 'p-relative'
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
