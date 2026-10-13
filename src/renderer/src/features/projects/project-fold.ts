/**
 * 侧栏导航的折叠状态（round 16 项目；round 61 起「任务」组共用；round 64 起「项目」组头也共用）：
 * 按 id 记忆"收起了哪些"，localStorage 轻量持久（刷新/重启后保留；默认展开 = 不在集合里）。
 *
 * 为什么是 localStorage 而不是设置文件：这是**视图层**的临时偏好（像滚动位置），
 * 进 settings.json 要过 IPC/落盘/迁移一整套，代价与收益不成比例。读写都兜错：
 * 隐私模式/配额满/被禁用时退化成"本次会话的内存态"，不影响任何功能。
 *
 * 一份存储、多个写入方（项目行各自 + 「任务」组 + 「项目」组头）：id 用项目 id，
 * 另有两个保留 id —— `TASKS_FOLD_ID` 归「任务」组、`PROJECTS_FOLD_ID` 归「项目」组头。
 * **写入前先重新读**（toggleCollapsed / 各自的读-改-写），
 * 否则一个组用自己的旧快照写回，会把另一组刚记下的收起项抹掉。
 */
const STORAGE_KEY = 'kyclaw.projects.collapsed'

/** 「任务」组（没有项目的会话）在折叠集合里的保留 id（不是真实的项目 id） */
export const TASKS_FOLD_ID = '__tasks__'

/** 「项目」组头（整组收起/展开）在折叠集合里的保留 id（不是真实的项目 id） */
export const PROJECTS_FOLD_ID = '__projects__'

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

/**
 * 收起 / 展开一个 id 并落盘，返回新集合。
 * 先读后写（不拿调用方的内存快照当底）：与项目行共用同一份存储时，各自的最新状态不会被覆盖。
 */
export function toggleCollapsed(
  id: string,
  storage?: Pick<Storage, 'getItem'> & Pick<Storage, 'setItem'>
): ReadonlySet<string> {
  const next = new Set(readCollapsedProjects(storage))
  if (next.has(id)) next.delete(id)
  else next.add(id)
  writeCollapsedProjects(next, storage)
  return next
}
