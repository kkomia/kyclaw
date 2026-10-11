import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  marketplaceManifestSchema,
  mergeServerMaps,
  normalizePluginSource,
  pluginMcpServersToConfigs,
  resolveWithin,
  serversFromMcpJson,
  slugify,
  substituteMcpServerRoot
} from '../plugins'

/**
 * 插件市场与插件的纯逻辑（round 10）：
 * 来源归一（relative/github/git-subdir/git/unsupported）、containment（拒 `..`/绝对路径/链接穿透）、
 * slug、`${CLAUDE_PLUGIN_ROOT}` 替换、mcpServers 合并与转 McpServerConfig、清单校验。
 */

describe('normalizePluginSource · 字符串形态', () => {
  it('相对路径三态：./ .\\ 与 / 开头都归 relative（原样保留）', () => {
    expect(normalizePluginSource('./plugins/a')).toEqual({ kind: 'relative', path: './plugins/a' })
    expect(normalizePluginSource('.\\plugins\\a')).toEqual({
      kind: 'relative',
      path: '.\\plugins\\a'
    })
    expect(normalizePluginSource('/opt/plugins/a')).toEqual({
      kind: 'relative',
      path: '/opt/plugins/a'
    })
  })

  it('owner/repo 归 github；http(s)/git@/ssh 归 git', () => {
    expect(normalizePluginSource('anthropics/claude-plugins')).toEqual({
      kind: 'github',
      repo: 'anthropics/claude-plugins'
    })
    expect(normalizePluginSource('https://github.com/a/b.git')).toEqual({
      kind: 'git',
      url: 'https://github.com/a/b.git'
    })
    expect(normalizePluginSource('git@github.com:a/b.git')).toEqual({
      kind: 'git',
      url: 'git@github.com:a/b.git'
    })
  })

  it('认不出的字符串进 unsupported（label 原样，安装时给人话）', () => {
    expect(normalizePluginSource('some-package')).toEqual({
      kind: 'unsupported',
      label: 'some-package'
    })
    // 双斜杠以上不是 owner/repo 的形状
    expect(normalizePluginSource('a/b/c')).toEqual({ kind: 'unsupported', label: 'a/b/c' })
  })
})

describe('normalizePluginSource · 对象形态（生态格式）', () => {
  it('github / git-subdir / url / git 四种对象', () => {
    expect(normalizePluginSource({ source: 'github', repo: 'a/b' })).toEqual({
      kind: 'github',
      repo: 'a/b'
    })
    expect(
      normalizePluginSource({ source: 'git-subdir', url: 'https://g.example/x.git', path: 'p/x' })
    ).toEqual({ kind: 'git-subdir', url: 'https://g.example/x.git', path: 'p/x' })
    expect(normalizePluginSource({ source: 'url', url: 'https://g.example/x.git' })).toEqual({
      kind: 'git',
      url: 'https://g.example/x.git'
    })
    expect(normalizePluginSource({ source: 'git', url: 'https://g.example/x.git' })).toEqual({
      kind: 'git',
      url: 'https://g.example/x.git'
    })
  })

  it('缺必填字段或认不出的 source：unsupported + 人话 label', () => {
    expect(normalizePluginSource({ source: 'github' })).toEqual({
      kind: 'unsupported',
      label: 'github（缺 repo）'
    })
    expect(normalizePluginSource({ source: 'git-subdir', url: 'https://g.example/x.git' })).toEqual(
      { kind: 'unsupported', label: 'git-subdir（缺 url/path）' }
    )
    expect(normalizePluginSource({ source: 'url' })).toEqual({
      kind: 'unsupported',
      label: 'url（缺 url）'
    })
    expect(normalizePluginSource({ source: 'npm', package: '@a/b' })).toEqual({
      kind: 'unsupported',
      label: 'npm'
    })
    expect(normalizePluginSource({})).toEqual({ kind: 'unsupported', label: '未知来源' })
  })
})

describe('resolveWithin · containment', () => {
  const ROOT = 'D:/data/plugins/marketplaces/m1'

  it('相对路径并进 root（正斜杠、消化 . 与空段）', () => {
    expect(resolveWithin(ROOT, './plugins/a')).toBe(`${ROOT}/plugins/a`)
    expect(resolveWithin(ROOT, 'a/./b')).toBe(`${ROOT}/a/b`)
    expect(resolveWithin(ROOT, 'a//b')).toBe(`${ROOT}/a/b`)
    expect(resolveWithin(ROOT, 'a\\b')).toBe(`${ROOT}/a/b`)
    // root 末尾的分隔符不影响结果
    expect(resolveWithin(`${ROOT}/`, 'plugins/a')).toBe(`${ROOT}/plugins/a`)
  })

  it('`..` 逃逸出头 / 绝对路径 / 空路径：null', () => {
    expect(resolveWithin(ROOT, '../x')).toBeNull()
    expect(resolveWithin(ROOT, 'a/../../x')).toBeNull()
    expect(resolveWithin(ROOT, '/abs/path')).toBeNull()
    expect(resolveWithin(ROOT, '\\abs\\path')).toBeNull()
    expect(resolveWithin(ROOT, 'C:/windows')).toBeNull()
    expect(resolveWithin(ROOT, 'C:\\windows')).toBeNull()
    expect(resolveWithin(ROOT, '')).toBeNull()
    expect(resolveWithin(ROOT, './')).toBeNull()
  })

  it('中途 `..` 只回退一层，仍在 root 内', () => {
    expect(resolveWithin(ROOT, 'a/b/../c')).toBe(`${ROOT}/a/c`)
  })
})

describe('slugify', () => {
  it('小写 + 非法字符→- + 去首尾- + 截 32', () => {
    expect(slugify('Hello World!')).toBe('hello-world')
    expect(slugify('  --Foo--  ')).toBe('foo')
    expect(slugify('a'.repeat(40))).toBe('a'.repeat(32))
  })
})

describe('substituteMcpServerRoot', () => {
  it('只动 command/args/env/url/headers 的值；键原样；反斜杠变正斜杠', () => {
    const servers = {
      web: {
        type: 'stdio',
        command: '${CLAUDE_PLUGIN_ROOT}/server.mjs',
        args: ['--root', '${CLAUDE_PLUGIN_ROOT}/data'],
        env: { ROOT: '${CLAUDE_PLUGIN_ROOT}', PLAIN: 'x' },
        cwd: '${CLAUDE_PLUGIN_ROOT}/should-stay'
      },
      api: {
        type: 'http',
        url: '${CLAUDE_PLUGIN_ROOT}/endpoint',
        headers: { 'X-Root': '${CLAUDE_PLUGIN_ROOT}' },
        note: '${CLAUDE_PLUGIN_ROOT}'
      }
    }

    const result = substituteMcpServerRoot(servers, 'C:\\Users\\me\\plugins\\demo')

    expect(result).toEqual({
      web: {
        type: 'stdio',
        command: 'C:/Users/me/plugins/demo/server.mjs',
        args: ['--root', 'C:/Users/me/plugins/demo/data'],
        env: { ROOT: 'C:/Users/me/plugins/demo', PLAIN: 'x' },
        // 不在名单里的字段原样保留（不替换）
        cwd: '${CLAUDE_PLUGIN_ROOT}/should-stay'
      },
      api: {
        type: 'http',
        url: 'C:/Users/me/plugins/demo/endpoint',
        headers: { 'X-Root': 'C:/Users/me/plugins/demo' },
        note: '${CLAUDE_PLUGIN_ROOT}'
      }
    })
  })

  it('env 的键不动（只有值被替换）', () => {
    const result = substituteMcpServerRoot(
      { s: { command: 'x', env: { '${CLAUDE_PLUGIN_ROOT}_KEY': '${CLAUDE_PLUGIN_ROOT}/v' } } },
      '/root'
    )
    expect(result).toEqual({ s: { command: 'x', env: { '${CLAUDE_PLUGIN_ROOT}_KEY': '/root/v' } } })
  })

  it('非对象条目原样带过', () => {
    expect(substituteMcpServerRoot({ weird: 'plain-string' }, '/root')).toEqual({
      weird: 'plain-string'
    })
  })
})

describe('mergeServerMaps / serversFromMcpJson', () => {
  it('多份来源合并：后到者覆盖同名条目', () => {
    expect(
      mergeServerMaps([
        { a: { x: 1 }, b: { y: 2 } },
        { b: { y: 3 }, c: { z: 4 } }
      ])
    ).toEqual({ a: { x: 1 }, b: { y: 3 }, c: { z: 4 } })
  })

  it('serversFromMcpJson：只认 {mcpServers:{…}} 形状，其余 null', () => {
    expect(serversFromMcpJson({ mcpServers: { a: { url: 'https://x/mcp' } } })).toEqual({
      a: { url: 'https://x/mcp' }
    })
    expect(serversFromMcpJson({ mcpServers: [] })).toBeNull()
    expect(serversFromMcpJson({ other: 1 })).toBeNull()
    expect(serversFromMcpJson(['a'])).toBeNull()
    expect(serversFromMcpJson(null)).toBeNull()
  })
})

describe('pluginMcpServersToConfigs', () => {
  it('id 带 plugin- 前缀；command 里 ${CLAUDE_PLUGIN_ROOT} 已替换；enabled=false', () => {
    const configs = pluginMcpServersToConfigs({
      servers: {
        'web search': {
          type: 'stdio',
          command: '${CLAUDE_PLUGIN_ROOT}/server.mjs',
          args: ['--stdio']
        }
      },
      pluginRoot: 'C:\\data\\installed\\demo-web',
      pluginSlug: 'demo-web',
      existingIds: []
    })

    expect(configs).toEqual([
      {
        id: 'plugin-demo-web-web-search',
        name: 'web search',
        transport: 'stdio',
        command: 'C:/data/installed/demo-web/server.mjs',
        args: ['--stdio'],
        enabled: false,
        readOnlyTools: []
      }
    ])
  })

  it('id 超 32 位截断；与 existingIds 撞名加 -2 后缀', () => {
    const configs = pluginMcpServersToConfigs({
      servers: { 'very long server name that exceeds the limit': { command: 'x' } },
      pluginRoot: '/root',
      pluginSlug: 'p',
      existingIds: []
    })
    expect(configs[0].id).toBe('plugin-p-very-long-server-name-t')
    expect(configs[0].id.length).toBeLessThanOrEqual(32)

    const again = pluginMcpServersToConfigs({
      servers: { 'very long server name that exceeds the limit': { command: 'x' } },
      pluginRoot: '/root',
      pluginSlug: 'p',
      existingIds: ['plugin-p-very-long-server-name-t']
    })
    expect(again[0].id).toBe('plugin-p-very-long-server-name-2')
    expect(again[0].id).toMatch(/-2$/)
  })

  it('批内 slug 化撞名（a--b 与 a-b）第二条加后缀', () => {
    const configs = pluginMcpServersToConfigs({
      servers: { 'a--b': { command: 'x' }, 'a-b': { command: 'y' } },
      pluginRoot: '/root',
      pluginSlug: 'p',
      existingIds: []
    })
    expect(configs.map((config) => config.id)).toEqual(['plugin-p-a-b', 'plugin-p-a-b-2'])
  })

  it('sse / 坏 url 沿用 round 9 的人话错误（上抛给调用方）', () => {
    expect(() =>
      pluginMcpServersToConfigs({
        servers: { s: { type: 'sse', url: 'https://x.example/mcp' } },
        pluginRoot: '/root',
        pluginSlug: 'p',
        existingIds: []
      })
    ).toThrow(/sse 暂不支持/)
    expect(() =>
      pluginMcpServersToConfigs({
        servers: { s: { type: 'http', url: 'ftp://x.example/mcp' } },
        pluginRoot: '/root',
        pluginSlug: 'p',
        existingIds: []
      })
    ).toThrow(/url 不是完整的 http/)
  })
})

describe('marketplaceManifestSchema', () => {
  it('最小合法清单（name + plugins[{name, source}]）通过；宽松忽略多余字段', () => {
    const parsed = marketplaceManifestSchema.safeParse({
      name: 'demo-market',
      version: '1.0.0',
      owner: { name: 'me', extra: true },
      plugins: [{ name: 'p', source: './plugins/p', anything: 1 }]
    })
    expect(parsed.success).toBe(true)
  })

  it('缺 name / 缺 plugins / 单条缺 source：报错', () => {
    expect(marketplaceManifestSchema.safeParse({ plugins: [] }).success).toBe(false)
    expect(marketplaceManifestSchema.safeParse({ name: 'm' }).success).toBe(false)
    expect(
      marketplaceManifestSchema.safeParse({ name: 'm', plugins: [{ name: 'p' }] }).success
    ).toBe(false)
  })
})

describe('resolveWithin · realpath 硬化（符号链接/junction 穿透）', () => {
  it('junction 指向 root 外 → 拒；指向 root 内 / 不存在的路径 → 词法放行', () => {
    const base = mkdtempSync(join(tmpdir(), 'kyclaw-resolve-'))
    try {
      const root = join(base, 'root')
      const outside = join(base, 'outside')
      mkdirSync(join(root, 'real'), { recursive: true })
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'x.txt'), 'x')
      // junction 指到 root 外（Windows 免管理员可建）
      symlinkSync(outside, join(root, 'link-out'), 'junction')

      expect(resolveWithin(root, './link-out')).toBeNull()
      expect(resolveWithin(root, './link-out/x.txt')).toBeNull()

      // 指回 root 内的 junction 只是"换了条路"，不拦
      symlinkSync(join(root, 'real'), join(root, 'link-in'), 'junction')
      expect(resolveWithin(root, './link-in/x.txt')).toBe(`${root}/link-in/x.txt`)

      // root 内的真实目录、以及尚不存在的路径（祖先在 root 内）：保持词法语义
      expect(resolveWithin(root, './real/x.txt')).toBe(`${root}/real/x.txt`)
      expect(resolveWithin(root, './real/nope/x.txt')).toBe(`${root}/real/nope/x.txt`)

      // root 不存在：纯词法（老语义）
      expect(resolveWithin(join(base, 'nope-root'), './a')).toBe(`${join(base, 'nope-root')}/a`)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
