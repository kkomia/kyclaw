/**
 * 一级模块（0.2.0 应用壳）：主对话 / 笔记 / 知识库 / Office / 导图。
 * 只看路径的第一段，所以 `/notes/...` 这样的后续深链仍归笔记模块；
 * 设置 / 插件 / 记忆 / 用量不是一级模块，返回 null（不参与模块宿主与一级选中态）。
 */
export const PRIMARY_MODULE_IDS = ['chat', 'notes', 'knowledge', 'office', 'mindmap'] as const

export type PrimaryModuleId = (typeof PRIMARY_MODULE_IDS)[number]

export function primaryModuleOf(pathname: string): PrimaryModuleId | null {
  const segment = pathname.split('/')[1] ?? ''
  return (PRIMARY_MODULE_IDS as readonly string[]).includes(segment)
    ? (segment as PrimaryModuleId)
    : null
}
