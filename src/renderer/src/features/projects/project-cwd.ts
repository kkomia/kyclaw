/**
 * 0.2.2：内核 session 的 cwd → 它属于哪个项目（侧栏「项目」区的归组口径）。
 *
 * 为什么要在渲染端算一遍：旧会话↔项目映射的宿主 API（`/api/projects/mappings`）在 0.2.x
 * 主动下架（501），但会话本体自带"在哪个目录下跑"这个事实（`GET /api/threads` 的
 * `thread.cwd` ← 内核 `session/list` 的 `items[].cwd`）。侧栏因此不再依赖映射表：
 * 拿 cwd 反查 `settings.projects` 的路径包含关系，命中哪个项目就归到哪个项目。
 * 主进程解析会话根用的是同一份事实（agent/service.ts 的 `projectIdOf` 也用内核 cwd 反查
 * projects），两边口径一致，显示与工具权限不会各说各话。
 *
 * 归一化口径（Windows 是主目标，POSIX 路径按大小写敏感处理）：
 *   - 斜杠 `/` 与反斜杠 `\` 视作同一个分隔符（内核 cwd 与 settings 里 realpath 过的项目路径
 *     可能一边正斜杠一边反斜杠）；
 *   - 盘符 / UNC 路径大小写不敏感（Windows），比较前转小写；POSIX 路径保持原样；
 *   - 去掉尾部分隔符后再比；
 *   - 前缀匹配必须落在路径边界上（`D:\foo` 不匹配 `D:\foobar`，那是两个目录）；
 *   - 多个项目都包含该 cwd 时取**路径最长**的那个（= 最具体的项目，嵌套项目时口径唯一）。
 *
 * 纯函数，不碰 store / 网络：单测直接喂数据（见 project-cwd.spec.ts）。
 */
import type { Project } from '@shared/projects'
import type { ThreadSummary } from '@shared/threads'

/** 只关心 id + path：Project 之外（测试夹件）也够用 */
export type CwdProject = Pick<Project, 'id' | 'path'>

/** 看起来像 Windows 路径（盘符 / UNC / 已带反斜杠）——决定分隔符与大小写口径 */
function isWindowsLike(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/u.test(path) || path.startsWith('\\\\') || path.includes('\\')
}

/** 归一化一条目录路径（去空白、统一分隔符、去尾分隔符、Windows 转小写）；空串回空串 */
export function normalizeCwdPath(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '') return ''
  const windows = isWindowsLike(trimmed)
  const normalized = windows
    ? trimmed.replace(/\//gu, '\\').replace(/\\+$/u, '')
    : trimmed.replace(/\/+$/u, '')
  // 根路径（`D:\` / `/`）去尾后会空：补回分隔符，保证与自身比较仍能命中
  if (normalized === '') return windows ? '\\' : '/'
  return windows ? normalized.toLowerCase() : normalized
}

/**
 * cwd 落在哪个项目里：没有命中回 null；命中多个取路径最长的（最具体项目）。
 *
 * 只认 settings.projects 里**路径非空**的项目——空路径项目没有任何可归的目录。
 */
export function projectIdForCwd(cwd: string, projects: readonly CwdProject[]): string | null {
  const normalizedCwd = normalizeCwdPath(cwd)
  if (normalizedCwd === '') return null

  let best: { id: string; length: number } | null = null
  for (const project of projects) {
    const normalizedProject = normalizeCwdPath(project.path)
    if (normalizedProject === '') continue
    const separator = normalizedProject.includes('\\') ? '\\' : '/'
    const prefix = normalizedProject.endsWith(separator)
      ? normalizedProject
      : `${normalizedProject}${separator}`
    const within = normalizedCwd === normalizedProject || normalizedCwd.startsWith(prefix)
    if (!within) continue
    if (best === null || normalizedProject.length > best.length) {
      best = { id: project.id, length: normalizedProject.length }
    }
  }
  return best?.id ?? null
}

/**
 * 线程列表 → `{ threadId: projectId }`（只收 cwd 能归到现有项目的那些）。
 *
 * 没有 cwd / cwd 不落在任何项目里 = 无项目（侧栏「任务」组）；不猜、不按默认工作区兜底。
 */
export function deriveProjectMappings(
  threads: readonly Pick<ThreadSummary, 'id' | 'cwd'>[],
  projects: readonly CwdProject[]
): Record<string, string> {
  const mappings: Record<string, string> = {}
  for (const thread of threads) {
    const cwd = thread.cwd
    if (cwd === undefined || cwd.trim() === '') continue
    const projectId = projectIdForCwd(cwd, projects)
    if (projectId !== null) mappings[thread.id] = projectId
  }
  return mappings
}
