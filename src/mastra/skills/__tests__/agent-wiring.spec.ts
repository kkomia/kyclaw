// @vitest-environment node
/**
 * 接线检查（round 64 / 65）：技能不只在两头的单测里成立，**装配出来的 agent 上也得成立** ——
 *   ① 每轮现算的系统指令里有技能清单（名字 + 描述）；
 *   ② 工具表里真的有 use_skill（模型才调得到）；
 *   ③ 从 agent 上拿到的那只 use_skill 能读到真实技能全文（装配传下去的 sources 生效）；
 *   ④ round 65：作者四件也注册了，而且 create_skill 写完**同一只 agent 的下一轮指令里就有它**
 *      （"写完立即生效"的端到端判据：不必重启、不必重装）。
 *
 * 这里刻意走 createKyclawAgent（而不是拼接各个纯函数）：技能这条链路的价值全在"模型看得见、
 * 调得到、读得到"这三件事上，只测零件不测装配的话，工具没注册进 agent 也照样绿。
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthoringRuntime } from '../../../shared/authoring'
import type { InstalledPlugin } from '../../../shared/settings'
import type { SkillSource } from '../../../shared/skills'
import { skillSourcesFor } from '../../../main/plugins/skills'
import type { KyclawModel } from '../../model'
import { createKyclawAgent } from '../../agents/kyclaw'

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kyclaw-agent-skills-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/** 一个真落到盘上的技能（内置来源） */
function makeSkill(dir: string): SkillSource {
  const path = join(tmp, dir)
  mkdirSync(path, { recursive: true })
  writeFileSync(
    join(path, 'SKILL.md'),
    '---\nname: pptx\ndescription: 做演示文稿时用它\n---\n\n# 手册正文\n一页一个意思。',
    'utf8'
  )
  return { kind: 'builtin', path, dir, pluginId: null, pluginName: null, namePrefix: '' }
}

/** 模型解析器只在这轮真的跑模型时才会被调用；装配阶段给个空壳就够 */
const resolveModel = async (): Promise<KyclawModel> => ({}) as unknown as KyclawModel

describe('装配检查：技能在 agent 上真的可用', () => {
  it('有技能：指令里有清单，工具表里有 use_skill，且能读出全文', async () => {
    const agent = await createKyclawAgent(resolveModel, undefined, {
      skillSources: () => [makeSkill('pptx')]
    })

    const instructions = String(await agent.getInstructions())
    expect(instructions).toContain('Skills (work manuals)')
    expect(instructions).toContain('· pptx：做演示文稿时用它')
    // 手册正文没进指令（渐进式披露：全文靠 use_skill 按需取）
    expect(instructions).not.toContain('一页一个意思。')

    const tools = await agent.listTools()
    expect(Object.keys(tools)).toContain('use_skill')

    const tool = tools.use_skill as unknown as {
      execute(input: unknown, context: unknown): Promise<unknown>
    }
    const out = String(await tool.execute({ name: 'pptx' }, { agent: { threadId: 'session-1' } }))
    expect(out).toContain('技能「pptx」（内置技能）的全文')
    expect(out).toContain('一页一个意思。')
  })

  it('011：use_skill 回包的目录 ID 直接用于 read 读资源（现读注册表；写权限不跟着开）', async () => {
    // 生产来源就是 skillSourcesFor（扫描 `<userData>/skills`）；测试原样用它，证明接线不是另一套
    const skillsDir = join(tmp, 'skills')
    const dir = join(skillsDir, 'pptx')
    mkdirSync(join(dir, 'reference'), { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: pptx\ndescription: 做演示文稿时用它\n---\n# 手册正文\n一页一个意思。',
      'utf8'
    )
    writeFileSync(join(dir, 'reference', 'fields.md'), '# 字段\n内容正文', 'utf8')
    const sources = (): readonly SkillSource[] =>
      skillSourcesFor({ skillsDir, installed: [], builtinDir: null })
    const agent = await createKyclawAgent(resolveModel, undefined, { skillSources: sources })

    const tools = await agent.listTools()
    const context = { agent: { threadId: 'session-1' } }
    const call = async (name: string, input: unknown): Promise<string> => {
      const tool = tools[name] as unknown as {
        execute(input: unknown, context: unknown): Promise<unknown>
      }
      return String(await tool.execute(input, context))
    }

    // ① 文件清单给出可执行的读法（目录 ID，不是绝对路径）
    const manual = await call('use_skill', { name: 'pptx' })
    expect(manual).toContain('read({ skill: "pptx", path: "SKILL.md" })')
    expect(manual).toContain('reference/fields.md')

    // ② 同一只 agent 的 read 能读技能资源（没有配置任何工作区也成立）
    const read = tools.read as unknown as {
      execute(input: unknown, context: unknown): Promise<unknown>
    }
    expect(
      String(await read.execute({ skill: 'pptx', path: 'reference/fields.md' }, context))
    ).toContain('内容正文')

    // ③ 只读：write 仍只认授权工作区
    const write = tools.write as unknown as {
      execute(input: unknown, context: unknown): Promise<unknown>
    }
    await expect(
      write.execute({ path: join(dir, 'reference', 'fields.md'), content: 'x' }, context)
    ).rejects.toThrow(/授权工作区/)

    // ④ 注册表现读：技能卸载（目录被删）后 read 立刻拒绝（不信任上下文里旧的 use_skill 输出）
    rmSync(dir, { recursive: true, force: true })
    await expect(
      read.execute({ skill: 'pptx', path: 'reference/fields.md' }, context)
    ).rejects.toThrow(/没有已注册的技能/)
  })

  it('011：坏 frontmatter 只在来源清单里，use_skill 看不到，read 也拒绝（信任根与有效清单同源）', async () => {
    const skillsDir = join(tmp, 'skills')
    const bad = join(skillsDir, 'bad')
    mkdirSync(bad, { recursive: true })
    writeFileSync(join(bad, 'SKILL.md'), 'not frontmatter', 'utf8')
    writeFileSync(join(bad, 'reference.md'), 'FAKE_MARKER_NOT_A_REAL_SECRET', 'utf8')
    const sources = (): readonly SkillSource[] =>
      skillSourcesFor({ skillsDir, installed: [], builtinDir: null })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const agent = await createKyclawAgent(resolveModel, undefined, { skillSources: sources })
      const tools = await agent.listTools()
      const context = { agent: { threadId: 'session-1' } }
      const call = async (name: string, input: unknown): Promise<string> => {
        const tool = tools[name] as unknown as {
          execute(input: unknown, context: unknown): Promise<unknown>
        }
        return String(await tool.execute(input, context))
      }

      expect(await call('use_skill', { name: 'bad' })).toContain('没找到技能')
      expect(String(await agent.getInstructions())).not.toContain('· bad')

      // read 的信任根每次现算：坏的 frontmatter 不在表里，也不再重复打印发现警告
      warn.mockClear()
      await expect(call('read', { skill: 'bad', path: 'reference.md' })).rejects.toThrow(
        /没有已注册的技能/
      )
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('011：插件目录名 ≠ 技能名：use_skill 打印目录 ID，read 只认 ID（不盲加名字别名）', async () => {
    const skillsDir = join(tmp, 'skills')
    const dir = join(skillsDir, 'market-p1-demo')
    mkdirSync(join(dir, 'reference'), { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: demo\ndescription: 插件演示\n---\n# 手册正文',
      'utf8'
    )
    writeFileSync(join(dir, 'reference', 'fields.md'), '# 字段\n内容正文', 'utf8')
    const installed: InstalledPlugin[] = [
      {
        id: 'market-p1',
        marketplaceId: 'market',
        name: '演示插件',
        installedAt: '2026-10-13T00:00:00.000Z',
        mcpServerIds: [],
        skillDirs: ['market-p1-demo'],
        installDir: null
      }
    ]
    const agent = await createKyclawAgent(resolveModel, undefined, {
      skillSources: () => skillSourcesFor({ skillsDir, installed, builtinDir: null })
    })
    const tools = await agent.listTools()
    const context = { agent: { threadId: 'session-1' } }
    const call = async (name: string, input: unknown): Promise<string> => {
      const tool = tools[name] as unknown as {
        execute(input: unknown, context: unknown): Promise<unknown>
      }
      return String(await tool.execute(input, context))
    }

    const manual = await call('use_skill', { name: 'demo' })
    expect(manual).toContain('技能目录 ID：market-p1-demo')
    expect(manual).toContain('read 的 skill 参数只认这个目录 ID')

    // 目录 ID 可读（大小写不敏感）；技能名不是 read 的索引，没有别名
    expect(await call('read', { skill: 'market-p1-demo', path: 'reference/fields.md' })).toContain(
      '内容正文'
    )
    expect(await call('read', { skill: 'MARKET-P1-DEMO', path: 'reference/fields.md' })).toContain(
      '内容正文'
    )
    await expect(call('read', { skill: 'demo', path: 'reference/fields.md' })).rejects.toThrow(
      /没有已注册的技能「demo」/
    )
    // 不带 skill 也不会把技能资源当工作区文件读
    await expect(call('read', { path: 'reference/fields.md' })).rejects.toThrow(/授权工作区/)
  })

  it('011：技能在装配后变成坏 frontmatter：read 的信任根现读，立刻拒绝', async () => {
    const skillsDir = join(tmp, 'skills')
    const dir = join(skillsDir, 'demo')
    mkdirSync(join(dir, 'reference'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: demo\n---\n# 手册正文', 'utf8')
    writeFileSync(join(dir, 'reference', 'fields.md'), '# 字段\n内容正文', 'utf8')
    const agent = await createKyclawAgent(resolveModel, undefined, {
      skillSources: () => skillSourcesFor({ skillsDir, installed: [], builtinDir: null })
    })
    const tools = await agent.listTools()
    const context = { agent: { threadId: 'session-1' } }
    const call = async (name: string, input: unknown): Promise<string> => {
      const tool = tools[name] as unknown as {
        execute(input: unknown, context: unknown): Promise<unknown>
      }
      return String(await tool.execute(input, context))
    }

    expect(await call('read', { skill: 'demo', path: 'reference/fields.md' })).toContain('内容正文')
    writeFileSync(join(dir, 'SKILL.md'), 'not frontmatter', 'utf8')
    await expect(call('read', { skill: 'demo', path: 'reference/fields.md' })).rejects.toThrow(
      /没有已注册的技能/
    )
    expect(await call('use_skill', { name: 'demo' })).toContain('没找到技能')
  })

  it('没有技能：指令里不出现技能清单，use_skill 照样注册（回"暂无可用技能"）', async () => {
    const agent = await createKyclawAgent(resolveModel)

    expect(String(await agent.getInstructions())).not.toContain('Skills (work manuals)')

    const tools = await agent.listTools()
    const tool = tools.use_skill as unknown as {
      execute(input: unknown, context: unknown): Promise<unknown>
    }
    const out = String(await tool.execute({ name: 'pptx' }, { agent: { threadId: 'session-1' } }))
    expect(out).toContain('当前没有可用技能')
  })
})

describe('装配检查（round 65）：模型自己写的技能，下一轮就生效', () => {
  /** 用户技能目录里的每一项都是一个来源（生产里这条由 main 侧 skillSourcesFor 算出来） */
  function sourcesUnder(skillsDir: string): SkillSource[] {
    let names: string[] = []
    try {
      names = readdirSync(skillsDir)
    } catch {
      names = []
    }
    return names.map((dir) => ({
      kind: 'plugin' as const,
      path: join(skillsDir, dir),
      dir,
      pluginId: null,
      pluginName: null,
      namePrefix: ''
    }))
  }

  it('作者四件都注册了；create_skill 写完 → 同一 agent 的指令与 use_skill 立刻能看到它', async () => {
    const skillsDir = join(tmp, 'skills')
    const runtime: AuthoringRuntime = {
      skillsDir,
      pluginSkillDirs: [],
      builtinSkillNames: [],
      readMcpServers: () => [],
      saveMcpServers: (servers) => servers
    }
    const agent = await createKyclawAgent(resolveModel, undefined, {
      skillSources: () => sourcesUnder(skillsDir),
      authoring: () => runtime
    })

    const tools = await agent.listTools()
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        'create_skill',
        'delete_skill',
        'add_mcp_server',
        'remove_mcp_server'
      ])
    )
    expect(String(await agent.getInstructions())).not.toContain('invoice-helper')

    const call = async (name: string, input: unknown): Promise<string> => {
      const tool = tools[name] as unknown as {
        execute(input: unknown, context: unknown): Promise<unknown>
      }
      return String(await tool.execute(input, { agent: { threadId: 'session-1' } }))
    }

    const written = await call('create_skill', {
      name: 'invoice-helper',
      description: '用户要做发票、对账单时用它',
      body: '# 发票助手\n\n## 什么时候用\n做发票时。',
      files: [{ path: 'reference/fields.md', content: '# 字段' }]
    })
    expect(written).toContain('已创建技能「invoice-helper」')

    // ① 下一轮的系统指令里就有了（技能清单每轮现算 —— 不必重启、不必重装）
    const instructions = String(await agent.getInstructions())
    expect(instructions).toContain('· invoice-helper：用户要做发票、对账单时用它')

    // ② use_skill 立刻能读到全文与文件清单
    const readBack = await call('use_skill', { name: 'invoice-helper' })
    expect(readBack).toContain('# 发票助手')
    expect(readBack).toContain('reference/fields.md')

    // ③ create_skill 写的配套资源，同一只 agent 的 read 立刻能按目录 ID 读到
    expect(await call('read', { skill: 'invoice-helper', path: 'reference/fields.md' })).toContain(
      '# 字段'
    )

    // ④ 删掉之后两边同时消失（read 的目录索引也立刻失效）
    expect(await call('delete_skill', { name: 'invoice-helper' })).toContain('已删除用户技能')
    expect(String(await agent.getInstructions())).not.toContain('invoice-helper')
    expect(await call('use_skill', { name: 'invoice-helper' })).toContain('没找到技能')
    await expect(
      call('read', { skill: 'invoice-helper', path: 'reference/fields.md' })
    ).rejects.toThrow(/没有已注册的技能/)
  })

  it('add_mcp_server 走的是装配传下去的运行时（写盘 + 通知对齐各一次）', async () => {
    let saved: unknown[] = []
    let changed = 0
    const agent = await createKyclawAgent(resolveModel, undefined, {
      authoring: () => ({
        skillsDir: join(tmp, 'skills'),
        pluginSkillDirs: [],
        builtinSkillNames: [],
        readMcpServers: () => [],
        saveMcpServers: (servers) => {
          saved = servers
          return servers
        },
        onMcpServersChanged: () => {
          changed += 1
        }
      })
    })

    const tools = await agent.listTools()
    const tool = tools.add_mcp_server as unknown as {
      execute(input: unknown, context: unknown): Promise<unknown>
    }
    const out = String(
      await tool.execute(
        { name: 'echo', transport: 'http', url: 'https://example.com/mcp' },
        { agent: { threadId: 'session-1' } }
      )
    )

    expect(out).toContain('已添加 MCP 服务「echo」')
    expect(saved).toHaveLength(1)
    expect(changed).toBe(1)
  })
})
