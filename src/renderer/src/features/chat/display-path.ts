import { relativeInRoot } from './composer-attachments'

/**
 * 路径的**展示口径**（round 85，用户实报 013：编辑工作区内文件时页面上显示的是文件的绝对路径，
 * 内容太长）——会话根内的文件显示**工作区相对路径**，根外原样显示绝对路径。
 *
 * 为什么只用一条纯函数：这个转换必须与附件、文件树、@ 引用**同一套路径数学**（大小写不敏感、
 * 按路径段边界比较、尾部分隔符先去掉）。那套规则只有 `composer-attachments.ts` 的 `relativeInRoot`
 * 一处实现，这里直接复用它，不再写第二份（口径多处实现是既有的 P1 缺陷）。
 *
 * 边界：
 *   - 会话根由调用方从**既有根解析**里拿（`sessionRootPathOf` / `useWorkbenchRoot`），这里不猜；
 *   - 根判不出（`null`）或路径在根外 / 不是路径 → 原样返回，绝不因为展示把模型看到的路径改掉；
 *   - 含 `.` / `..` 段的路径**不做相对化**（见 `hasDotSegment`）；
 *   - 只用于**界面展示**：工具回执文本、发给模型的入参一个字不动（见 ToolCard 的调用点）。
 */

/**
 * 路径里有没有 `.` / `..` 段。`relativeInRoot` 是纯词法比较、不解析这两段，于是
 * `D:\ws\..\secret\a.txt` 会命中 `D:\ws\` 前缀、被显示成 `../secret/a.txt` —— 一个**根外**文件
 * 看起来像在工作区里。展示层不替用户做归一化（那是主进程真解析干的事，见 `main/permission/realpath.ts`），
 * 遇到这种路径就保守地原样显示绝对路径。
 *
 * 按**段**判（不是子串）：`D:\ws\..hidden\a.md` 里的 `..hidden` 是个正常名字，照常相对化。
 */
function hasDotSegment(path: string): boolean {
  return path.split(/[\\/]+/).some((segment) => segment === '.' || segment === '..')
}

export function displayPath(path: string, root: string | null | undefined): string {
  if (path === '') return path
  if (hasDotSegment(path)) return path
  return relativeInRoot(path, root) ?? path
}
