import { PackageOpen, Sparkles, UserRound } from 'lucide-react'
import type { InstalledSkillView } from '@shared/plugins'

/**
 * 插件页「技能」面板（round 10 起；round 64 起内置技能也进这份清单；round 94 起加「我的技能」）：
 * 三组 —— **内置技能**（随应用常驻的 office 四件套，回包 `source: 'builtin'`）、
 * **我的技能**（用户从 URL / 本地导入进来的、以及模型自建的，回包 `source: 'user'`）、
 * **插件技能**（随插件装进来的，回包 `source: 'plugin'`；行上写清来自哪个插件）。
 *
 * 分组只按 `source` 判：内置技能**不能**被说成「来自插件」（round 64 的显示口径），
 * 老回包（没有 `source` 字段）里的技能仍归「插件技能」一组（与 round 64 之前一致）。
 * 内置一组为空就不出标题（没有可列的东西就不留一个空标题）；「我的技能」与「插件技能」两组
 * 各自给空态说清"怎么才会有"。
 * 口吻克制（用户实拍 #9）：只讲"是什么、来自哪里"，不写实现细节、不写"研发中/待接"这类话。
 */
export interface PluginsSkillsPanelProps {
  /** `plugins:overview` 的 installedSkills（内置 / 我的 / 插件一份清单） */
  installedSkills?: readonly InstalledSkillView[]
}

/** 技能来源（界面口径；老回包缺 `source` 的一律按插件技能算） */
type SkillGroup = 'builtin' | 'user' | 'plugin'

function groupOf(skill: InstalledSkillView): SkillGroup {
  if (skill.source === 'builtin') return 'builtin'
  if (skill.source === 'user') return 'user'
  return 'plugin'
}

/** 行首图标位（32px、圆角 control、Fills-F2 底；与插件行的头像位同一档）：三组各一枚图标 */
function SkillIcon({ group }: { group: SkillGroup }): React.JSX.Element {
  const Icon = group === 'builtin' ? Sparkles : group === 'user' ? UserRound : PackageOpen
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-control bg-selected text-ink-secondary"
    >
      <Icon className="size-(--icon-size-md)" />
    </span>
  )
}

/** 技能行：名字 + （插件技能）来自哪个插件；内置与"我的"不给副行——标题已经说明来源 */
function SkillRow({
  skill,
  group
}: {
  skill: InstalledSkillView
  group: SkillGroup
}): React.JSX.Element {
  return (
    <div data-testid={`skill-installed-${skill.dir}`} className="flex items-center gap-3 px-3 py-2">
      <SkillIcon group={group} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-b1 text-ink">{skill.name}</span>
        {group === 'plugin' && skill.pluginName !== null ? (
          <span className="truncate text-c1 text-ink-tertiary">来自 {skill.pluginName}</span>
        ) : null}
      </div>
    </div>
  )
}

export function PluginsSkillsPanel({
  installedSkills = []
}: PluginsSkillsPanelProps): React.JSX.Element {
  const groups: Record<SkillGroup, InstalledSkillView[]> = {
    builtin: [],
    user: [],
    plugin: []
  }
  for (const skill of installedSkills) groups[groupOf(skill)].push(skill)

  return (
    <div data-testid="plugins-skills" className="flex flex-col gap-5">
      {groups.builtin.length === 0 ? null : (
        <section data-testid="skills-builtin" className="flex flex-col gap-1">
          <h2 className="px-3 text-b2 font-medium text-ink">内置技能</h2>
          {groups.builtin.map((skill) => (
            <SkillRow key={skill.dir} skill={skill} group="builtin" />
          ))}
        </section>
      )}

      <section data-testid="skills-user" className="flex flex-col gap-1">
        <h2 className="px-3 text-b2 font-medium text-ink">我的技能</h2>
        {groups.user.length === 0 ? (
          <p data-testid="skills-user-empty" className="px-3 font-serif text-b2 text-ink-secondary">
            还没有自己导入的技能：用右上角「新增」从网址、本地文件或文件夹导入。
          </p>
        ) : (
          groups.user.map((skill) => <SkillRow key={skill.dir} skill={skill} group="user" />)
        )}
      </section>

      <section data-testid="skills-plugins" className="flex flex-col gap-1">
        <h2 className="px-3 text-b2 font-medium text-ink">插件技能</h2>
        {groups.plugin.length === 0 ? (
          <p
            data-testid="skills-plugins-empty"
            className="px-3 font-serif text-b2 text-ink-secondary"
          >
            还没有插件带来的技能：去「插件」里安装一个插件。
          </p>
        ) : (
          groups.plugin.map((skill) => <SkillRow key={skill.dir} skill={skill} group="plugin" />)
        )}
      </section>
    </div>
  )
}
