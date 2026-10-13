import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { SKILL_FILE, readSkillHeader, skillNameOf, type SkillSource } from '../../shared/skills'
import type { InstalledSkillView } from '../../shared/plugins'
import type { InstalledPlugin } from '../../shared/settings'

/**
 * 技能的**来源清单**（round 64）：把"技能在盘上的位置"整理成 agent 侧与界面侧共用的一份。
 *
 * 两类来源：
 *   - **内置**（`resources/skills/<名字>/SKILL.md`，随包分发，见 electron-builder.yml 的 extraResources）：
 *     目录由调用方算好传进来（打包后是 `<resources>/skills`，开发态是仓库的 `resources/skills`）——
 *     本模块刻意不 import electron（与 mastra 侧同一条纪律，测试里给个临时目录就能跑）；
 *   - **插件**（`<userData>/skills/<插件 id>-<技能名>/`）：装插件时 installer 复制进来的那份，
 *     归属靠 `settings.installedPlugins[].skillDirs` 反查（谁记的谁认领，不猜目录名）。
 *
 * 为什么要有这一层：技能名/前缀归属的判定必须在**一处**做 —— 插件页列表、`+ → 引用技能` 菜单、
 * agent 指令里的清单、use_skill 的查找，读到的必须是同一个名字。所以这里只产出 SkillSource
 * （位置 + 归属 + 前缀），名字由 shared/skills 的 skillNameOf 统一派生。
 */
export function skillSourcesFor(options: {
  /** `<userData>/skills`（插件技能复制到的目录；不存在 = 空） */
  skillsDir: string
  /** 已安装插件记录（认领技能目录用） */
  installed: readonly InstalledPlugin[]
  /** 内置技能根目录（`resources/skills`）；缺省 = 没有内置技能 */
  builtinDir?: string | null
}): SkillSource[] {
  const sources: SkillSource[] = []

  // 内置在前：office 四件套是"开箱即有"的那批，界面上也该排在插件技能前面
  for (const dir of skillDirNames(options.builtinDir)) {
    sources.push({
      kind: 'builtin',
      path: join(options.builtinDir ?? '', dir),
      dir,
      pluginId: null,
      pluginName: null,
      namePrefix: ''
    })
  }

  for (const dir of skillDirNames(options.skillsDir)) {
    const owner = options.installed.find((record) => record.skillDirs.includes(dir))
    sources.push({
      kind: 'plugin',
      path: join(options.skillsDir, dir),
      dir,
      pluginId: owner?.id ?? null,
      pluginName: owner?.name ?? null,
      namePrefix: owner === undefined ? '' : `${owner.id}-`
    })
  }

  return sources
}

/** 目录下带 SKILL.md 的一级子目录名（目录不存在 / 没有入口文件都不算） */
function skillDirNames(root: string | null | undefined): string[] {
  if (root === null || root === undefined || root === '') return []
  let names: string[]
  try {
    names = readdirSync(root).sort()
  } catch {
    return []
  }
  return names.filter((name) => {
    try {
      return statSync(join(root, name, SKILL_FILE)).isFile()
    } catch {
      return false
    }
  })
}

/**
 * `plugins:overview` 的技能行：名字走 SKILL.md 的 frontmatter（没有就用目录名派生）。
 *
 * 内置技能带 `source: 'builtin'` 标记（界面据此与"插件装进来的"区分）；插件技能不带这个字段
 * —— 老字段形状原样保留，渲染端与既有回包解读不受影响（schema 里它是可选字段）。
 */
export function installedSkillViews(sources: readonly SkillSource[]): InstalledSkillView[] {
  return sources.map((source) => {
    const header = readSkillHeader(source)
    return {
      dir: source.dir,
      // 名字只从 skillNameOf 出来：读不出头部（没有 frontmatter）时回落到"目录名去插件前缀"，
      // 与 round 10 的显示口径一致 —— 直接拿 source.dir 会把插件 id 前缀当名字露给用户
      name: skillNameOf(source, header?.name ?? ''),
      pluginId: source.pluginId,
      pluginName: source.pluginName,
      ...(source.kind === 'builtin' ? { source: 'builtin' as const } : {})
    }
  })
}
