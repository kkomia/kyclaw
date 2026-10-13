// @vitest-environment node
/**
 * 生产路径的作者运行时（round 65）：`authoringRuntimeFor` 是 `startAgentServer` 真正装进 agent 的那份。
 *
 * 这里用**真临时 dataDir + 真 updateSettings** 钉住三件事（工具层单测覆盖不到的部分）：
 *   ① 技能目录就是 `<dataDir>/skills`（与插件安装、插件页总览读的是同一个）；
 *   ② 内置技能名清单来自内置目录（同名不许占用这条判据的输入）；
 *   ③ `add_mcp_server` 真的把配置写进 `settings.json`（走 MCP 路由同一个 saveServers），
 *      写完 `readMcpServers` 立刻读得到 —— 这是"落到 settings 并生效"的判据。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSettings, settingsPath, updateSettings } from '../../settings'
import type { AuthoringRuntime } from '../../../shared/authoring'
import type { McpServerConfig } from '../../../shared/settings'
import { createAddMcpServerTool, createRemoveMcpServerTool } from '../../../mastra/tools/mcp-admin'
import { createCreateSkillTool } from '../../../mastra/tools/skill-admin'
import { callTool, createBed, type TestBed } from '../../../mastra/tools/__tests__/helpers'
import { authoringRuntimeFor } from '../service'

let dir: string
let bed: TestBed

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-authoring-'))
  bed = createBed()
})

afterEach(() => {
  bed.dispose()
  rmSync(dir, { recursive: true, force: true })
})

/** 生产里那份：读设置 / 写设置 / 对齐连接 */
function productionRuntime(options: { builtinSkillsDir?: string | null } = {}): {
  runtime: AuthoringRuntime
  readServers: () => readonly McpServerConfig[]
  aligned: () => number
} {
  const readServers = (): ReturnType<typeof readSettings>['mcpServers'] =>
    readSettings(settingsPath(dir)).mcpServers
  let aligned = 0
  const runtime = authoringRuntimeFor({
    skillsDir: join(dir, 'skills'),
    builtinSkillsDir: options.builtinSkillsDir ?? null,
    installedSkillDirs: readSettings(settingsPath(dir)).installedPlugins.flatMap(
      (record) => record.skillDirs
    ),
    readServers,
    saveServers: (servers) => updateSettings(settingsPath(dir), { mcpServers: servers }).mcpServers,
    onServersChanged: () => {
      aligned += 1
    }
  })
  return { runtime, readServers, aligned: () => aligned }
}

describe('authoringRuntimeFor：装配出的运行时', () => {
  it('技能目录 = <dataDir>/skills；内置名清单来自内置目录；插件技能目录来自安装记录', () => {
    const builtin = join(dir, 'builtin-skills')
    mkdirSync(join(builtin, 'pptx'), { recursive: true })
    writeFileSync(join(builtin, 'pptx', 'SKILL.md'), '---\nname: pptx\n---\n', 'utf8')
    mkdirSync(join(builtin, 'not-a-skill'), { recursive: true })

    const runtime = authoringRuntimeFor({
      skillsDir: join(dir, 'skills'),
      builtinSkillsDir: builtin,
      installedSkillDirs: ['market-p1-demo'],
      readServers: () => [],
      saveServers: (servers) => servers
    })

    expect(runtime.skillsDir).toBe(join(dir, 'skills'))
    expect(runtime.builtinSkillNames).toEqual(['pptx'])
    expect(runtime.pluginSkillDirs).toEqual(['market-p1-demo'])
    // 没有注入 onServersChanged 时就不带这个字段（工具里用可选链调）
    expect('onMcpServersChanged' in runtime).toBe(false)
  })
})

describe('生产路径：模型写下的东西真的落到盘上', () => {
  it('add_mcp_server → settings.json 里有这条（停用态），readMcpServers 立刻读得到，连接对齐被通知', async () => {
    const { runtime, readServers, aligned } = productionRuntime()
    const tool = await createAddMcpServerTool(bed.ctx, () => runtime)

    const out = String(
      await callTool(tool, {
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/data']
      })
    )
    expect(out).toContain('已添加 MCP 服务「filesystem」')

    // 落盘（settings.json）——与设置页/MCP 面板看到的是同一份
    expect(readSettings(settingsPath(dir)).mcpServers).toEqual([
      {
        id: 'filesystem',
        name: 'filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/data'],
        enabled: false,
        readOnlyTools: []
      }
    ])
    expect(readServers()).toHaveLength(1)
    expect(aligned()).toBe(1)
  })

  it('先加两条再移除一条：settings.json 跟着整表替换（路由与工具同一条写盘路）', async () => {
    const { runtime } = productionRuntime()
    const add = await createAddMcpServerTool(bed.ctx, () => runtime)
    const remove = await createRemoveMcpServerTool(bed.ctx, () => runtime)

    await callTool(add, { name: 'a', transport: 'http', url: 'https://a.example.com/mcp' })
    await callTool(add, { name: 'b', transport: 'http', url: 'https://b.example.com/mcp' })
    expect(readSettings(settingsPath(dir)).mcpServers.map((server) => server.id)).toEqual([
      'a',
      'b'
    ])

    await callTool(remove, { id: 'a' })
    expect(readSettings(settingsPath(dir)).mcpServers.map((server) => server.id)).toEqual(['b'])
  })

  it('create_skill → <dataDir>/skills/<名字>/SKILL.md 落盘，且内置名被拒', async () => {
    const builtin = join(dir, 'builtin-skills')
    mkdirSync(join(builtin, 'pptx'), { recursive: true })
    writeFileSync(join(builtin, 'pptx', 'SKILL.md'), '---\nname: pptx\n---\n', 'utf8')
    const { runtime } = productionRuntime({ builtinSkillsDir: builtin })
    const tool = await createCreateSkillTool(bed.ctx, () => runtime)

    const out = String(
      await callTool(tool, {
        name: 'invoice-helper',
        description: '做发票时用它',
        body: '# 发票助手\n## 什么时候用\n做发票时。'
      })
    )
    expect(out).toContain('已创建技能「invoice-helper」')

    const file = join(dir, 'skills', 'invoice-helper', 'SKILL.md')
    expect(readSettings(settingsPath(dir)).mcpServers).toEqual([])
    const written = readFileSync(file, 'utf8')
    expect(written).toContain('name: invoice-helper')
    expect(written).toContain('description: 做发票时用它')

    const rejected = String(
      await callTool(tool, { name: 'pptx', description: '占内置名', body: 'x' })
    )
    expect(rejected).toContain('内置技能名')
  })
})
