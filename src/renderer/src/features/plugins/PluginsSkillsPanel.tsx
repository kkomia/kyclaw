import { PackageOpen } from 'lucide-react'
import type { InstalledSkillView } from '@shared/plugins'
import { BUILTIN_SKILLS } from './skills'

/**
 * 插件页「技能」面板：两块——**已安装（来自插件）**（round 10）与**内置技能**（只读清单）。
 * 已安装区读主进程扫出的 `<userData>/skills/` 目录（装插件时复制进去的）；没有就空态一行。
 * 口吻克制（用户实拍 #9）：只讲"能做什么"，不写实现细节、不写"研发中/待接"这类话。
 */
export interface PluginsSkillsPanelProps {
  /** 从插件安装进来的技能（`plugins:overview` 的 installedSkills） */
  installedSkills?: readonly InstalledSkillView[]
}

export function PluginsSkillsPanel({
  installedSkills = []
}: PluginsSkillsPanelProps): React.JSX.Element {
  return (
    <div data-testid="plugins-skills" className="flex flex-col gap-5">
      <section className="flex flex-col gap-1">
        <h2 className="px-3 text-b2 font-medium text-ink">已安装（来自插件）</h2>
        {installedSkills.length === 0 ? (
          <p data-testid="skills-installed-empty" className="px-3 text-b2 text-ink-secondary">
            还没有从插件装进来的技能：去「插件」里安装一个插件。
          </p>
        ) : (
          installedSkills.map((skill) => (
            <div
              key={skill.dir}
              data-testid={`skill-installed-${skill.dir}`}
              className="flex items-center gap-3 px-3 py-2"
            >
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-control bg-secondary text-ink-secondary"
              >
                <PackageOpen className="size-(--icon-size-md)" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-b1 text-ink">{skill.name}</span>
                <span className="truncate text-c1 text-ink-tertiary">
                  {skill.pluginName === null ? '来自插件' : `来自 ${skill.pluginName}`}
                </span>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h2 className="px-3 text-b2 font-medium text-ink">内置技能</h2>
        {BUILTIN_SKILLS.map((skill) => {
          const Icon = skill.icon
          return (
            <div key={skill.name} className="flex items-center gap-3 px-3 py-2.5">
              <span
                aria-hidden="true"
                className="flex size-8 shrink-0 items-center justify-center rounded-control bg-secondary text-ink-secondary"
              >
                <Icon className="size-(--icon-size-md)" />
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-b1 text-ink">{skill.name}</span>
                <span className="text-c1 text-ink-secondary">{skill.description}</span>
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}
