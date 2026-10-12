/**
 * 内置插件（round 48）：随应用常驻的能力，**不来自任何插件市场**，因此也没有安装 / 卸载
 * 这一套状态——「插件」栏里它与市场来的插件并列，但那份安装态逻辑碰不到它。
 *
 * 这张表是唯一出处：插件页的标签计数按它算（计数 = 这一栏列出的插件行数），
 * 行与详情面在 PluginsBuiltinPanel 里按同一个 id 挂。
 */
export interface BuiltinPlugin {
  id: string
  name: string
  description: string
}

export const BUILTIN_PLUGINS: readonly BuiltinPlugin[] = [
  { id: 'web-search', name: '联网搜索', description: '搜索网页并读取正文' }
]
