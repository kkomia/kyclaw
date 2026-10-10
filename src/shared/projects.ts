/**
 * 项目工作区（T18）：项目元素 schema + 会话↔项目映射的跨端契约。
 *
 * 项目（Project）= 用户显式建的一块工作区：`侧栏「项目」新建空白项目 / 使用现有文件夹`。
 * 它有两个落点：
 *   1. **清单**落 settings.json 的 `projects`（唯一事实来源，与 providers/workspaces 同路）；
 *   2. **会话归属**（哪个会话属于哪个项目）落 libsql 的 `session_projects` 表 —— 会话本体
 *      （线程/消息）就在那份 libsql 里，映射跟它同库同寿命（见 mastra/session-projects.ts）。
 *
 * 形状约束：路径与名称的**业务**校验（存在、是目录、非 UNC、重复）在主进程（main/projects.ts），
 * 这里只管跨边界形状 —— 与 shared/settings.ts 的 workspaces 同一分工。
 *
 * 工具权限（T10/T11）不受这里影响：项目路径在创建时经 `checkWorkspacePath` 归一后**进授权列表**
 * （模式一律 `ask`，full 只能由用户在设置页显式切换），文件工具实际能碰的范围见
 * main/projects.ts 的 `sessionRoots`。
 */
import { z } from './zod'

/** 一个项目（settings.json 的 projects 元素） */
export const projectSchema = z.strictObject({
  id: z.string().min(1),
  /** 显示名（侧栏用）；首尾空白在入库前已 trim */
  name: z.string().min(1),
  /** 项目目录的**归一后**绝对路径（checkWorkspacePath 的 realpath 写法） */
  path: z.string().min(1),
  /** ISO 时间串（列表排序用） */
  createdAt: z.string()
})

export type Project = z.infer<typeof projectSchema>

/**
 * 会话↔项目映射的**单条写**（PUT /api/projects/mappings 的入参）：
 * projectId = null 表示把这个会话从项目里摘出来（回到"未指定项目"）。
 */
export const sessionProjectRequestSchema = z.strictObject({
  threadId: z.string().min(1),
  projectId: z.string().min(1).nullable()
})

export type SessionProjectRequest = z.infer<typeof sessionProjectRequestSchema>

/** 映射的一条（GET /api/projects/mappings 的回包元素） */
export const sessionProjectEntrySchema = z.strictObject({
  threadId: z.string().min(1),
  projectId: z.string().min(1)
})

export type SessionProjectEntry = z.infer<typeof sessionProjectEntrySchema>

/** GET /api/projects/mappings 的回包 */
export const sessionProjectListSchema = z.strictObject({
  sessions: z.array(sessionProjectEntrySchema)
})

export type SessionProjectList = z.infer<typeof sessionProjectListSchema>

/**
 * 空白项目的候选路径：基底 + 同名子目录（渲染端对话框的默认值也用它，见 CreateProjectDialog）。
 * 与 main/projects.ts 的 `projectDefaultPath` 同一算法，只是这里不引 node:path（渲染端）。
 * 反斜杠是 Windows 口径：真实落盘的那一份会被主进程的 realpath 归一。
 */
export function joinProjectPath(base: string, name: string): string {
  const trimmedBase = base.replace(/[\\/]+$/, '')
  const trimmedName = name.trim()
  return trimmedName === '' ? trimmedBase : `${trimmedBase}\\${trimmedName}`
}
