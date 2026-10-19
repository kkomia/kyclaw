// @vitest-environment node
/**
 * PB-023：settings.mcpServers → DSH home patch（`$DSH_HOME/cordis.patch.yml`）。
 *
 * 钉死：
 *   1. 模板形状（`- insert:` + `@deepseek-ai/dsh-mcp-client` + serverName=id + failOnStartupError: true）；
 *   2. stdio / streamable-http 字段映射；
 *   3. **只出 enabled 且合法的**：非法 id（超出 DSH serverName 字符集/长度）、半截配置一律跳过并说明；
 *   4. **YAML 注入防护**：值全部双引号标量，引号/冒号/`#`/换行等按原文回读（换行在设置校验层就拒）；
 *   5. 幂等 + 无启用项时写空列表清旧条目 + 原子替换（不留 .tmp）。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { McpServerConfig } from '../../../shared/settings'
import { MCP_HOME_PATCH_FILENAME, ensureMcpHomePatch, renderMcpPatch } from '../mcp-profile'

const created: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kyclaw-mcp-profile-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

function server(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'search',
    name: '搜索',
    transport: 'stdio',
    command: 'node',
    args: ['server.mjs'],
    env: {},
    enabled: true,
    readOnlyTools: [],
    ...overrides
  }
}

interface PatchEntry {
  insert?: {
    id: string
    name: string
    config: Record<string, unknown>
  }[]
}

function parsePatch(text: string): PatchEntry[] {
  return parseYaml(text) as PatchEntry[]
}

describe('renderMcpPatch：模板形状与字段映射', () => {
  it('stdio：insert 一项；id=mcp-<serverId>；serverName=id；command/args/env 原样', () => {
    const { yaml, included, skipped } = renderMcpPatch([
      server({ env: { TOKEN: 'abc' }, args: ['--serve', 'x y'] })
    ])
    expect(included).toEqual(['search'])
    expect(skipped).toEqual([])
    const entries = parsePatch(yaml)
    expect(entries).toHaveLength(1)
    const item = entries[0]?.insert?.[0]
    expect(item?.id).toBe('mcp-search')
    expect(item?.name).toBe('@deepseek-ai/dsh-mcp-client')
    expect(item?.config).toMatchObject({
      serverName: 'search',
      transport: 'stdio',
      command: 'node',
      args: ['--serve', 'x y'],
      env: { TOKEN: 'abc' },
      failOnStartupError: true
    })
  })

  it('streamable-http：url + headers', () => {
    const { yaml } = renderMcpPatch([
      server({
        id: 'docs',
        transport: 'http',
        command: undefined,
        args: undefined,
        url: 'http://127.0.0.1:3000/mcp',
        headers: { Authorization: 'Bearer t' }
      })
    ])
    const item = parsePatch(yaml)[0]?.insert?.[0]
    expect(item?.config).toMatchObject({
      serverName: 'docs',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:3000/mcp',
      headers: { Authorization: 'Bearer t' },
      failOnStartupError: true
    })
    expect(item?.config.transport).not.toBe('stdio')
  })

  it('多个启用项 = 一个 insert 列表里的多项（顺序按 settings 顺序）', () => {
    const { yaml, included } = renderMcpPatch([
      server({ id: 'a' }),
      server({ id: 'b', transport: 'http', url: 'https://example.com/mcp' })
    ])
    expect(included).toEqual(['a', 'b'])
    const item = parsePatch(yaml)[0]
    expect(item?.insert?.map((entry) => entry.config.serverName)).toEqual(['a', 'b'])
  })
})

describe('renderMcpPatch：只出 enabled 且合法的（坏名字不许写进内核 patch）', () => {
  it('停用项不出现，也不报 skipped', () => {
    const { yaml, included, skipped } = renderMcpPatch([server({ enabled: false })])
    expect(included).toEqual([])
    expect(skipped).toEqual([])
    expect(parsePatch(yaml)).toEqual([])
    expect(yaml).toContain('[]')
  })

  it('非法 id（大写/空格/超长）→ 跳过并给出原因，不写 patch', () => {
    for (const id of ['Bad', 'has space', 'a'.repeat(33), 'x__y', '']) {
      const { yaml, included, skipped } = renderMcpPatch([server({ id })])
      expect(included).toEqual([])
      expect(parsePatch(yaml)).toEqual([])
      expect(skipped).toHaveLength(1)
      expect(skipped[0]?.reason).toContain('标识')
    }
  })

  it('启用但缺 command（旧 settings.json 手改）→ 跳过并说明；不把半截配置写进 patch', () => {
    const { yaml, skipped } = renderMcpPatch([server({ command: '' })])
    expect(parsePatch(yaml)).toEqual([])
    expect(skipped[0]?.reason).toContain('启动命令')
  })

  it('重复 id：只启用第一条，并报重复', () => {
    const { included, skipped } = renderMcpPatch([
      server({ id: 'dup', command: 'a' }),
      server({ id: 'dup', command: 'b' })
    ])
    expect(included).toEqual(['dup'])
    expect(skipped).toEqual([{ id: 'dup', reason: '标识重复：只启用第一条' }])
  })
})

describe('renderMcpPatch：YAML 注入防护（用户输入原样回读，不撑坏结构）', () => {
  it('引号 / 冒号 / # / 反斜杠 / Unicode 都按原文回读', () => {
    const tricky = 'a"b: c # not-comment \\ back "quoted" 中文'
    const { yaml } = renderMcpPatch([
      server({ command: tricky, args: [tricky], env: { 'KEY:WEIRD': tricky } })
    ])
    const item = parsePatch(yaml)[0]?.insert?.[0]
    expect(item?.config.command).toBe(tricky)
    expect(item?.config.args).toEqual([tricky])
    expect(item?.config.env).toEqual({ 'KEY:WEIRD': tricky })
  })

  it('换行（设置校验层已拒，仍保证不会写出多行 YAML）→ 该 server 被跳过', () => {
    const { yaml, skipped } = renderMcpPatch([server({ env: { A: 'line1\nline2' } })])
    expect(parsePatch(yaml)).toEqual([])
    expect(skipped[0]?.reason).toContain('换行')
  })

  it('header 值里的 CRLF（头注入形状）同样被跳过', () => {
    const { skipped } = renderMcpPatch([
      server({
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { 'X-Test': 'a\r\nInjected: 1' }
      })
    ])
    expect(skipped[0]?.reason).toContain('换行')
  })
})

describe('ensureMcpHomePatch：落盘、幂等、清旧条目、原子替换', () => {
  it('写到 $DSH_HOME/cordis.patch.yml；目录不存在会建', () => {
    const dshHome = join(tempDir(), 'dsh-home')
    const result = ensureMcpHomePatch(dshHome, [server()])
    expect(result.file).toBe(join(dshHome, MCP_HOME_PATCH_FILENAME))
    expect(existsSync(result.file)).toBe(true)
    expect(result.changed).toBe(true)
    expect(parsePatch(readFileSync(result.file, 'utf8'))[0]?.insert?.[0]?.config.serverName).toBe(
      'search'
    )
  })

  it('同样的 settings 第二次调用 changed=false（不反复改 mtime）', () => {
    const dshHome = tempDir()
    ensureMcpHomePatch(dshHome, [server()])
    expect(ensureMcpHomePatch(dshHome, [server()]).changed).toBe(false)
  })

  it('从有启用项改成空列表 → 重写成 []（清掉旧 MCP 条目）', () => {
    const dshHome = tempDir()
    ensureMcpHomePatch(dshHome, [server()])
    const cleared = ensureMcpHomePatch(dshHome, [])
    expect(cleared.changed).toBe(true)
    expect(parsePatch(readFileSync(cleared.file, 'utf8'))).toEqual([])
  })

  it('原子替换后不留 .tmp-* 文件', () => {
    const dshHome = tempDir()
    ensureMcpHomePatch(dshHome, [server()])
    ensureMcpHomePatch(dshHome, [server({ id: 'other' })])
    expect(readdirSync(dshHome).filter((name) => name.includes('.tmp-'))).toEqual([])
  })

  it('文件头带生成声明（手改会被覆盖）', () => {
    const dshHome = tempDir()
    const { file } = ensureMcpHomePatch(dshHome, [])
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('由 kyclaw')
    expect(text).toContain('手改会被覆盖')
  })

  it('旧文件里的手写内容会被整体重写（home patch 归产品所有）', () => {
    const dshHome = tempDir()
    const file = join(dshHome, MCP_HOME_PATCH_FILENAME)
    writeFileSync(file, '- id: hand-written\n  config:\n    x: 1\n', 'utf8')
    const result = ensureMcpHomePatch(dshHome, [])
    expect(result.changed).toBe(true)
    expect(readFileSync(file, 'utf8')).not.toContain('hand-written')
  })
})
