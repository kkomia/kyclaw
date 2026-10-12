/**
 * 无项目会话的落点（round 55，对齐 Kimi Work）：默认工作区只是"产房"——
 * 每个无项目会话在它下面占一个自己的子目录（该会话的文件工具根、文件区、终端都落这里），
 * 而不是把文件直接堆在默认工作区根里。有项目的会话不适用（根就是项目目录）。
 *
 * 路径规则：`<默认工作区>/tasks/<threadId 前 8 位>`——只由默认工作区与 threadId 决定：
 *   - 主进程（会话根解析）与渲染端（显示 / 复制路径 / 附件相对路径）共用这一份，绝不各写一份；
 *   - 无时间戳、无持久化：同一个会话任何时候算出的路径都一样（跨重启稳定）；
 *   - `tasks` 这一层把"会话任务目录"与用户自有内容隔开（与 Kimi 的 tasks/ 同形）。
 */

/** 任务目录的父级名字（位于默认工作区之下） */
export const SESSION_DIR_PARENT = 'tasks'

/** 单个会话目录名：threadId 前 8 位（小写；uuid 前 8 位足够桌面单机场景唯一） */
export function sessionDirNameOf(threadId: string): string {
  return threadId.slice(0, 8).toLowerCase()
}

/** 会话在默认工作区下的绝对落点；分隔符跟随默认工作区的写法（Windows 反斜杠 / POSIX 斜杠） */
export function sessionDirOf(defaultWorkspace: string, threadId: string): string {
  const trimmed = defaultWorkspace.replace(/[\\/]+$/, '')
  const separator = trimmed.includes('\\') ? '\\' : '/'
  return `${trimmed}${separator}${SESSION_DIR_PARENT}${separator}${sessionDirNameOf(threadId)}`
}
