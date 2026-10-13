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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuthoringRuntime } from '../../../shared/authoring'
import type { SkillSource } from '../../../shared/skills'
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

    // ③ 删掉之后两边同时消失
    expect(await call('delete_skill', { name: 'invoice-helper' })).toContain('已删除用户技能')
    expect(String(await agent.getInstructions())).not.toContain('invoice-helper')
    expect(await call('use_skill', { name: 'invoice-helper' })).toContain('没找到技能')
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
