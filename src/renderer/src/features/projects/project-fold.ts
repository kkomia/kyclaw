/**
 * 项目折叠状态（round 16）：按项目 id 记忆"收起了哪些项目"，localStorage 轻量持久
 * （刷新/重启后保留；默认展开 = 不在集合里）。
 *
 * 为什么是 localStorage 而不是设置文件：这是**视图层**的临时偏好（像滚动位置），
 * 进 settings.json 要过 IPC/落盘/迁移一整套，代价与收益不成比例。读写都兜错：
 * 隐私模式/配额满/被禁用时退化成"本次会话的内存态"，不影响任何功能。
 */
const STORAGE_KEY = 'kyclaw.projects.collapsed'

/** 读回收起集合（坏值/读不了都当空集 = 全展开） */
export function readCollapsedProjects(storage?: Pick<Storage, 'getItem'>): ReadonlySet<string> {
  try {
    const raw = (storage ?? window.localStorage).getItem(STORAGE_KEY)
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is string => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

/** 写回收起集合（写不了就静默——折叠状态退化为内存态） */
export function writeCollapsedProjects(
  ids: ReadonlySet<string>,
  storage?: Pick<Storage, 'setItem'>
): void {
  try {
    ;(storage ?? window.localStorage).setItem(STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // 隐私模式 / 配额满：不打扰使用
  }
}
