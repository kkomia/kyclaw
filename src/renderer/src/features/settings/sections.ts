import {
  Activity,
  Brain,
  ChartColumn,
  Cpu,
  FolderOpen,
  Info,
  Palette,
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

/** 当前路由的栏目 id：/settings/:section 取第二段，/settings 取默认栏 */
export function settingsSectionFromPath(pathname: string): string {
  const [, root, section] = pathname.split('/')
  if (root !== 'settings') return DEFAULT_SETTINGS_SECTION
  return findSettingsSection(section)?.id ?? DEFAULT_SETTINGS_SECTION
}
