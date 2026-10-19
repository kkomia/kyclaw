/**
 * 一级模块（0.2.0 应用壳）：主对话 / 笔记 / 知识库 / Office / 导图。
 * 只看路径的第一段，所以 `/notes/...` 这样的后续深链仍归笔记模块；
 * 设置 / 插件 / 记忆 / 用量不是一级模块，返回 null（不参与模块宿主与一级选中态）。
 */
export const PRIMARY_MODULE_IDS = ['chat', 'notes', 'knowledge', 'office', 'mindmap'] as const

export type PrimaryModuleId = (typeof PRIMARY_MODULE_IDS)[number]

/**
 * PB-037：一级入口可见性（用户 2026-10-19：「笔记知识库 导图部分现在先隐藏…只隐藏入口，代码功能那些都在」）。
 *
 * **只影响左侧边栏入口**：路由、页面、lazy chunk、深链全部保留（`#/mindmap`、`/notes`、`/knowledge`
 * 仍可直达）。打开某个模块 = 把这里改回 `true`，不用动其它代码。
 * 这里用常量的原因：一处开关、可被测试直接断言；不引入运行时设置项（本轮范围只有隐藏入口）。
 */
export const PRIMARY_MODULE_VISIBILITY: Readonly<Record<PrimaryModuleId, boolean>> = {
  chat: true,
  notes: false,
  knowledge: false,
  office: true,
  // 导图（Pele）0.1.5 首版仍在早期：先不给入口，功能与深链保留
  mindmap: false
}

/** 该模块的左侧边栏入口是否可见（路由可达性不看这个） */
export function isPrimaryModuleVisible(id: PrimaryModuleId): boolean {
  return PRIMARY_MODULE_VISIBILITY[id]
}

export function primaryModuleOf(pathname: string): PrimaryModuleId | null {
  const segment = pathname.split('/')[1] ?? ''
  return (PRIMARY_MODULE_IDS as readonly string[]).includes(segment)
    ? (segment as PrimaryModuleId)
    : null
}
