import { PackageOpen, Sparkles } from 'lucide-react'
import type { InstalledSkillView } from '@shared/plugins'

/**
 * 插件页「技能」面板（round 10 起；round 64 起内置技能也进这份清单）：两组——**内置技能**
 * （随应用常驻的 office 四件套，回包带 `source: 'builtin'`）与**插件技能**（随插件装进来的，
 * 行上写清来自哪个插件）。
 *
 * 分组只按 `source` 判：内置技能**不能**被说成「来自插件」（round 64 的显示口径）。
 * 内置技能一组为空就不出标题（没有可列的东西就不留一个空标题）；插件技能一组永远在——
 * 空态说的是"还没有插件带来的技能"，不拿内置技能去填这一组。
 * 口吻克制（用户实拍 #9）：只讲"是什么、来自哪里"，不写实现细节、不写"研发中/待接"这类话。
 */
export interface PluginsSkillsPanelProps {
  /** `plugins:overview` 的 installedSkills（内置与插件一份清单） */
  installedSkills?: readonly InstalledSkillView[]
}

/** 行首图标位（32px、圆角 control、Fills-F2 底；与插件行的头像位同一档）：两组各一枚图标 */
function SkillIcon({ builtin }: { builtin: boolean }): React.JSX.Element {
  const Icon = builtin ? Sparkles : PackageOpen
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-control bg-selected text-ink-secondary"
    >
      <Icon className="size-(--icon-size-md)" />
    </span>
  )
}

/** 技能行：名字 + （插件技能）来自哪个插件；内置技能不给副行——标题已经说明它内置 */
function SkillRow({
  skill,
  builtin
}: {
  skill: InstalledSkillView
  builtin: boolean
}): React.JSX.Element {
  return (
    <div data-testid={`skill-installed-${skill.dir}`} className="flex items-center gap-3 px-3 py-2">
      <SkillIcon builtin={builtin} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-b1 text-ink">{skill.name}</span>
        {builtin || skill.pluginName === null ? null : (
          <span className="truncate text-c1 text-ink-tertiary">来自 {skill.pluginName}</span>
        )}
      </div>
    </div>
  )
}

export function PluginsSkillsPanel({
  installedSkills = []
}: PluginsSkillsPanelProps): React.JSX.Element {
  const builtinSkills = installedSkills.filter((skill) => skill.source === 'builtin')
  const pluginSkills = installedSkills.filter((skill) => skill.source !== 'builtin')

  return (
    <div data-testid="plugins-skills" className="flex flex-col gap-5">
      {builtinSkills.length === 0 ? null : (
        <section data-testid="skills-builtin" className="flex flex-col gap-1">
          <h2 className="px-3 text-b2 font-medium text-ink">内置技能</h2>
          {builtinSkills.map((skill) => (
            <SkillRow key={skill.dir} skill={skill} builtin />
          ))}
        </section>
      )}

      <section data-testid="skills-plugins" className="flex flex-col gap-1">
        <h2 className="px-3 text-b2 font-medium text-ink">插件技能</h2>
        {pluginSkills.length === 0 ? (
          <p data-testid="skills-plugins-empty" className="px-3 text-b2 text-ink-secondary">
            还没有插件带来的技能：去「插件」里安装一个插件。
          </p>
        ) : (
          pluginSkills.map((skill) => <SkillRow key={skill.dir} skill={skill} builtin={false} />)
        )}
      </section>
    </div>
  )
}
