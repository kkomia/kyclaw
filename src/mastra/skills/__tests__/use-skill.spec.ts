// @vitest-environment node
/**
 * use_skill（round 64）：渐进式披露的第二层——按需读 SKILL.md 全文。
 *
 * 钉住的四件事：
 *   ① 命中：回全文 + 技能目录的文件清单 + 来源说明；
 *   ② 未命中：回**人话 + 可用技能清单**（不抛异常——抛错只会让这一轮以错误卡收场）；
 *   ③ 名字三种写法都命中（技能名 / 目录名 / 去插件前缀）；来源**现读**（下一轮装的技能立刻可用）；
 *   ④ read 档（免审批）：分类表与工具自己的 requireApproval 两个入口都放行。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classifyToolCall } from '../../../main/permission/classify'
import { SKILL_FILE, type SkillSource } from '../../../shared/skills'
import { callTool, createBed, type TestBed } from '../../tools/__tests__/helpers'
import { createUseSkillTool } from '../tool'
import { resetSkillRuntimeFactsSource, SKILL_RUNTIME_FACTS_HEADING } from '../runtime'

let bed: TestBed
let tmp: string

beforeEach(() => {
  bed = createBed()
  tmp = mkdtempSync(join(tmpdir(), 'kyclaw-use-skill-'))
})

afterEach(() => {
  bed.dispose()
  // round 68：事实来源是模块级注册表，用例之间别互相串
  resetSkillRuntimeFactsSource()
  rmSync(tmp, { recursive: true, force: true })
})

/** 造一个技能目录，返回 SkillSource */
function sourceOf(options: {
  kind: 'builtin' | 'plugin'
  dir: string
  content: string
  pluginId?: string
}): SkillSource {
  const root = join(tmp, options.kind === 'builtin' ? 'builtin' : 'skills')
  const path = join(root, options.dir)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, SKILL_FILE), options.content, 'utf8')
  return {
    kind: options.kind,
    path,
    dir: options.dir,
    pluginId: options.pluginId ?? null,
    pluginName: options.pluginId === undefined ? null : '演示插件',
    namePrefix: options.pluginId === undefined ? '' : `${options.pluginId}-`
  }
}

const PPTX_MD = [
  '---',
  'name: pptx',
  'description: 做演示文稿时用它',
  'license: 自研',
  '---',
  '',
  '# pptx：用 create_ppt 做演示文稿',
  '一页一个意思。'
].join('\n')

describe('use_skill：命中', () => {
  it('回全文（含 frontmatter 与正文）+ 文件清单 + 来源 + 许可', async () => {
    const source = sourceOf({ kind: 'builtin', dir: 'pptx', content: PPTX_MD })
    mkdirSync(join(source.path, 'reference'))
    writeFileSync(join(source.path, 'reference', 'layouts.md'), '# 版式', 'utf8')
    const tool = await createUseSkillTool(bed.ctx, () => [source])

    const out = String(await callTool(tool, { name: 'pptx' }))

    expect(out).toContain('技能「pptx」（内置技能）的全文')
    expect(out).toContain('> 做演示文稿时用它')
    expect(out).toContain('> 许可：自研')
    expect(out).toContain('reference/layouts.md')
    expect(out).toContain('# pptx：用 create_ppt 做演示文稿')
    expect(out).toContain('一页一个意思。')
  })

  it('插件技能：说明来自哪个插件；名字用去掉前缀的目录名也能命中', async () => {
    const source = sourceOf({
      kind: 'plugin',
      dir: 'market-p1-demo',
      pluginId: 'market-p1',
      content: '---\nname: demo\n---\n示例手册'
    })
    const tool = await createUseSkillTool(bed.ctx, () => [source])

    const out = String(await callTool(tool, { name: 'demo' }))
    expect(out).toContain('（插件「演示插件」）')
    expect(out).toContain('示例手册')
  })

  // round 68：加载时的"本部署事实"段由调用方注入（缺省走注册表）——注入什么就拼出什么
  it('全文末尾拼上注入的本部署事实（渲染器 / 读图能力）', async () => {
    const source = sourceOf({ kind: 'builtin', dir: 'pptx', content: PPTX_MD })
    const tool = await createUseSkillTool(
      bed.ctx,
      () => [source],
      () => ({
        pptRenderer: 'none',
        vision: false
      })
    )

    const out = String(await callTool(tool, { name: 'pptx' }))

    expect(out).toContain(SKILL_RUNTIME_FACTS_HEADING)
    expect(out).toContain('页图渲染：不可用')
    expect(out).toContain('当前模型读图：不支持')
    expect(out).toContain('未做视觉检查')
    // 那一段在正文之后（手册先给做法，再说本机实情）
    expect(out.indexOf('一页一个意思。')).toBeLessThan(out.indexOf(SKILL_RUNTIME_FACTS_HEADING))
  })

  it('没有注入事实来源：那一段如实写"未知"，不编造能力', async () => {
    resetSkillRuntimeFactsSource()
    const source = sourceOf({ kind: 'builtin', dir: 'pptx', content: PPTX_MD })
    const tool = await createUseSkillTool(bed.ctx, () => [source])

    const out = String(await callTool(tool, { name: 'pptx' }))

    expect(out).toContain('页图渲染：未知')
    expect(out).toContain('当前模型读图：未知')
  })

  it('来源现读：调用之间新增的技能，下一次调用就能读到', async () => {
    const sources: SkillSource[] = []
    const tool = await createUseSkillTool(bed.ctx, () => sources)

    expect(String(await callTool(tool, { name: 'docx' }))).toContain('没找到技能')

    sources.push(sourceOf({ kind: 'builtin', dir: 'docx', content: '---\nname: docx\n---\n手册' }))
    expect(String(await callTool(tool, { name: 'docx' }))).toContain('手册')
  })
})

describe('use_skill：未命中（不抛）', () => {
  it('回可读的错误 + 可用技能清单 + 兜底建议', async () => {
    const tool = await createUseSkillTool(bed.ctx, () => [
      sourceOf({ kind: 'builtin', dir: 'pptx', content: PPTX_MD }),
      sourceOf({ kind: 'builtin', dir: 'xlsx', content: '---\nname: xlsx\n---\n表格手册' })
    ])

    const out = String(await callTool(tool, { name: 'ppt' }))

    expect(out).toContain('没找到技能「ppt」')
    expect(out).toContain('pptx、xlsx')
    expect(out).toContain('create_ppt')
  })

  it('一个技能都没有：人话说明当前没有可用技能', async () => {
    const tool = await createUseSkillTool(bed.ctx, () => [])

    const out = String(await callTool(tool, { name: 'pptx' }))
    expect(out).toContain('当前没有可用技能')
  })
})

describe('use_skill：读档（免审批）', () => {
  it('分类表里是 read：ask 工作区上也不弹审批；full 工作区也照旧免审', async () => {
    expect(classifyToolCall('use_skill', { name: 'pptx' })).toBe('read')

    const tool = await createUseSkillTool(bed.ctx, () => [])
    const gate = (tool as unknown as { requireApproval: (input: unknown) => boolean })
      .requireApproval
    expect(gate({ name: 'pptx' })).toBe(false)

    bed.roots[0] = { ...bed.roots[0], mode: 'full' }
    expect(gate({ name: 'pptx' })).toBe(false)
  })
})
