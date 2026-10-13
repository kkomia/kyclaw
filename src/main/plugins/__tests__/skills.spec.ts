// @vitest-environment node
/**
 * 技能来源清单（round 64）：插件页总览、composer 的 `+ → 引用技能`、agent 侧的技能清单，
 * 读的都是这一份。
 *
 * 钉住：
 *   ① 两类来源都扫（内置在前）、没有 SKILL.md 的目录不算技能；
 *   ② 插件技能的归属靠 `installedPlugins[].skillDirs` 认领（认不出就 pluginId/pluginName 为 null，
 *      且不带前缀——名字退回原目录名）；
 *   ③ 名字走 SKILL.md 的 frontmatter，没有就用"目录名去插件前缀"（与 round 10 的显示口径一致）；
 *   ④ 内置技能带 `source: 'builtin'` 标记；插件技能保持老形状（不带这个字段）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKILL_FILE } from '../../../shared/skills'
import type { InstalledPlugin } from '../../../shared/settings'
import { installedSkillViews, skillSourcesFor } from '../skills'

let tmp: string
let skillsDir: string
let builtinDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kyclaw-skill-sources-'))
  skillsDir = join(tmp, 'skills')
  builtinDir = join(tmp, 'builtin-skills')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function makeSkill(root: string, dir: string, content = '---\nname: x\n---\n'): string {
  const path = join(root, dir)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, SKILL_FILE), content, 'utf8')
  return path
}

const PLUGIN: InstalledPlugin = {
  id: 'market-p1',
  marketplaceId: 'market',
  name: '演示插件',
  installedAt: '2026-10-13T00:00:00.000Z',
  mcpServerIds: [],
  skillDirs: ['market-p1-demo'],
  installDir: null
}

describe('skillSourcesFor：两类来源', () => {
  it('内置在前、插件在后；目录里没有 SKILL.md 的不算技能；内置目录不存在也不报错', () => {
    makeSkill(builtinDir, 'pptx', '---\nname: pptx\ndescription: 演示\n---\n')
    makeSkill(builtinDir, 'not-a-skill')
    rmSync(join(builtinDir, 'not-a-skill', SKILL_FILE), { force: true })
    makeSkill(skillsDir, 'market-p1-demo', '---\nname: demo\n---\n')
    makeSkill(skillsDir, 'orphan-skill', '---\nname: orphan\n---\n')

    const sources = skillSourcesFor({ skillsDir, installed: [PLUGIN], builtinDir })

    expect(sources.map((source) => [source.kind, source.dir])).toEqual([
      ['builtin', 'pptx'],
      ['plugin', 'market-p1-demo'],
      ['plugin', 'orphan-skill']
    ])
    expect(sources[0]?.namePrefix).toBe('')
    expect(sources[0]?.pluginId).toBeNull()
    // 有记录：归属认领得上，前缀 = `<插件 id>-`
    expect(sources[1]?.pluginId).toBe('market-p1')
    expect(sources[1]?.pluginName).toBe('演示插件')
    expect(sources[1]?.namePrefix).toBe('market-p1-')
    // 没有记录：不猜归属、不给前缀（名字退回目录名）
    expect(sources[2]?.pluginId).toBeNull()
    expect(sources[2]?.namePrefix).toBe('')
  })

  it('没有内置目录 / 没有插件记录：空表或只扫一侧（都不抛）', () => {
    expect(skillSourcesFor({ skillsDir, installed: [] })).toEqual([])
    makeSkill(builtinDir, 'pdf', '---\nname: pdf\n---\n')
    expect(skillSourcesFor({ skillsDir, installed: [], builtinDir: null })).toEqual([])
    expect(skillSourcesFor({ skillsDir, installed: [], builtinDir }).map((s) => s.dir)).toEqual([
      'pdf'
    ])
  })
})

describe('installedSkillViews：总览回包里的技能行', () => {
  it('内置技能带 source 标记；名字走 frontmatter', () => {
    makeSkill(builtinDir, 'pptx', '---\nname: pptx\ndescription: 演示\n---\n')

    const views = installedSkillViews(skillSourcesFor({ skillsDir, installed: [], builtinDir }))

    expect(views).toEqual([
      { dir: 'pptx', name: 'pptx', pluginId: null, pluginName: null, source: 'builtin' }
    ])
  })

  it('插件技能保持老形状（dir/name/pluginId/pluginName，不带 source）', () => {
    makeSkill(skillsDir, 'market-p1-demo', '---\nname: demo\n---\n')

    const views = installedSkillViews(
      skillSourcesFor({ skillsDir, installed: [PLUGIN], builtinDir: null })
    )

    expect(views).toEqual([
      { dir: 'market-p1-demo', name: 'demo', pluginId: 'market-p1', pluginName: '演示插件' }
    ])
    expect('source' in (views[0] ?? {})).toBe(false)
  })

  it('SKILL.md 读不出来（同名目录但没有入口文件）→ 不进清单', () => {
    mkdirSync(join(skillsDir, 'empty'), { recursive: true })
    expect(installedSkillViews(skillSourcesFor({ skillsDir, installed: [] }))).toEqual([])
  })
})
