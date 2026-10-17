import {
  Activity,
  Archive,
  Brain,
  ChartColumn,
  Cpu,
  FolderOpen,
  Info,
  Palette,
  Sparkles,
  type LucideIcon
} from 'lucide-react'

/**
 * 设置页的栏目表（唯一来源）：左侧设置菜单、内容区、路由 /settings/:section 都读这一份。
 * 顺序 = 菜单顺序；id 进 URL，改 id 等于改深链，别随手改。
 * 图标按现有功能分组各给一个（lucide 组件，尺寸由菜单项统一给 18 档）。
 *
 * round 5 变更：撤掉「工具与 MCP」栏 —— MCP 管理迁到主页侧栏的「插件」（/plugins），
 * 设置为唯一导航源、插件页为 MCP/技能的进入点；旧的 /settings/tools 深链会回落默认栏。
 * T17 追加两栏：「追踪」（Langfuse，默认关）与「关于」（版本与更新）——都是显式配置项，
 * 放在设置里而不是首页菜单（雷点 3）。
 *
 * 本轮（设置页重组）：撤掉单独的「约束」栏 —— 约束并进「记忆」栏（那一栏现在依次是语义召回 /
 * 记忆空间 / 记忆指令，见 SettingsPage 的 memory 分支）。**旧 id 不能直接删**：/settings/rules
 * 是发出去的深链（E2E 也在用），走下面的 SECTION_ALIASES 落到「记忆」栏，不掉到默认栏。
 */
export interface SettingsSection {
  id: string
  label: string
  /** 左侧菜单项的 data-testid（R4） */
  navTestId: string
  /** 内容区（栏目卡片组）的 data-testid：沿用 T5 起的 settings-group-* */
  groupTestId: string
  icon: LucideIcon
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: 'appearance',
    label: '外观',
    navTestId: 'settings-nav-appearance',
    groupTestId: 'settings-group-appearance',
    icon: Palette
  },
  {
    /* task-58：动效（照抄 DSH claude-style 的「动画效果」面板；深链 /settings/motion） */
    id: 'motion',
    label: '动效',
    navTestId: 'settings-nav-motion',
    groupTestId: 'settings-group-motion',
    icon: Sparkles
  },
  {
    id: 'model',
    label: '模型',
    navTestId: 'settings-nav-model',
    groupTestId: 'settings-group-model',
    icon: Cpu
  },
  {
    id: 'workspaces',
    label: '工作区',
    navTestId: 'settings-nav-workspaces',
    groupTestId: 'settings-group-workspaces',
    icon: FolderOpen
  },
  {
    id: 'memory',
    label: '记忆',
    navTestId: 'settings-nav-memory',
    groupTestId: 'settings-group-memory',
    icon: Brain
  },
  {
    id: 'usage',
    label: '用量',
    navTestId: 'settings-nav-usage',
    groupTestId: 'settings-group-usage',
    icon: ChartColumn
  },
  {
    id: 'archived',
    label: '归档',
    navTestId: 'settings-nav-archived',
    groupTestId: 'settings-group-archived',
    icon: Archive
  },
  {
    id: 'tracing',
    label: '追踪',
    navTestId: 'settings-nav-tracing',
    groupTestId: 'settings-group-tracing',
    icon: Activity
  },
  {
    id: 'about',
    label: '关于',
    navTestId: 'settings-nav-about',
    groupTestId: 'settings-group-about',
    icon: Info
  }
]

/** /settings（不带栏目）落到哪一栏 */
export const DEFAULT_SETTINGS_SECTION = SETTINGS_SECTIONS[0].id

/** 某个 id 是不是有效栏目（URL 里的脏值一律回落默认栏，不让内容区空着） */
export function findSettingsSection(id: string | undefined): SettingsSection | undefined {
  return SETTINGS_SECTIONS.find((section) => section.id === id)
}

/**
 * 老深链的别名：栏目合并后，旧 id 指向它现在并进的那一栏。
 * 与 SETTINGS_SECTIONS 里的 id 一样进过 URL —— 删栏目不等于让老地址失效。
 */
const SECTION_ALIASES: Record<string, string> = {
  // 「约束」并进「记忆」栏（菜单只剩「记忆」一项）
  rules: 'memory'
}

/** 当前路由的栏目 id：/settings/:section 取第二段（旧 id 先过别名），/settings 取默认栏 */
export function settingsSectionFromPath(pathname: string): string {
  const [, root, section] = pathname.split('/')
  if (root !== 'settings') return DEFAULT_SETTINGS_SECTION
  const id = section === undefined ? section : (SECTION_ALIASES[section] ?? section)
  return findSettingsSection(id)?.id ?? DEFAULT_SETTINGS_SECTION
}
