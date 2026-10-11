/**
 * 工作区文件清单（round 15）：给输入框 `@` 引用用的**有界**文件列表。
 *
 * 只读、只列相对路径（正斜杠），不打开文件、不跟随符号链接（避免穿出根 / 成环）：
 *   - 条目上限 `WORKSPACE_LIST_LIMIT`（1500），深度上限 `WORKSPACE_LIST_MAX_DEPTH`（8）；
 *   - 跳过常见大目录（node_modules / .git / dist / out / .venv / __pycache__ 等）与所有点目录；
 *   - 目录本身不进列表（v1 只列文件）；顺序按名字稳定排序，便于过滤结果的稳定呈现。
 * 会话根由调用方按 sessionRoots 同口径解析（main/ipc/workspace.ts）——这里只负责"列"。
 */
import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { join } from 'node:path'

/** 条目上限（到量即停；排序仍是逐目录稳定序） */
export const WORKSPACE_LIST_LIMIT = 1500

/** 深度上限：根的子项算第 1 层（`src/renderer/x.ts` 是 3 层） */
export const WORKSPACE_LIST_MAX_DEPTH = 8

/** 跳过的大目录（点目录另有一刀：目录名以 `.` 开头一律不进） */
export const WORKSPACE_FILE_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'vendor'
])

/**
 * 列 `root` 下的文件（相对路径、正斜杠）。读不了的目录静默跳过（权限/竞态不炸整表）；
 * 根不存在/不是目录 → 抛一句人话（调用方转给渲染端）。`limit` / `maxDepth` 可注入（测试用）。
 */
export function listWorkspaceFiles(
  root: string,
  limit: number = WORKSPACE_LIST_LIMIT,
  maxDepth: number = WORKSPACE_LIST_MAX_DEPTH
): string[] {
  if (!existsSync(root)) throw new Error(`工作区目录不存在：${root}`)
  const files: string[] = []

  const walk = (dir: string, relative: string, depth: number): void => {
    if (files.length >= limit || depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (files.length >= limit) return
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || WORKSPACE_FILE_SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name), child, depth + 1)
      } else if (entry.isFile()) {
        files.push(child)
      }
      // 其余（符号链接 / 设备 / 管道）一律不进：清单只收真文件
    }
  }

  walk(root, '', 1)
  return files
}
