import { FilePen, FilePlus, FileText, FolderSearch, Search } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * 插件页「技能」面板（R2 round 5）：内置能力的**只读**清单。
 * 口吻克制（用户实拍 #9）：只讲"能做什么"，不写实现细节、不写"研发中/待接"这类话；
 * 也没有开关——内置技能随应用提供，不由用户启停。
 */
interface SkillSpec {
  name: string
  description: string
  icon: LucideIcon
}

const SKILLS: SkillSpec[] = [
  { name: '读取文件', description: '查看工作区里文件的内容。', icon: FileText },
  { name: '查找文件', description: '按名字模式找到工作区里的文件。', icon: FolderSearch },
  { name: '搜索内容', description: '在工作区文件里搜一段文字。', icon: Search },
  { name: '写入文件', description: '在工作区里新建或覆盖文件。', icon: FilePlus },
  { name: '修改文件', description: '对已有文件做局部修改。', icon: FilePen }
]

export function PluginsSkillsPanel(): React.JSX.Element {
  return (
    <div data-testid="plugins-skills" className="flex flex-col gap-1">
      {SKILLS.map((skill) => {
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
