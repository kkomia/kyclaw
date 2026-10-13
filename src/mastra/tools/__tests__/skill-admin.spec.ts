// @vitest-environment node
/**
 * create_skill / delete_skill（round 65）：让模型自己把技能落到用户技能目录。
 *
 * 钉住的六件事：
 *   ① **写完立即生效**：写盘后 `discoverSkills`（agent 每轮现扫的那条路）能读到 —— 不需要重启；
 *   ② **名字白名单**：中文 / 大写 / 空格 / `.` / `..` / 分隔符一律回人话拒绝（不抛、不落盘）；
 *   ③ **路径锁死在托管目录**：附带文件 `..` / 绝对路径 / 隐藏目录拒绝，且**整个技能一个文件都不写**；
 *   ④ **不许动内置与插件**：内置技能名、插件技能目录名都拒；
 *   ⑤ 上界：单文件 / 整包超限拒绝；
 *   ⑥ 审批：create_skill 写类（full 工作区免审）、delete_skill 危险档（永远问）；运行时缺失回人话。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AuthoringRuntime } from '../../../shared/authoring'
import { SKILL_FILE } from '../../../shared/skills'
import { classifyToolCall } from '../../../main/permission/classify'
import { discoverSkills, findSkill } from '../../skills/loader'
import type { SkillSource } from '../../../shared/skills'
import { callTool, createBed, type TestBed } from './helpers'
import {
  createCreateSkillTool,
  createDeleteSkillTool,
  createSkillInputSchema
} from '../skill-admin'

let bed: TestBed
let tmp: string
let skillsDir: string

beforeEach(() => {
  bed = createBed()
  tmp = mkdtempSync(join(tmpdir(), 'kyclaw-skill-admin-'))
  skillsDir = join(tmp, 'skills')
})

afterEach(() => {
  bed.dispose()
  rmSync(tmp, { recursive: true, force: true })
})

function runtime(overrides: Partial<AuthoringRuntime> = {}): AuthoringRuntime {
  return {
    skillsDir,
    pluginSkillDirs: [],
    builtinSkillNames: ['pptx', 'docx', 'xlsx', 'pdf', 'skill-author'],
    readMcpServers: () => [],
    saveMcpServers: (servers) => servers,
    ...overrides
  }
}

/** agent 侧那一份来源（`<userData>/skills` 下的目录就是插件/用户技能的家） */
function sources(): SkillSource[] {
  const names: string[] = existsSync(skillsDir) ? readdirSync(skillsDir) : []
  return names.map((dir) => ({
    kind: 'plugin' as const,
    path: join(skillsDir, dir),
    dir,
    pluginId: null,
    pluginName: null,
    namePrefix: ''
  }))
}

const VALID = {
  name: 'invoice-helper',
  description: '用户要做发票、对账单、报销单时用它：讲清口径与自检清单',
  body: '# 发票助手\n\n## 什么时候用\n做发票时。\n\n## 常见坑\n金额口径。'
}

describe('create_skill：写入并立即生效', () => {
  it('写 SKILL.md（+ 附带文件）→ discoverSkills 立刻能读到，frontmatter 往返一致', async () => {
    const tool = await createCreateSkillTool(bed.ctx, () => runtime())

    const out = String(
      await callTool(tool, {
        ...VALID,
        files: [{ path: 'reference/fields.md', content: '# 字段\n- 金额' }]
      })
    )

    expect(out).toContain('已创建技能「invoice-helper」')
    expect(out).toContain('SKILL.md')
    expect(out).toContain('reference/fields.md')

    const file = join(skillsDir, 'invoice-helper', SKILL_FILE)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(join(skillsDir, 'invoice-helper', 'reference', 'fields.md'))).toBe(true)

    // 同一份发现逻辑（agent 每轮就是现扫这条）立刻能读到它 —— 这是"无需重启即生效"的判据
    const entries = discoverSkills(sources())
    const entry = findSkill(entries, 'invoice-helper')
    expect(entry?.name).toBe('invoice-helper')
    expect(entry?.description).toBe(VALID.description)
    expect(readFileSync(file, 'utf8')).toContain('## 常见坑')
  })

  it('再写一次 = 更新（覆盖），不是新目录', async () => {
    const tool = await createCreateSkillTool(bed.ctx, () => runtime())
    await callTool(tool, VALID)
    const out = String(await callTool(tool, { ...VALID, description: '改过的一句话' }))

    expect(out).toContain('已更新技能「invoice-helper」')
    expect(discoverSkills(sources())).toHaveLength(1)
    expect(discoverSkills(sources())[0]?.description).toBe('改过的一句话')
  })

  it('name 与 description 里的特殊字符（冒号 / 引号 / 反斜杠）往返不失真', async () => {
    const tool = await createCreateSkillTool(bed.ctx, () => runtime())
    const description = '用它：处理 "带引号" 与 C:\\path 与 #井号'
    await callTool(tool, { name: 'special', description, body: '正文' })

    const entry = findSkill(discoverSkills(sources()), 'special')
    expect(entry?.description).toBe(description)
  })
})

describe('create_skill：名字与路径的边界', () => {
  it('名字不合法：回人话 + 改名建议，且不落盘', async () => {
    const tool = await createCreateSkillTool(bed.ctx, () => runtime())

    for (const name of [
      '发票助手',
      'Invoice-Helper',
      'a b',
      '..',
      'a/b',
      'a\\b',
      '.hidden',
      '-x'
    ]) {
      const out = String(await callTool(tool, { ...VALID, name }))
      expect(out, name).toContain('create_skill 失败')
      expect(out, name).toContain('invoice-helper')
    }
    expect(existsSync(skillsDir)).toBe(false)
  })

  it('内置技能名 / 插件技能目录名：拒绝（不覆盖别人的东西）', async () => {
    const tool = await createCreateSkillTool(bed.ctx, () =>
      runtime({ pluginSkillDirs: ['market-p1-demo'] })
    )

    const builtin = String(await callTool(tool, { ...VALID, name: 'pptx' }))
    expect(builtin).toContain('内置技能名')
    expect(builtin).toContain('my-pptx')

    const plugin = String(await callTool(tool, { ...VALID, name: 'market-p1-demo' }))
    expect(plugin).toContain('插件复制进来的技能目录')
    expect(existsSync(skillsDir)).toBe(false)
  })

  it('附带文件路径逃逸（..、绝对路径、隐藏目录、太深）：整份不写', async () => {
    const tool = await createCreateSkillTool(bed.ctx, () => runtime())

    const cases = [
      '../outside.md',
      'reference/../../x.md',
      'C:/Windows/x.md',
      '.git/config',
      'a/b/c/d.md'
    ]
    for (const path of cases) {
      const out = String(await callTool(tool, { ...VALID, files: [{ path, content: 'x' }] }))
      expect(out, path).toContain('create_skill 失败')
    }
    expect(existsSync(join(skillsDir, 'invoice-helper'))).toBe(false)
  })

  it('上界：单文件超 64KB / 整包超 256KB → 拒绝', async () => {
    const tool = await createCreateSkillTool(bed.ctx, () => runtime())

    // 30000 个汉字 = 90000 字节：字符数在 schema 上界内，靠字节检查挡（中文一个字符 3 字节）
    const big = '汉'.repeat(30000)
    const single = String(
      await callTool(tool, { ...VALID, files: [{ path: 'big.md', content: big }] })
    )
    expect(single).toContain('超过单文件上限')

    const chunks = Array.from({ length: 8 }, (_, index) => ({
      path: `reference/f${index}.md`,
      content: 'b'.repeat(35000)
    }))
    const total = String(await callTool(tool, { ...VALID, files: chunks }))
    expect(total).toContain('超过上限')
    expect(existsSync(join(skillsDir, 'invoice-helper'))).toBe(false)
  })

  it('schema 层先挡：空名 / 超长名 / 空正文都不进 execute（中文提示给模型看）', () => {
    expect(createSkillInputSchema.safeParse({ ...VALID, name: '' }).success).toBe(false)
    expect(createSkillInputSchema.safeParse({ ...VALID, body: '' }).success).toBe(false)

    const long = createSkillInputSchema.safeParse({ ...VALID, name: 'x'.repeat(65) })
    expect(long.success).toBe(false)
    expect(JSON.stringify(long.error?.issues)).toContain('技能名最长 64 字符')

    const manyFiles = createSkillInputSchema.safeParse({
      ...VALID,
      files: Array.from({ length: 21 }, (_, index) => ({ path: `r/f${index}.md`, content: 'x' }))
    })
    expect(manyFiles.success).toBe(false)
    expect(JSON.stringify(manyFiles.error?.issues)).toContain('最多 20 个附带文件')
  })

  it('运行时缺失：回人话（不抛）', async () => {
    const tool = await createCreateSkillTool(bed.ctx, () => null)
    const out = String(await callTool(tool, VALID))
    expect(out).toContain('不支持创建技能')
  })
})

describe('delete_skill：只删用户技能', () => {
  it('删掉用户技能：目录消失，discoverSkills 也读不到了', async () => {
    mkdirSync(join(skillsDir, 'temp'), { recursive: true })
    writeFileSync(join(skillsDir, 'temp', SKILL_FILE), '---\nname: temp\n---\n', 'utf8')
    const tool = await createDeleteSkillTool(bed.ctx, () => runtime())

    const out = String(await callTool(tool, { name: 'temp' }))

    expect(out).toContain('已删除用户技能「temp」')
    expect(existsSync(join(skillsDir, 'temp'))).toBe(false)
    expect(discoverSkills(sources())).toEqual([])
  })

  it('内置 / 插件技能：拒绝并给替代做法（卸载插件）', async () => {
    mkdirSync(join(skillsDir, 'market-p1-demo'), { recursive: true })
    writeFileSync(join(skillsDir, 'market-p1-demo', SKILL_FILE), '---\nname: demo\n---\n', 'utf8')
    const tool = await createDeleteSkillTool(bed.ctx, () =>
      runtime({ pluginSkillDirs: ['market-p1-demo'] })
    )

    expect(String(await callTool(tool, { name: 'pptx' }))).toContain('内置技能')
    expect(String(await callTool(tool, { name: 'market-p1-demo' }))).toContain('卸载对应插件')
    expect(existsSync(join(skillsDir, 'market-p1-demo'))).toBe(true)
  })

  it('不存在：回人话并列出当前用户技能', async () => {
    mkdirSync(join(skillsDir, 'mine'), { recursive: true })
    writeFileSync(join(skillsDir, 'mine', SKILL_FILE), '---\nname: mine\n---\n', 'utf8')
    const tool = await createDeleteSkillTool(bed.ctx, () => runtime())

    const out = String(await callTool(tool, { name: 'nope' }))
    expect(out).toContain('没有用户技能「nope」')
    expect(out).toContain('mine')
  })
})

describe('审批档位（classify + requireApproval）', () => {
  it('create_skill 是写类、delete_skill 是危险档；ask 工作区上都要问', async () => {
    expect(classifyToolCall('create_skill', { name: 'x' })).toBe('write')
    expect(classifyToolCall('delete_skill', { name: 'x' })).toBe('dangerous')
    expect(classifyToolCall('add_mcp_server', { name: 'x' })).toBe('write')
    expect(classifyToolCall('remove_mcp_server', { id: 'x' })).toBe('write')

    const create = await createCreateSkillTool(bed.ctx, () => runtime())
    const remove = await createDeleteSkillTool(bed.ctx, () => runtime())
    const gate = (tool: unknown): ((input: unknown) => boolean) =>
      (tool as { requireApproval: (input: unknown) => boolean }).requireApproval

    expect(gate(create)({ name: 'x' })).toBe(true)
    expect(gate(remove)({ name: 'x' })).toBe(true)

    // round 75：delete_skill 与 delete / move 同一档 —— 工作区「完全访问」时也免审
    bed.roots[0] = { ...bed.roots[0], mode: 'full' }
    expect(gate(remove)({ name: 'x' })).toBe(false)
    // create_skill 是写类且没有"显式工作区目标"：full 工作区免审（round 36/46 口径）
    expect(gate(create)({ name: 'x' })).toBe(false)
  })
})
