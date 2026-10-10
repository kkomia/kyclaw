import { FilePen, FilePlus, FileText, FolderSearch, Search, type LucideIcon } from 'lucide-react'

/**
 * 内置技能清单（只读）：插件页「技能」tab 与本机能力的说明性列表；
 * composer 的「引用技能」菜单也读这一份（round 7 起从 PluginsSkillsPanel 抽出来共用）。
 * 这些是 kyclaw 内建的文件工具能力，不随用户开关变化——没有"停用某技能"这回事。
 */
export interface SkillSpec {
  name: string
  description: string
  icon: LucideIcon
}

export const BUILTIN_SKILLS: readonly SkillSpec[] = [
  { name: '读取文件', description: '查看工作区里文件的内容。', icon: FileText },
  { name: '查找文件', description: '按名字模式找到工作区里的文件。', icon: FolderSearch },
  { name: '搜索内容', description: '在工作区文件里搜一段文字。', icon: Search },
  { name: '写入文件', description: '在工作区里新建或覆盖文件。', icon: FilePlus },
  { name: '修改文件', description: '对已有文件做局部修改。', icon: FilePen }
]
