/**
 * **文本分页**（工作台预览的"加载更多"）：一页一页地把一份文本读完，不交半截、不混版本。
 *
 * 与既有 `workbench-files.ts` 那条文本通道（`readFilePreview`，一次读完 64KB）的分工：
 * 那条是"快速看一眼"（@ 引用、附件、搜索预览都还用它），这条是**预览里的完整阅读**：
 * 有界字节 + 行游标、UTF-8 边界、版本校验、超长单行上限、显式 EOF/错误。
 *
 * 安全与纪律（与其它工作台读通道同源）：
 *   - 会话根只在 IPC 层解析（`rootOf(threadId)`），这里只收**绝对路径 + 相对路径**；
 *   - containment 走 `resolveInsideWorkspace`（越权/穿出一律抛人话，fail closed）；
 *   - 只读**常规文件**（目录抛人话；设备/管道/链接这类不读），末段符号链接在 POSIX 上不给跟进
 *     （`O_NOFOLLOW`），Windows 上靠"读前读后各解一次真实路径 + 句柄身份"兜（与表格通道同口径）；
 *   - **不落任何跨请求状态**：没有 watcher、没有缓存、没有 fd 常开 —— 一次调用开一次、关一次，
 *     渲染端卸载即自然清算（轮询在渲染端，间隔由它自己清理）。
 *
 * 页边界口径（渲染端把各页**直接拼接**就是原文，一个字节都不差）：
 *   1. 一窗最多 `TEXT_PAGE_MAX_BYTES`；窗里最后一个 `\n` 之后就是本页终点（含这个换行）；
 *   2. 窗里没有 `\n` 且已经到文件尾 → 这一页就是尾巴（`eof`）；
 *   3. 窗里没有 `\n` 且没到文件尾 → 超长单行：按 `TEXT_PAGE_MAX_LINE_BYTES` 切开，
 *      从 UTF-8 字符边界上收（`trimIncompleteTail`），置 `overlongLine`；
 *   4. 页里出现 NUL → 第一页回 `binary`、续读回 `changed`（内容已经不是那份文本了）。
 */
import { constants as fsConstants, lstatSync, type Stats } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { officePreviewSourceVersion } from '../shared/office-preview'
import {
  TEXT_FILE_MAX_BYTES,
  TEXT_PAGE_MAX_BYTES,
  TEXT_PAGE_MAX_LINE_BYTES,
  type TextPageCursor,
  type TextPageResult,
  type TextVersionResult
} from '../shared/workbench-text'
import { resolveInsideWorkspace } from './permission/realpath'
import { trimIncompleteTail } from './workbench-files'

/** 文件没了 / 被换成目录 / 打开被拒：这些是"这次读不成立"，不是"这份文件有问题" */
const READ_REFUSED_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR'])

/**
 * 末段符号链接的拒绝标记：**只在 POSIX 上给 O_NOFOLLOW**（那边它是标准行为）。
 * Windows 上 libuv 不映射这一位、行为没法在本轮证实（跑不了测试），所以不给 ——
 * 那边靠"读前读后各解一次真实路径 + 句柄身份"兜（与 `workbench-files.ts` 同一口径）。
 */
const NO_FOLLOW = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW

/** stat 一次（失败给 null：电话簿式的"文件没了"是常态，不该抛） */
function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/**
 * containment：与其它工作台通道同一把闸门、同一句人话（越权抛，fail closed）。
 * 前辍与 `workbench-files.ts` 的 `resolveInside` 一致（"路径不可用：…"），渲染端与用例都按它做判据。
 */
function resolveTextTarget(root: string, relative: string): string {
  const resolution = resolveInsideWorkspace(root, relative === '' ? '.' : relative)
  if (!resolution.ok) throw new Error(`路径不可用：${resolution.reason}`)
  return resolution.abs
}

/** 读前读后各解一次真实路径：授权之后才出现的链接 / 被置换 / 被删都在这儿现形 */
function stillTheSameFile(root: string, relative: string, target: string): boolean {
  const again = resolveInsideWorkspace(root, relative)
  if (!again.ok || again.abs !== target) return false
  const info = statOrNull(target)
  return info !== null && info.isFile() && !info.isSymbolicLink()
}

/** 一页的切片结果（`nextOffset` 一定大于 `offset`：不会原地踏步） */
interface PageSlice {
  text: string
  nextOffset: number
  overlongLine: boolean
}

/**
 * 把这一窗字节切成"一页"。
 * @param bytes 已经读到的窗口（长度 ≤ `TEXT_PAGE_MAX_BYTES`）。
 * @param offset 这一窗的起点（文件内字节偏移）。
 * @param size 读的时候看到的文件大小。
 * @returns 页文本、下一页起点、是否因超长行切开。
 */
function slicePage(bytes: Buffer, offset: number, size: number): PageSlice {
  const lastNewline = bytes.lastIndexOf(0x0a)
  if (lastNewline >= 0) {
    // 常规：收到最后一个换行（含它）——下一页从行首开始
    const cut = lastNewline + 1
    return {
      text: bytes.subarray(0, cut).toString('utf8'),
      nextOffset: offset + cut,
      overlongLine: false
    }
  }

  // 窗里没有换行：到了文件尾就是尾巴；没到就是"这一行比一页还长"
  if (offset + bytes.length >= size) {
    return {
      text: bytes.toString('utf8'),
      nextOffset: offset + bytes.length,
      overlongLine: false
    }
  }

  const candidate = bytes.subarray(0, Math.min(bytes.length, TEXT_PAGE_MAX_LINE_BYTES))
  const clipped = trimIncompleteTail(candidate)
  // 防御：极端情况下（窗口里全是续字节）trim 会退化成空 —— 那就用未修剪的那一份，
  // 保证每页至少推进若干字节，渲染端不会卡在"加载更多"上原地打转。
  const used = clipped.length === 0 ? candidate : clipped
  return { text: used.toString('utf8'), nextOffset: offset + used.length, overlongLine: true }
}

/**
 * 读一页文本。
 * @param root 会话根（绝对路径；由 IPC 层解析）。
 * @param relative 相对会话根的路径（正反斜杠都认）。
 * @param cursor `null` = 第一页；否则是上一页给的 `{ offset, version }`（版本不符回 `changed`）。
 * @returns 一页文本或显式的失败判别（越权路径抛）。
 */
export async function readTextPage(
  root: string,
  relative: string,
  cursor: TextPageCursor | null
): Promise<TextPageResult> {
  const target = resolveTextTarget(root, relative)

  const initial = statOrNull(target)
  if (initial === null) return { kind: 'missing' }
  if (initial.isDirectory()) throw new Error('这是一个文件夹：展开它，或单击一个文件预览')
  if (!initial.isFile()) return { kind: 'binary', size: initial.size }
  if (initial.size > TEXT_FILE_MAX_BYTES) {
    return { kind: 'too-large', size: initial.size, limit: TEXT_FILE_MAX_BYTES }
  }
  // 首读也要对一次"我现在看到的是不是你手里那个版本"（lstat 与打开之间可能被换）
  if (cursor !== null && cursor.version !== officePreviewSourceVersion(initial)) {
    return { kind: 'changed' }
  }

  let handle: FileHandle
  try {
    handle = await open(target, fsConstants.O_RDONLY | NO_FOLLOW)
  } catch (cause) {
    if (readRefused(cause)) return { kind: 'missing' }
    throw new Error(`读不了这个文件：${cause instanceof Error ? cause.message : String(cause)}`)
  }

  try {
    const before = await handle.stat()
    if (!before.isFile()) return { kind: 'binary', size: before.size }
    const openedVersion = officePreviewSourceVersion(before)
    if (cursor !== null && cursor.version !== openedVersion) return { kind: 'changed' }

    const offset = cursor?.offset ?? 0
    if (offset > before.size) return { kind: 'changed' }

    const want = Math.min(TEXT_PAGE_MAX_BYTES, before.size - offset)
    const buffer = Buffer.alloc(want)
    let read = 0
    while (read < want) {
      const chunk = await handle.read(buffer, read, want - read, offset + read)
      if (chunk.bytesRead === 0) break
      read += chunk.bytesRead
    }
    const after = await handle.stat()
    // 读的当口在变：这一份不是稳定快照，不交（渲染端重读即可）
    if (officePreviewSourceVersion(after) !== openedVersion) return { kind: 'changed' }
    // 授权之后路径被换掉 / 被删 / 变成链接：同样不交
    if (!stillTheSameFile(root, relative, target)) return { kind: 'changed' }

    const bytes = buffer.subarray(0, read)
    if (bytes.includes(0)) {
      return cursor === null ? { kind: 'binary', size: before.size } : { kind: 'changed' }
    }

    const slice = slicePage(bytes, offset, before.size)
    const nextOffset = Math.min(slice.nextOffset, before.size)
    return {
      kind: 'page',
      text: slice.text,
      offset,
      nextOffset,
      size: before.size,
      version: openedVersion,
      eof: nextOffset >= before.size,
      overlongLine: slice.overlongLine
    }
  } finally {
    await handle.close()
  }
}

/** 打开/读取的当口文件没了或被换掉（与 `workbench-files.ts` 同一组码） */
function readRefused(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && READ_REFUSED_CODES.has(code)
}

/**
 * 只 stat 一次：文件现在的版本与大小（给"文件变了没有"的轮询用；不读正文）。
 * @param root 会话根（绝对路径）。
 * @param relative 相对会话根的路径。
 * @returns 版本 + 大小；文件没了回 `missing`（目录/越权抛人话）。
 */
export function textVersionOf(root: string, relative: string): TextVersionResult {
  const target = resolveTextTarget(root, relative)
  const info = statOrNull(target)
  if (info === null) return { kind: 'missing' }
  if (info.isDirectory()) throw new Error('这是一个文件夹：展开它，或单击一个文件预览')
  return { kind: 'version', version: officePreviewSourceVersion(info), size: info.size }
}
