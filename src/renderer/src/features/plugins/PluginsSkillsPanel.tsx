import { BUILTIN_SKILLS } from './skills'

/**
 * 插件页「技能」面板（R2 round 5）：内置能力的**只读**清单。
 * 口吻克制（用户实拍 #9）：只讲"能做什么"，不写实现细节、不写"研发中/待接"这类话；
 * 也没有开关——内置技能随应用提供，不由用户启停。
 * 清单本身在 plugins/skills.ts（round 7 起与 composer 的「引用技能」菜单共用一份）。
 */
export function PluginsSkillsPanel(): React.JSX.Element {
  return (
    <div data-testid="plugins-skills" className="flex flex-col gap-1">
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
    </div>
  )
}
