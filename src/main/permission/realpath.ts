/**
 * 路径逃逸防线（spec §5.1「限定在授权工作区内（realpath 校验，防符号链接逃逸）」，
 * plan Review Focus #1 的安全红线）。所有文件工具都必须先经这里，拿到 `abs` 再去碰文件系统。
 *
 * 规则（每条都有对应用例在 __tests__/realpath.spec.ts）：
 *   1. 目标先做词法归一（`..` 在这一步消掉），再对**最长已存在前缀**做 realpath ——
 *      符号链接与 Windows junction 在 realpath 这一步现形，然后校验结果是否落在工作区的真实路径下；
 *   2. 不存在的那一段只允许"接"在已存在的**真实目录**后面（新建文件要能写，但借道链接不行）；
 *   3. UNC / 设备路径（`\\server\share`、`\\?\C:\`、`\\.\`、正斜杠写法）一律拒绝：
 *      它们绕开盘符归一，工作区不接受，目标与根都是；
 *   4. 拒绝时一律 fail closed（realpath 抛 EPERM 之类也当拒绝）。
 *
 * 返回的 `abs` 是**归一后的路径**：调用方必须拿它去操作文件，不能把原始 target 再交给系统 ——
 * 原始串里的链接与 `..` 由系统解释，词法上与真实语义可能不一致，那是另一条逃逸通道。
 */
import { realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * 用 realpath 的 native 实现：Windows 上它经系统句柄解析，返回**盘上真实大小写**的路径
 * （JS 实现会把调用方给的大小写原样带回来——大小写不同的同一目录会得到两个"不同"的字符串）。
 * 链接（symlink / junction）两者都会解开，native 只是额外把大小写归一，让 abs 可以当稳定键用。
 */
const realPath = realpathSync.native

export type WorkspaceResolution = { ok: true; abs: string } | { ok: false; reason: string }

/**
 * 与 `WorkspaceResolution` 同一结果，但成功时**带出归一后的工作区根**。
 *
 * 为什么需要它：Windows 上同一个目录有长名与 8.3 短名（如 `C:\LMSTUD~1`）两种写法，
 * junction / symlink 根也一样。调用方拿设置里存的原始根（`workspace.path`）去对
 * realpath 后的 `abs` 算 `relative`，会得到 `..\..\...` 这类伪相对路径。这里让根与
 * `abs` 出自**同一次 realpath 判定**，算相对路径 / 判根一律用返回的 `root`。
 */
export type WorkspaceResolutionWithRoot =
  { ok: true; abs: string; root: string } | { ok: false; reason: string }

/** UNC / 设备路径的两种前缀：`\\server`、`//server` 与 `\\?\`、`\\.\`（后者也以双斜杠开头） */
const UNC_PREFIX = /^[\\/]{2}/

export function isUncPath(value: string): boolean {
  return UNC_PREFIX.test(value)
}

/** 拒绝的原因是一句能直接给人/模型看的话（T11 会把它放进工具错误里） */
function deny(reason: string): { ok: false; reason: string } {
  return { ok: false, reason }
}

export function resolveInsideWorkspace(root: string, target: string): WorkspaceResolution {
  const resolved = resolveInsideWorkspaceWithRoot(root, target)
  if (!resolved.ok) return resolved
  return { ok: true, abs: resolved.abs }
}

/**
 * `resolveInsideWorkspace` 的完整版：成功时把 `root`（realpath 归一后的工作区根）一并返回。
 * 两者共用同一段判定；只关心 `abs` 的旧调用方继续用上面那个薄包装。
 */
export function resolveInsideWorkspaceWithRoot(
  root: string,
  target: string
): WorkspaceResolutionWithRoot {
  if (root.length === 0) return deny('工作区路径为空')
  if (isUncPath(root)) return deny('不支持 UNC 工作区')
  if (root.includes('\0')) return deny('工作区路径含非法字符')

  const rootReal = realRoot(root)
  if (typeof rootReal !== 'string') return rootReal

  if (target.length === 0) return deny('目标路径为空')
  if (isUncPath(target)) return deny('不支持 UNC / 设备路径')
  if (target.includes('\0')) return deny('目标路径含非法字符')

  const candidate = isAbsolute(target) ? resolve(target) : resolve(rootReal, target)
  const existing = longestExistingRealpath(candidate)
  if (!existing.ok) return deny(existing.reason)

  if (!isInside(rootReal, existing.real)) return deny('目标路径在工作区之外')
  // 前缀存在但不是目录、后面还接着一段 —— 这是"把文件当目录用"，别放它过去
  if (existing.missing.length > 0 && !isDirectory(existing.real)) {
    return deny('目标路径不是目录')
  }

  const abs =
    existing.missing.length === 0 ? existing.real : join(existing.real, ...existing.missing)
  // 防御性复查：abs 由"已验真的前缀 + 纯名字段"拼出，词法上不可能翻出去
  if (!isInside(rootReal, abs)) return deny('目标路径在工作区之外')
  return { ok: true, abs, root: rootReal }
}

/** 工作区根：必须存在且是目录，返回它的真实路径 */
function realRoot(root: string): string | { ok: false; reason: string } {
  let real: string
  try {
    real = realPath(root)
  } catch {
    return deny('工作区不存在或不是目录')
  }
  if (!isDirectory(real)) return deny('工作区不存在或不是目录')
  return real
}

/**
 * 从 target 往上找**最长的一段已存在路径**，对它 realpath（链接在这里现形），
 * 并把不存在的尾段按顺序收集起来。ENOENT / ENOTDIR 才继续往上；其它错误（权限等）直接拒。
 */
function longestExistingRealpath(
  target: string
): { ok: true; real: string; missing: string[] } | { ok: false; reason: string } {
  let cursor = target
  const missing: string[] = []

  for (;;) {
    try {
      return { ok: true, real: realPath(cursor), missing }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { ok: false, reason: '目标路径不可访问' }

      const parent = dirname(cursor)
      if (parent === cursor) return { ok: false, reason: '目标路径不可访问' }
      missing.unshift(basename(cursor))
      cursor = parent
    }
  }
}

/** candidate 是不是落在 root 里（含 root 自身）。比较交给 path.relative：Windows 上大小写不敏感 */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  // "..\x" 是往上爬；但工作区里真有个叫 "..foo" 的孩子时 relative 也给 "..foo"，那种不算逃逸
  return rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../')
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
