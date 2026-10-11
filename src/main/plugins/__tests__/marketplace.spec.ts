// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveWithin } from '../../../shared/plugins'
import {
  addMarketplace,
  collectPluginServerMaps,
  readMarketplaceManifest,
  readMarketplacePlugins,
  refreshMarketplace,
  removeMarketplaceFiles,
  runGit,
  scanPluginDir
} from '../marketplace'
import { installPlugin, uninstallPluginFiles } from '../installer'
import { pluginsDirs, type PluginsDirs } from '../store'

/**
 * 插件市场的主进程面（round 10）：本地目录 / git 克隆（file:// 造本地仓库）两条添加路径、
 * 清单校验的人话错误、组件扫描、安装（MCP 映射 + 技能复制）与卸载。
 * 全部在临时目录里做真文件；git 相关用例在没装 git 的机器上跳过。
 */

const NOW = '2026-10-11T00:00:00.000Z'

const gitAvailable = ((): boolean => {
  const probe = spawnSync('git', ['--version'], { shell: false })
  return probe.error === undefined && probe.status === 0
})()

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kyclaw-plugins-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

function writeJson(path: string, data: unknown): void {
  writeFile(path, JSON.stringify(data, null, 2))
}

interface Fixture {
  market: string
  dirs: PluginsDirs
}

/** 一个本机市场：p-relative（.mcp.json + plugin.json 内联 mcpServers + 一个技能）与 p-npm（不支持） */
function makeFixture(base: string): Fixture {
  const market = join(base, 'market')
  writeJson(join(market, '.claude-plugin', 'marketplace.json'), {
    name: 'demo-market',
    owner: { name: 'tester' },
    plugins: [
      {
        name: 'p-relative',
        description: '本地插件',
        version: '1.0.0',
        source: './plugins/p-relative'
      },
      { name: 'p-npm', source: { source: 'npm', package: '@scope/x' } }
    ]
  })

  const plugin = join(market, 'plugins', 'p-relative')
  writeJson(join(plugin, '.mcp.json'), {
    mcpServers: {
      web: { type: 'http', url: 'https://api.example.com/mcp' },
      local: { type: 'stdio', command: '${CLAUDE_PLUGIN_ROOT}/server.mjs', args: ['--stdio'] }
    }
  })
  writeJson(join(plugin, '.claude-plugin', 'plugin.json'), {
    name: 'p-relative',
    version: '2.3.4',
    mcpServers: {
      inline: { type: 'stdio', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/inline.mjs'] }
    }
  })
  writeFile(join(plugin, 'server.mjs'), '// demo\n')
  writeFile(join(plugin, 'skills', 'demo', 'SKILL.md'), '# demo\n')
  writeFile(join(plugin, 'skills', 'broken', 'README.md'), '没有 SKILL.md，不算技能\n')

  return { market, dirs: pluginsDirs(join(base, 'userdata')) }
}

describe('addMarketplace · 本地目录', () => {
  it('kind=local、名字取清单、路径是原目录；id 由目录名 slug 而来', async () => {
    const { market, dirs } = makeFixture(root)

    const record = await addMarketplace({
      input: { source: market },
      dirs,
      existing: [],
      addedAt: NOW
    })

    expect(record).toMatchObject({
      id: 'market',
      name: 'demo-market',
      source: market,
      kind: 'local',
      path: resolve(market),
      addedAt: NOW
    })
    expect(record.ref).toBeUndefined()
    expect(record.sparsePaths).toBeUndefined()
    expect(existsSync(join(dirs.marketplaces, 'market'))).toBe(false)
  })

  it('认不出的来源：人话错误（空 / 莫名字符串）', async () => {
    const { dirs } = makeFixture(root)
    await expect(
      addMarketplace({ input: { source: '  ' }, dirs, existing: [], addedAt: NOW })
    ).rejects.toThrow(/填一个来源/)
    await expect(
      addMarketplace({ input: { source: 'not-a-repo' }, dirs, existing: [], addedAt: NOW })
    ).rejects.toThrow(/来源认不出/)
  })
})

describe('readMarketplaceManifest · 人话错误', () => {
  it('缺清单 / 坏 JSON / 缺字段 / 相对 source 逃逸', () => {
    const empty = join(root, 'empty')
    mkdirSync(empty, { recursive: true })
    expect(() => readMarketplaceManifest(empty)).toThrow(/不是插件市场/)

    const bad = join(root, 'bad')
    writeFile(join(bad, '.claude-plugin', 'marketplace.json'), '{不是 json')
    expect(() => readMarketplaceManifest(bad)).toThrow(/不是合法的 JSON/)

    const missing = join(root, 'missing')
    writeJson(join(missing, '.claude-plugin', 'marketplace.json'), { plugins: [] })
    expect(() => readMarketplaceManifest(missing)).toThrow(/少了必填字段/)

    const escape = join(root, 'escape')
    writeJson(join(escape, '.claude-plugin', 'marketplace.json'), {
      name: 'e',
      plugins: [{ name: 'x', source: '../outside' }]
    })
    expect(() => readMarketplaceManifest(escape)).toThrow(/逃出了市场目录/)
  })
})

describe('readMarketplacePlugins · 组件扫描', () => {
  it('相对来源扫到技能与 MCP 键；npm 来源只报名字且 supported=false', async () => {
    const { market, dirs } = makeFixture(root)
    const record = await addMarketplace({
      input: { source: market },
      dirs,
      existing: [],
      addedAt: NOW
    })

    const view = readMarketplacePlugins(record)

    expect(view.error).toBeUndefined()
    expect(view.plugins).toHaveLength(2)
    expect(view.plugins[0]).toMatchObject({
      name: 'p-relative',
      description: '本地插件',
      version: '1.0.0',
      skills: ['demo'],
      mcpServers: ['web', 'local', 'inline'],
      supported: true
    })
    expect(view.plugins[0].source).toEqual({ kind: 'relative', path: './plugins/p-relative' })
    expect(view.plugins[1]).toMatchObject({
      name: 'p-npm',
      skills: [],
      mcpServers: [],
      supported: false
    })
    expect(view.plugins[1].source).toEqual({ kind: 'unsupported', label: 'npm' })
  })

  it('scanPluginDir：没有 SKILL.md 的目录不算技能；目录不存在 → 空表', () => {
    const { market } = makeFixture(root)
    expect(scanPluginDir(join(market, 'plugins', 'p-relative'))).toEqual({
      skills: ['demo'],
      mcpServers: ['web', 'local', 'inline']
    })
    expect(scanPluginDir(join(root, 'nope'))).toEqual({ skills: [], mcpServers: [] })
  })

  it('plugin.json 的 mcpServers：字符串路径 / 数组 / 内联对象都能收（后到者覆盖）', () => {
    const dir = join(root, 'plugin-forms')
    writeJson(join(dir, '.claude-plugin', 'plugin.json'), {
      mcpServers: ['./a.json', './b.json', { direct: { command: 'node', args: ['d'] } }]
    })
    writeJson(join(dir, 'a.json'), { mcpServers: { s1: { command: 'a1' } } })
    writeJson(join(dir, 'b.json'), { mcpServers: { s1: { command: 'b1' }, s2: { command: 'b2' } } })

    const merged = collectPluginServerMaps(dir)

    expect(Object.keys(merged)).toEqual(['s1', 's2', 'direct'])
    expect(merged.s1).toEqual({ command: 'b1' })
    expect(merged.s2).toEqual({ command: 'b2' })
    expect(merged.direct).toEqual({ command: 'node', args: ['d'] })
  })
})

describe('installPlugin / uninstallPluginFiles · 相对来源', () => {
  it('MCP 映射（${CLAUDE_PLUGIN_ROOT} 已替换）+ 技能复制 + 记录字段', async () => {
    const { market, dirs } = makeFixture(root)
    const marketplace = await addMarketplace({
      input: { source: market },
      dirs,
      existing: [],
      addedAt: NOW
    })
    const { plugins } = readMarketplacePlugins(marketplace)

    const result = await installPlugin({
      marketplace,
      plugin: plugins[0],
      dirs,
      existingServers: [],
      installed: [],
      installedAt: NOW
    })

    // ${CLAUDE_PLUGIN_ROOT} 替换时会归一为正斜杠，期望值同样处理
    const pluginDir = resolveWithin(marketplace.path, './plugins/p-relative')?.replace(/\\/g, '/')
    expect(pluginDir).toBeDefined()

    const byId = new Map(result.mcpServers.map((server) => [server.id, server]))
    expect([...byId.keys()]).toEqual([
      'plugin-market-p-relative-web',
      'plugin-market-p-relative-local',
      'plugin-market-p-relative-inline'
    ])
    expect(byId.get('plugin-market-p-relative-web')).toMatchObject({
      transport: 'http',
      url: 'https://api.example.com/mcp',
      enabled: false,
      readOnlyTools: []
    })
    expect(byId.get('plugin-market-p-relative-local')).toMatchObject({
      transport: 'stdio',
      command: `${pluginDir}/server.mjs`,
      args: ['--stdio'],
      enabled: false
    })
    expect(byId.get('plugin-market-p-relative-inline')).toMatchObject({
      transport: 'stdio',
      command: 'node',
      args: [`${pluginDir}/inline.mjs`]
    })

    expect(result.record).toMatchObject({
      id: 'market-p-relative',
      marketplaceId: 'market',
      name: 'p-relative',
      version: '2.3.4',
      installedAt: NOW,
      skillDirs: ['market-p-relative-demo'],
      installDir: null
    })
    expect(result.record.mcpServerIds).toEqual([...byId.keys()])
    expect(existsSync(join(dirs.skills, 'market-p-relative-demo', 'SKILL.md'))).toBe(true)
  })

  it('卸载：技能目录清掉（相对来源没有克隆目录）', async () => {
    const { market, dirs } = makeFixture(root)
    const marketplace = await addMarketplace({
      input: { source: market },
      dirs,
      existing: [],
      addedAt: NOW
    })
    const { plugins } = readMarketplacePlugins(marketplace)
    const result = await installPlugin({
      marketplace,
      plugin: plugins[0],
      dirs,
      existingServers: [],
      installed: [],
      installedAt: NOW
    })

    const skillPath = join(dirs.skills, 'market-p-relative-demo')
    expect(existsSync(skillPath)).toBe(true)

    uninstallPluginFiles(result.record, dirs)
    expect(existsSync(skillPath)).toBe(false)
  })

  it('已安装过 / 不支持来源 / 相对路径逃逸：都是人话错误', async () => {
    const { market, dirs } = makeFixture(root)
    const marketplace = await addMarketplace({
      input: { source: market },
      dirs,
      existing: [],
      addedAt: NOW
    })
    const { plugins } = readMarketplacePlugins(marketplace)
    const first = await installPlugin({
      marketplace,
      plugin: plugins[0],
      dirs,
      existingServers: [],
      installed: [],
      installedAt: NOW
    })

    await expect(
      installPlugin({
        marketplace,
        plugin: plugins[0],
        dirs,
        existingServers: [],
        installed: [first.record],
        installedAt: NOW
      })
    ).rejects.toThrow(/已经安装过了/)

    await expect(
      installPlugin({
        marketplace,
        plugin: plugins[1],
        dirs,
        existingServers: [],
        installed: [],
        installedAt: NOW
      })
    ).rejects.toThrow(/暂不支持这种来源：npm/)

    await expect(
      installPlugin({
        marketplace,
        plugin: { name: 'evil', source: { kind: 'relative', path: '../evil' } },
        dirs,
        existingServers: [],
        installed: [],
        installedAt: NOW
      })
    ).rejects.toThrow(/逃出了市场目录/)
  })
})

describe.skipIf(!gitAvailable)('git 市场（克隆 / 刷新 / 移除）', () => {
  async function makeRepo(): Promise<string> {
    const repo = join(root, 'git-repo')
    mkdirSync(repo, { recursive: true })
    writeJson(join(repo, '.claude-plugin', 'marketplace.json'), {
      name: 'git-market',
      plugins: [{ name: 'hello', source: './plugins/hello' }]
    })
    writeFile(join(repo, 'plugins', 'hello', 'skills', 'hello', 'SKILL.md'), '# hello\n')

    const steps: Array<[string[], string]> = [
      [['init', '-q'], repo],
      [['add', '-A'], repo],
      [
        [
          '-c',
          'user.email=test@example.com',
          '-c',
          'user.name=Tester',
          '-c',
          'commit.gpgsign=false',
          'commit',
          '-q',
          '-m',
          'init'
        ],
        repo
      ]
    ]
    for (const [args, cwd] of steps) {
      const done = await runGit(args, cwd)
      expect(done.ok, `git ${args[0]}：${done.stderr}`).toBe(true)
    }
    return repo
  }

  it('file:// 仓库：克隆进 marketplaces/<id>、扫到克隆内容、pull 刷新、移除删目录、id 去重', async () => {
    const repo = await makeRepo()
    const dirs = pluginsDirs(join(root, 'userdata'))
    const fileUrl = `file:///${repo.replace(/\\/g, '/')}`

    const record = await addMarketplace({
      input: { source: fileUrl },
      dirs,
      existing: [],
      addedAt: NOW
    })

    expect(record).toMatchObject({ kind: 'git', name: 'git-market', id: 'git-repo' })
    expect(record.path).toBe(join(dirs.marketplaces, 'git-repo'))
    expect(existsSync(join(record.path, '.claude-plugin', 'marketplace.json'))).toBe(true)

    const view = readMarketplacePlugins(record)
    expect(view.plugins[0]).toMatchObject({ name: 'hello', skills: ['hello'], supported: true })

    const refreshed = await refreshMarketplace(record)
    expect(refreshed.name).toBe('git-market')
    expect(refreshed.path).toBe(record.path)

    removeMarketplaceFiles(record)
    expect(existsSync(record.path)).toBe(false)

    const second = await addMarketplace({
      input: { source: fileUrl },
      dirs,
      existing: [record],
      addedAt: NOW
    })
    expect(second.id).toBe('git-repo-2')
    expect(existsSync(join(dirs.marketplaces, 'git-repo-2'))).toBe(true)
  })

  it('列表里没有的路径 / 坏的 ref：克隆失败给人话（不落半个市场）', async () => {
    const dirs = pluginsDirs(join(root, 'userdata'))
    await expect(
      addMarketplace({
        input: { source: 'file:///definitely/not/there/repo.git' },
        dirs,
        existing: [],
        addedAt: NOW
      })
    ).rejects.toThrow(/克隆失败/)
    expect(existsSync(join(dirs.marketplaces, 'repo'))).toBe(false)
  })
})
