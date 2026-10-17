import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  readSkillHeader,
  resolveSkillEntryFile,
  skillNameOf,
  type SkillSource
} from '../../shared/skills'
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
 * round 94 起 `skillsDir` 里还住着**用户自己那份**（从 URL / 本地导入的技能、模型用 create_skill 建的）：
 * 它们在 agent 侧同样按 `plugin` 来源扫（技能来源的 kind 只有两类，agent 不需要再分一层），
 * 但**界面侧**按"有没有插件记录认领"区分成 `user`（见 installedSkillViews 的 source 口径）。
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

/**
 * 目录下带 SKILL.md 的一级子目录名（目录不存在 / 没有入口文件都不算）。
 *
 * **点开头的一级目录不进扫描**（round 94）：`<userData>/skills/.<任何名字>` 是我们自己的命名空间
 * ——导入的暂存目录、以及将来可能出现的内部目录都住在那儿。它们不进清单，就不会被界面/agent 当成技能
 * （一个没清干净的暂存目录曾经会顶着 frontmatter 里的名字占住一个正式技能名，让同名导入**永久被拒**）。
 *
 * 对用户目录无破坏：技能名走 `SKILL_NAME_PATTERN`（首字符必须是字母或数字，见 shared/skills），
 * create_skill 建的、插件 installer 复制的目录名也都不可能以 `.` 开头 —— 即"点开头的目录"从来就不是
 * 一个合法技能目录；用户真手动放一个 `.foo/SKILL.md` 进去，它只是不会被扫描（不是被删）。
 *
 * 011：**不跟随链接**，且与 header / 全文读取共用 `resolveSkillEntryFile` 这一份判据：
 *   - 技能目录本身是符号链接 / junction 时不算技能（否则 `<userData>/skills` 里放一个指向
 *     `C:\Windows` 的 junction 就能占一个技能名，还会让 `read({ skill })` 的只读根指向任意目录）；
 *   - `SKILL.md` 必须存在且是文件，其 realpath 仍在技能目录内（链接到外部不算）。
 * 界面清单、agent 指令、`use_skill`、`read` 的只读根都从这里出发，所以在扫描这一层统一过滤。
 */
function skillDirNames(root: string | null | undefined): string[] {
  if (root === null || root === undefined || root === '') return []
  let names: string[]
  try {
    names = readdirSync(root).sort()
  } catch {
    return []
  }
  return names
    .filter((name) => !name.startsWith('.'))
    .filter((name) => resolveSkillEntryFile({ path: join(root, name) }) !== null)
}

/**
 * `plugins:overview` 的技能行：名字走 SKILL.md 的 frontmatter（没有就用目录名派生）。
 *
 * `source` 标记（界面按它分三组）：
 *   - `'builtin'`：随包分发的内置技能；
 *   - `'user'`（round 94）：`<userData>/skills` 下**没有插件记录认领**的那批 —— 用户从
 *     URL / 本地文件导入进来的、以及模型用 create_skill 建的，都在这里；
 *   - `'plugin'`：插件复制进来、被 `installedPlugins[].skillDirs` 认领的那些。
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
      source:
        source.kind === 'builtin'
          ? ('builtin' as const)
          : source.pluginId === null
            ? ('user' as const)
            : ('plugin' as const)
    }
  })
}
