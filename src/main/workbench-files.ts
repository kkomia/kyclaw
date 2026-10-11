/**
 * 「文件」工具的读侧（右侧边栏的文件树 + 快速预览）：**一层一层**列目录、有界读文本。
 *
 * 与 `workspace-files.ts`（@ 引用的扁平清单）是一对，口径上的区别：
 *   - 这里是**懒加载**：只列调用方点名的那一层（根 = `''`），子目录等展开时再列 ——
 *     所以不跳 node_modules / .git（用户明确展开它们时应该看得到真内容）；
 *   - 仍然只收真文件与真目录：符号链接 / 设备 / 管道一律不进（避免穿出根、成环）——
 *     与 @ 清单同一条纪律（判据是 `Dirent.isFile/isDirectory`，链接两者都为 false）；
 *   - 条目数有上限（`DIR_ENTRY_LIMIT`），到量即停并如实回 `truncated`。
 *
 * containment 全部经 `resolveInsideWorkspace`：调用方给的是**相对会话根**的路径，
 * 越权（`..` 逃逸、UNC、绝对路径指向根外）一律拒绝并给一句人话。
 */
import {
  closeSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  type Dirent,
  type Stats
} from 'node:fs'
import { join } from 'node:path'
import type {
  DirEntry,
  FileBytesResult,
  FileByteFormat,
  FilePreview,
  ListDirResult
} from '../shared/workbench'
import {
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_OFFICE_MAX_BYTES,
  PREVIEW_PDF_MAX_BYTES
} from '../shared/workbench'
import { resolveInsideWorkspace } from './permission/realpath'
import {
  CSV_TEXT_MAX_BYTES,
  extractDocx,
  extractPptx,
  extractXlsx,
  parseTableText
} from './workbench-office'

/** 一层目录最多回多少条（超大目录如实截断） */
export const DIR_ENTRY_LIMIT = 2000

/** 文本预览的读取上限（字节）：超过就只给头部（`truncated: true`） */
export const PREVIEW_BYTES = 64 * 1024

/** 预览的硬上限（字节）：再大连头部都不值得传，直接给「过大」判别结果 */
export const PREVIEW_MAX_BYTES = 5 * 1024 * 1024

/**
 * 绝对路径解析（唯一的 containment 入口）：相对路径以会话根为基准，越权给人话。
 * `relative === ''` = 根本身（列目录时用，必须存在且是目录）。
 */
function resolveInside(root: string, relative: string): string {
  const resolved = resolveInsideWorkspace(root, relative === '' ? '.' : relative)
  if (!resolved.ok) throw new Error(`路径不可用：${resolved.reason}`)
  return resolved.abs
}

/**
 * stat 一次，失败翻成人话。
 * 为什么不让 `resolveInsideWorkspace` 兜住：它允许"不存在的尾段"（文件工具要能在不存在的
 * 路径上新建文件），所以工作台这条只读的路必须自己判一次存在性，别把 Node 的原始 ENOENT 抛给界面。
 */
function statPresent(path: string, missing: string): Stats {
  try {
    return statSync(path)
  } catch {
    throw new Error(missing)
  }
}

const DIR_GONE = '这个文件夹不在磁盘上了（可能刚被删除或改名）'
const FILE_GONE = '这个文件不在磁盘上了（可能刚被删除或改名）'

/** 排序：目录在前，然后按名字（大小写不敏感；同名不同大小写再按原串，保证稳定） */
function compareEntries(a: DirEntry, b: DirEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
  const left = a.name.toLowerCase()
  const right = b.name.toLowerCase()
  if (left !== right) return left < right ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * 列一层目录。`relative` 是相对会话根的路径（正斜杠或反斜杠都认，`''` = 根）。
 * 读不了的条目（权限/竞态）跳过，不给整层扣死；目录不存在/不是目录给人话。
 */
export function listDir(root: string, relative: string): ListDirResult {
  const dir = resolveInside(root, relative)

  const stat = statPresent(dir, DIR_GONE)
  if (!stat.isDirectory()) throw new Error('这不是文件夹：只能展开文件夹，文件用单击预览')

  let read: Dirent[]
  try {
    read = readdirSync(dir, { withFileTypes: true })
  } catch (cause) {
    throw new Error(`读不了这个文件夹：${cause instanceof Error ? cause.message : String(cause)}`)
  }

  const entries: DirEntry[] = []
  for (const entry of read) {
    if (entries.length >= DIR_ENTRY_LIMIT) break
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, kind: 'dir', size: 0 })
    } else if (entry.isFile()) {
      entries.push({ name: entry.name, kind: 'file', size: sizeOf(join(dir, entry.name)) })
    }
  }
  entries.sort(compareEntries)

  return { entries, truncated: read.length > entries.length }
}

/** 单个文件的字节数：stat 失败给 0（只是一个显示用的数字，不值得为它整层失败） */
function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * 读一个文件做预览（有界）：
 *   - 超过 `PREVIEW_MAX_BYTES` → `too-large`（连头部都不传）；
 *   - 读到的字节里有 NUL → `binary`（不吐乱码）；
 *   - 否则按 UTF-8 解码回文本，超过 `PREVIEW_BYTES` 时截断（并收在字符边界上）。
 */
export function readFilePreview(
  root: string,
  relative: string,
  maxBytes: number = PREVIEW_BYTES
): FilePreview {
  const target = resolveInside(root, relative)

  const stat = statPresent(target, FILE_GONE)
  if (stat.isDirectory()) throw new Error('这是一个文件夹：展开它，或单击一个文件预览')
  if (stat.size > PREVIEW_MAX_BYTES) return { kind: 'too-large', size: stat.size }

  const want = Math.min(stat.size, maxBytes)
  const buffer = Buffer.alloc(want)
  let read = 0
  const fd = openSync(target, 'r')
  try {
    while (read < want) {
      const chunk = readSync(fd, buffer, read, want - read, read)
      if (chunk <= 0) break
      read += chunk
    }
  } finally {
    closeSync(fd)
  }

  const bytes = buffer.subarray(0, read)
  if (bytes.includes(0)) return { kind: 'binary', size: stat.size }

  const truncated = stat.size > read
  const clipped = truncated ? trimIncompleteTail(bytes) : bytes
  return { kind: 'text', text: clipped.toString('utf8'), size: stat.size, truncated }
}

/**
 * 截断点收在 UTF-8 字符边界上（不吐半个汉字）：从尾部回看最多 3 个字节，
 * 遇到续字节（10xxxxxx）继续往前，遇到首字节就按它声明的长度判完整与否。
 */
export function trimIncompleteTail(bytes: Buffer): Buffer {
  const max = Math.min(4, bytes.length)
  for (let back = 1; back <= max; back += 1) {
    const byte = bytes[bytes.length - back]
    if (byte === undefined) break
    if ((byte & 0x80) === 0) return bytes // ASCII：本身就是一个完整字符
    if ((byte & 0xc0) === 0x80) continue // 续字节：继续往前找首字节
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2
    return back === need ? bytes : bytes.subarray(0, bytes.length - back)
  }
  return bytes
}

/**
 * 交给系统文件资源管理器的那条绝对路径（目录直接打开 / 文件定位到它）。
 * containment 同口径；目录不存在给人话。
 */
export function revealTarget(root: string, relative: string): string {
  const target = resolveInside(root, relative)
  statPresent(target, FILE_GONE) // 不存在就在这里抛，别让 shell 那边给一个含糊的失败
  return target
}

/* ── 带类型的字节读取（按格式渲染用） ────────────────────────────────────── */

/**
 * 扩展名认路的**期望格式**：渲染端能画的字节格式 + 办公三件 + 表格（csv/tsv）。
 * 后两类不回原始字节，而是回主进程抽好的结构（见 `readFileBytes`）。
 */
type ReadFormat = FileByteFormat | 'docx' | 'xlsx' | 'pptx' | 'table'

/** 渲染端认得（画得出）的扩展名 → 期望格式。不在这里的都算不支持。 */
const EXTENSION_FORMATS: Readonly<Record<string, ReadFormat>> = {
  '.png': 'image-png',
  '.jpg': 'image-jpeg',
  '.jpeg': 'image-jpeg',
  '.gif': 'image-gif',
  '.webp': 'image-webp',
  '.bmp': 'image-bmp',
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
  '.csv': 'table',
  '.tsv': 'table'
}

/** 走"抽结构"这条路的格式（不回原始字节） */
const OFFICE_FORMATS: ReadonlySet<ReadFormat> = new Set(['docx', 'xlsx', 'pptx', 'table'])

/** 取小写扩展名（正反斜杠都认；没有扩展名给空串） */
function extensionOf(relative: string): string {
  const base = relative.slice(Math.max(relative.lastIndexOf('/'), relative.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}

/** 文件名（不含路径），csv/tsv 抽出来当表名用 */
function baseNameOf(relative: string): string {
  return relative.slice(Math.max(relative.lastIndexOf('/'), relative.lastIndexOf('\\')) + 1)
}

/** 文件头判定（magic bytes）：认不出给 null —— 调用方据此判"扩展名与内容对不上" */
export function sniffFormat(bytes: Buffer): FileByteFormat | 'ooxml' | null {
  const head = (length: number): string => bytes.subarray(0, length).toString('latin1')
  if (head(5) === '%PDF-') return 'pdf'
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image-png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image-jpeg'
  }
  const gif = head(6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image-gif'
  if (head(4) === 'RIFF' && head(12).slice(8) === 'WEBP') return 'image-webp'
  if (head(2) === 'BM') return 'image-bmp'
  // docx / xlsx / pptx 是同一个 zip 头，光看字节分不出是哪一件 —— 由扩展名定名，这里只证"是个 zip"
  if (head(4) === 'PK\x03\x04' || head(4) === 'PK\x05\x06') return 'ooxml'
  return null
}

/**
 * 读满整个文件（调用方已按上限拦过；短读按实际读到的算）
 */
function readWhole(path: string, size: number): Buffer {
  const buffer = Buffer.alloc(size)
  const fd = openSync(path, 'r')
  try {
    let read = 0
    while (read < size) {
      const chunk = readSync(fd, buffer, read, size - read, read)
      if (chunk <= 0) break
      read += chunk
    }
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

/**
 * 读一个文件的字节（给"按格式渲染"的预览用）：扩展名认路 + 文件头对暗号，两者都对上才回结果。
 *   - 越界路径：**抛**（fail closed，与其余工作台通道同口径）；
 *   - 文件没了：回 `missing`（这是常态：树是旧的，点下去文件已经被删了），不抛；
 *   - 目录：抛人话（调用方按扩展名路由，正常到不了这里）；
 *   - 超过该格式上限：回 `too-large`（连字节都不传）；
 *   - 扩展名不认得 / 头与扩展名对不上：回 `unsupported`（渲染端回落二进制占位）；
 *   - 图片/PDF：回 `bytes`；办公三件与 csv/tsv：**在主进程抽好结构**再回（docx/xlsx/pptx），
 *     抽不通抛中文人话（能过两道闸的文件再读不通，就是它坏了，不该含糊成"二进制"）。
 *
 * 因为办公档的解包（mammoth / exceljs）是异步的，这条通道整体是 async：IPC 那侧 await 它。
 */
export async function readFileBytes(root: string, relative: string): Promise<FileBytesResult> {
  const target = resolveInside(root, relative)

  let stat: Stats
  try {
    stat = statSync(target)
  } catch {
    return { kind: 'missing' }
  }
  if (stat.isDirectory()) throw new Error('这是一个文件夹：展开它，或单击一个文件预览')

  const expected = EXTENSION_FORMATS[extensionOf(relative)]
  if (expected === undefined) return { kind: 'unsupported', size: stat.size }

  const limit =
    expected === 'pdf'
      ? PREVIEW_PDF_MAX_BYTES
      : OFFICE_FORMATS.has(expected)
        ? PREVIEW_OFFICE_MAX_BYTES
        : PREVIEW_IMAGE_MAX_BYTES
  if (stat.size > limit) return { kind: 'too-large', size: stat.size, limit }

  // csv/tsv：只读头部就够（解析前先截到 2MB），不把 32MB 全拉进内存
  const whole = expected === 'table' ? Math.min(stat.size, CSV_TEXT_MAX_BYTES) : stat.size
  const bytes = readWhole(target, whole)
  const sniffed = sniffFormat(bytes)

  if (expected === 'table') {
    // csv/tsv 没有 magic：要求"不是别的已知二进制格式"（改名的图片/压缩包一律拒）
    if (sniffed !== null) return { kind: 'unsupported', size: stat.size }
    const name = baseNameOf(relative)
    const sheet = parseTableText(
      decodeText(bytes),
      name.replace(/\.[^.]*$/, ''),
      extensionOf(relative) === '.tsv' ? '\t' : ','
    )
    if (stat.size > whole) sheet.truncated = true
    return { kind: 'xlsx', sheets: [sheet], truncated: false }
  }

  if (expected === 'docx' || expected === 'xlsx' || expected === 'pptx') {
    if (sniffed !== 'ooxml') return { kind: 'unsupported', size: stat.size }
    if (expected === 'docx') {
      const { markdown, truncated } = await extractDocx(bytes)
      return { kind: 'docx', markdown, truncated }
    }
    if (expected === 'xlsx') {
      const { sheets, truncated } = await extractXlsx(bytes)
      return { kind: 'xlsx', sheets, truncated }
    }
    const { slides, truncated } = extractPptx(bytes)
    return { kind: 'pptx', slides, truncated }
  }

  // 头与扩展名对不上（改名的可执行文件之类）：不猜、不画，按不支持走
  if (sniffed !== expected) return { kind: 'unsupported', size: stat.size }

  // 复制成普通 Uint8Array：Buffer 是 Uint8Array 的子类，但过 IPC 的应该是干净的那一种
  return { kind: 'bytes', format: expected, bytes: new Uint8Array(bytes), size: stat.size }
}

/** 截断点收在 UTF-8 字符边界上（与文本通道同一口径：不吐半个汉字） */
function decodeText(bytes: Buffer): string {
  return trimIncompleteTail(bytes).toString('utf8')
}
