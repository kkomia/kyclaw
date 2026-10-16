/**
 * 「文件」工具的读侧（右侧边栏的文件树 + 快速预览 + 搜索）：**一层一层**列目录、有界读文本、
 * 按文件名 / 按文件内容搜索。
 *
 * 与 `workspace-files.ts`（@ 引用的扁平清单）是一对，口径上的区别：
 *   - 这里是**懒加载**：只列调用方点名的那一层（根 = `''`），子目录等展开时再列 ——
 *     所以不跳 node_modules / .git（用户明确展开它们时应该看得到真内容）；
 *   - 仍然只收真文件与真目录：符号链接 / 设备 / 管道一律不进（避免穿出根、成环）——
 *     与 @ 清单同一条纪律（判据是 `Dirent.isFile/isDirectory`，链接两者都为 false）；
 *   - 条目数有上限（`DIR_ENTRY_LIMIT`），到量即停并如实回 `truncated`。
 *
 * 搜索（`searchWorkspace`）与列目录不同：它**递归**，于是反过来跳过 node_modules / .git，
 * 并且有三重上限（条数 / 单文件扫描量 / 总时长）——见下面那一段的说明。
 *
 * containment 全部经 `resolveInsideWorkspace`：调用方给的是**相对会话根**的路径，
 * 越权（`..` 逃逸、UNC、绝对路径指向根外）一律拒绝并给一句人话。
 */
import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  type Dirent,
  type Stats
} from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DirEntry,
  FileBytesResult,
  FileByteFormat,
  FilePreview,
  ListDirResult,
  TableByteFormat,
  TableBytesResult,
  WorkbenchSearchHit,
  WorkbenchSearchMode,
  WorkbenchSearchResult
} from '../shared/workbench'
import {
  PREVIEW_HTML_MAX_BYTES,
  PREVIEW_IMAGE_MAX_BYTES,
  PREVIEW_OFFICE_MAX_BYTES,
  PREVIEW_PDF_MAX_BYTES,
  PREVIEW_TABLE_MAX_BYTES
} from '../shared/workbench'
import {
  OFFICE_PREVIEW_FAILURE_MESSAGES,
  OfficePreviewError,
  officePreviewSourceKey,
  officePreviewSourceVersion,
  type OfficePreviewErrorCode,
  type OfficePreviewFormat,
  type OfficePreviewPriority,
  type OfficePreviewResult
} from '../shared/office-preview'
import { resolveInsideWorkspace } from './permission/realpath'
import type { OfficePreviewService } from './office-preview'
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

/* ── 搜索（按文件名 / 按文件内容） ────────────────────────────────────────── */

/**
 * 搜索跳过的重型目录（本轮固定口径，不给开关）：版本库与依赖树。
 * 与 listDir 的懒加载口径刻意不同 —— 那里用户明确展开就该看到真内容，这里没人点名，
 * 递归进去只会把时间预算烧在依赖树上。
 */
export const SEARCH_SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git'])

/** 结果总条数上限（到量即停，如实标 `truncated`） */
export const SEARCH_RESULT_LIMIT = 200

/** 单个文件的内容扫描上限（字节）：只看前 1MB，更大的文件按"没扫全"标 `truncated` */
export const SEARCH_FILE_MAX_BYTES = 1024 * 1024

/** 单个文件最多记几条内容命中 */
export const SEARCH_MATCHES_PER_FILE = 20

/** 内容命中的行预览截到多少个字符 */
export const SEARCH_PREVIEW_CHARS = 200

/** 总时长预算（毫秒）：到点就回已收结果（`truncated: true`），不把界面吊死 */
export const SEARCH_TIME_BUDGET_MS = 3000

export interface SearchOptions {
  query: string
  mode: WorkbenchSearchMode
  /** 计时器注入面（测试超时路径用假表；缺省 Date.now） */
  now?: () => number
}

/**
 * 搜索会话根下的文件：
 *   - 递归遍历（只收真文件/真目录，链接不进 —— 与 listDir 同一口径）；读不了的目录/文件跳过不炸；
 *   - `mode='name'` 只看文件名，`mode='content'` 逐行扫文本（读不出来 / 有 NUL 二进制 / 空文件跳过）；
 *   - 大小写不敏感；条数、单文件扫描量、总时长三处都有上限，触到哪一处都如实标 `truncated`。
 */
export function searchWorkspace(root: string, options: SearchOptions): WorkbenchSearchResult {
  const base = resolveInside(root, '')
  const now = options.now ?? Date.now
  const needle = options.query.trim().toLowerCase()
  const deadline = now() + SEARCH_TIME_BUDGET_MS

  const results: WorkbenchSearchHit[] = []
  let scanned = 0
  let truncated = false

  /** 满了 / 超时了：如实标记并停下（结果已经拿到的部分照回） */
  const exhausted = (): boolean => {
    if (results.length >= SEARCH_RESULT_LIMIT || now() > deadline) {
      truncated = true
      return true
    }
    return false
  }

  /** 一个文件的内容命中：读不出来 / 二进制 / 空文件都当"没命中" */
  const collectContent = (path: string, relative: string, name: string): void => {
    const scannedText = textLinesOf(path)
    if (scannedText === null) return
    // 只扫了前 1MB 的大文件：结果不完整，如实标
    if (scannedText.partial) truncated = true

    let recorded = 0
    for (let index = 0; index < scannedText.lines.length; index += 1) {
      if ((index & 0x7f) === 0 && exhausted()) return
      if (recorded >= SEARCH_MATCHES_PER_FILE) {
        truncated = true // 这个文件还有没记下的命中
        return
      }
      const line = scannedText.lines[index] ?? ''
      if (!line.toLowerCase().includes(needle)) continue
      recorded += 1
      results.push({ path: relative, name, line: index + 1, preview: previewOf(line) })
    }
  }

  const walk = (dir: string, relative: string): void => {
    if (exhausted()) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 读不了这一层（权限/竞态）：跳过，不给整轮扣死
    }
    entries.sort(compareDirents)
    for (const entry of entries) {
      if (exhausted()) return
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name)) continue
        walk(join(dir, entry.name), child)
        continue
      }
      if (!entry.isFile()) continue
      scanned += 1
      if (options.mode === 'name') {
        if (entry.name.toLowerCase().includes(needle)) {
          results.push({ path: child, name: entry.name })
        }
        continue
      }
      collectContent(join(dir, entry.name), child, entry.name)
    }
  }

  walk(base, '')
  return { results, truncated, scanned }
}

/** 名字升序（大小写不敏感，与 listDir 的 `compareEntries` 同一口径） */
function compareDirents(a: Dirent, b: Dirent): number {
  const left = a.name.toLowerCase()
  const right = b.name.toLowerCase()
  if (left !== right) return left < right ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** 内容命中的行预览：去掉首尾空白，超长截到 SEARCH_PREVIEW_CHARS 个字符 */
function previewOf(line: string): string {
  const text = line.trim()
  return text.length > SEARCH_PREVIEW_CHARS ? `${text.slice(0, SEARCH_PREVIEW_CHARS)}…` : text
}

/** 一个文件扫出来的文本：`partial` = 文件比扫描上限大（只看了前一段） */
interface ScannedText {
  lines: string[]
  partial: boolean
}

/** 内容扫描用：把这个文件读成文本行（读不了 / 二进制 / 空文件给 null） */
function textLinesOf(path: string): ScannedText | null {
  let stat: Stats
  try {
    stat = statSync(path)
  } catch {
    return null
  }
  const want = Math.min(stat.size, SEARCH_FILE_MAX_BYTES)
  if (want === 0) return null

  let bytes: Buffer
  try {
    bytes = readWhole(path, want)
  } catch {
    return null
  }
  if (bytes.includes(0)) return null // 二进制：不吐乱码，也不假装扫过

  return { lines: decodeText(bytes).split(/\r?\n/), partial: stat.size > want }
}

/* ── 带类型的字节读取（按格式渲染用） ────────────────────────────────────── */

/**
 * 扩展名认路的**期望格式**：渲染端能画的字节格式 + 办公三件 + 表格（csv/tsv）。
 * 后两类不回原始字节，而是回主进程抽好的结构（见 `readFileBytes`）。
 */
type ReadFormat = FileByteFormat | 'docx' | 'xlsx' | 'pptx' | 'table'

/** 渲染端认得（画得出/能安全展示）的扩展名 → 期望格式。不在这里的都算不支持。 */
const EXTENSION_FORMATS: Readonly<Record<string, ReadFormat>> = {
  '.png': 'image-png',
  '.jpg': 'image-jpeg',
  '.jpeg': 'image-jpeg',
  '.gif': 'image-gif',
  '.webp': 'image-webp',
  '.bmp': 'image-bmp',
  '.svg': 'image-svg',
  '.ico': 'image-ico',
  '.pdf': 'pdf',
  '.html': 'html',
  '.htm': 'html',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.pptx': 'pptx',
  '.csv': 'table',
  '.tsv': 'table'
}

/** 走"抽结构"这条路的格式（不回原始字节） */
const OFFICE_FORMATS: ReadonlySet<ReadFormat> = new Set(['docx', 'xlsx', 'pptx', 'table'])

/**
 * **不进** `workbench:open`（用系统默认应用打开）的两族：网页与可脚本化的矢量图。
 *
 * 为什么单独把它们挑出来：`shell.openPath` 在 Windows 上就是 ShellExecute，`.html` 交给默认浏览器
 * = **页面里的脚本真的会跑**（还带 file:// 的本地上下文），`.svg` 里的 `<script>` / `onload` 同理 ——
 * 而工作区里的文件**模型也能写**，这条等于给模型产物配了一条"让用户点一下就跑"的路，与
 * `.js` / `.ps1` 被拒是同一个理由。它们在**预览**里的口径是"永不执行"（见 shared/workbench 的说明：
 * svg 只作 `<img>` 资源、html 走清洗 + sandbox srcdoc），"用本地应用打开"会绕开这套口径。
 * 要看内容：预览里看；要自己打开：用「在文件资源管理器中定位」。
 */
const OPENABLE_EXCLUDED: ReadonlySet<string> = new Set(['.html', '.htm', '.svg'])

/**
 * `workbench:open`（用系统默认应用打开）认的扩展名 —— 交给 ShellExecute 之前的那道闸门。
 *
 * **为什么要有这张表**：工作区里的文件**模型也能写**，而 `shell.openPath` 在 Windows 上走
 * ShellExecute —— `.exe` / `.bat` / `.cmd` / `.ps1` / `.js` / `.vbs` / `.msi` / `.lnk` / `.url` 交
 * 过去就是**执行**或拉起一个动作，等于给模型的产物配了一条"让用户点一下就跑"的路。所以这里只放
 * **人读的文档与媒体**，其余一律拒（人话里指路：要开别的类型先用「在文件资源管理器中定位」）。
 *
 * 开头那一批与预览的 `EXTENSION_FORMATS` **同源**（同一张表展开来的，避免两处各写一份悄悄分叉），
 * 但**减掉 `OPENABLE_EXCLUDED`**（网页与可脚本化 SVG —— 预览里"永不执行"，交给浏览器就等于执行）；
 * 旧版 Office 刻意也在表内：预览明确不支持它们、技能里一直劝"用 Word/Excel/PowerPoint 另存为"，
 * 而"用本机应用打开"正是那件事该走的路。文本一族只收**没有危险默认关联**的那几种
 * （脚本类扩展名一个都不在其中）。
 */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...Object.keys(EXTENSION_FORMATS).filter((extension) => !OPENABLE_EXCLUDED.has(extension)),
  '.doc',
  '.xls',
  '.ppt',
  '.txt',
  '.md',
  '.markdown',
  '.log',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.xml',
  '.rtf'
])

/**
 * 扩展名闸门：不在 `OPENABLE_EXTENSIONS` 里就不放它去见 ShellExecute。
 * 目录另判（打开文件夹是 reveal 的事），containment 与存在性由调用方经 `revealTarget` 过一遍。
 */
export function assertOpenable(relative: string): void {
  const extension = extensionOf(relative)
  if (OPENABLE_EXTENSIONS.has(extension)) return
  throw new Error(
    `不用系统应用打开这类文件（${extension === '' ? '没有扩展名' : extension}）：` +
      '只把文档与媒体（Office 三件 / PDF / 图片 / 表格 / 纯文本）交给本机应用，' +
      '可执行文件、脚本与快捷方式不交给系统。要打开它，请用「在文件资源管理器中定位」自己开。'
  )
}

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

/** 文本族（SVG/HTML）头判定的取样长度：够看到 BOM / XML 声明 / 前导注释 / 首个标签 */
const TEXT_HEAD_BYTES = 512

/**
 * 取"文本头"：按 BOM 解码前若干字节，并剥掉**前导空白、XML 声明、注释**。
 *
 * 为什么要有这一层：`.svg` 常见 `<?xml …?>` 或 BOM 开头、`.html` 常见前导注释，直接拿前几个字节
 * 比首标签会漏判。这里**不做编码嗅探也不做字符集猜测**：只认 BOM 明示的三种
 * —— UTF-8（EF BB BF）、UTF-16LE（FF FE）、UTF-16BE（FE FF）—— 其余解出来就是乱码 → 匹配不上 →
 * 按"不支持"走（fail closed，不猜）。
 * **这一组必须与渲染端的解码口径逐项一致**（见 `dsh-media/html-document.ts` 的 `decodeText`）：
 * 这边认了、那边不认，就会出现"通道放行、界面报读不出来"的分叉。
 */
function textHead(bytes: Buffer): string {
  const slice = bytes.subarray(0, TEXT_HEAD_BYTES)
  let text: string
  if (slice.length >= 3 && slice[0] === 0xef && slice[1] === 0xbb && slice[2] === 0xbf) {
    text = slice.subarray(3).toString('utf8')
  } else if (slice.length >= 2 && slice[0] === 0xff && slice[1] === 0xfe) {
    text = slice.subarray(2).toString('utf16le')
  } else if (slice.length >= 2 && slice[0] === 0xfe && slice[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(slice.subarray(2))
  } else {
    text = slice.toString('utf8')
  }
  text = text.replace(/^\uFEFF/, '').replace(/^\s+/, '')
  for (;;) {
    const before = text
    text = text.replace(/^<\?xml[\s\S]*?\?>\s*/i, '')
    text = text.replace(/^<!--[\s\S]*?-->\s*/, '')
    if (text === before) break
  }
  return text
}

/**
 * SVG 文本头：`<svg …>`（前面可以有 doctype）。**窄判据** —— 不含 `<` 的文本与 csv 一律不匹配。
 */
const SVG_HEAD = /^(?:<!doctype\s+svg[\s>][^>]*>\s*)?<svg[\s>/]/i

/**
 * HTML 文本头：`<!doctype html …>`，或**文档级首标签**（`<html` / `<head` / `<body` / `<meta` / `<title`）。
 * 为什么只认这几个文档级标签、不认"任意 `<` 开头"：那会把 csv / 纯文本里带 `<` 的行也吞进来 ——
 * 表格那条路要求"认不出任何已知格式才算表"，误判会直接把 csv 拒掉（用户点名过的坑）。
 */
const HTML_HEAD =
  /^(?:<!doctype\s+html[\s>][^>]*>\s*)?(?:<html[\s>/]|<head[\s>]|<body[\s>]|<meta[\s>]|<title[\s>])/i

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
  // ICO：头 4 字节 `00 00 01 00`（`.cur` 是 `00 00 02 00`，不认）
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) {
    return 'image-ico'
  }
  // docx / xlsx / pptx 是同一个 zip 头，光看字节分不出是哪一件 —— 由扩展名定名，这里只证"是个 zip"
  if (head(4) === 'PK\x03\x04' || head(4) === 'PK\x05\x06') return 'ooxml'
  // 文本族放最后：二进制那几种在上面就返回了，不会走到这里
  const text = textHead(bytes)
  if (/^<!doctype\s+html[\s>]/i.test(text) || HTML_HEAD.test(text)) return 'html'
  if (SVG_HEAD.test(text)) return 'image-svg'
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
 *   - 超过该格式上限：回 `too-large`（连字节都不传）；图片（含 svg/ico）30MB、PDF 32MB、HTML 8MB；
 *   - 扩展名不认得 / 头与扩展名对不上：回 `unsupported`（渲染端回落二进制占位）；
 *   - 图片 / PDF / HTML：回 `bytes`（渲染端：图片走 `<img>` 的 data URL、PDF 走 pdfjs、
 *     HTML 清洗后进 sandbox srcdoc —— 见 shared/workbench 的说明）；
 *     办公三件与 csv/tsv：**在主进程抽好结构**再回（docx/xlsx/pptx），抽不通抛中文人话
 *     （能过两道闸的文件再读不通，就是它坏了，不该含糊成"二进制"）。
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
    expected === 'html'
      ? PREVIEW_HTML_MAX_BYTES
      : expected === 'pdf'
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

/* ── 有界读（办公档转换与表格原始字节共用） ──────────────────────────────── */

/** 一个文件在某一刻的身份：只取两个判据（大小 + mtime）——与 `officePreviewSourceVersion` 同一口径 */
export interface FileStamp {
  size: number
  mtimeMs: number
}

/**
 * 一次有界读的结果。`regular: false` = **句柄上**看到的不是常规文件（目录 / 设备 / 管道之类）：
 * 调用方必须把它当"这次读不成立"，别去读 `bytes`。
 */
export type BoundedFileRead =
  | { regular: false }
  | {
      regular: true
      /** 读到的字节（**最多** limit 个；文件比 limit 大时就是 limit 个） */
      bytes: Buffer
      /** 打开时句柄上的身份 */
      opened: FileStamp
      /** 读完时句柄上的身份；与 `opened` 不同 = 这份字节不是一份稳定快照 */
      settled: FileStamp
    }

/**
 * 末段符号链接的拒绝标记：**只在 POSIX 上给 O_NOFOLLOW**（那边它是标准行为）。
 * Windows 上 libuv 不映射这一位、行为没法在本轮证实（跑不了测试），所以不给 ——
 * 那边靠调用方"读前后各判一次真实路径 + 句柄身份"兜。
 */
const NO_FOLLOW = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW

/**
 * 有界读一个文件：**最多读 limit 字节**，并交回读前/读后的句柄身份。
 *
 * 它管的是"**这一份句柄**读到了什么"（常规文件、有界、同一份快照、可取消）；
 * **路径在授权之后有没有被换掉不归它管** —— 那由调用方在读取前后各解一次真实路径
 * （见 `stillTheSameFile`）。两层分开，是因为"打开的那份是什么"与"路径现在指着谁"
 * 是两个不同的判据，混在一起会互相掩盖。
 */
export async function readFileBounded(
  path: string,
  limit: number,
  signal?: AbortSignal
): Promise<BoundedFileRead> {
  signal?.throwIfAborted()
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile()) return { regular: false }
    const want = Math.max(0, Math.min(before.size, limit))
    const buffer = Buffer.alloc(want)
    let read = 0
    while (read < want) {
      signal?.throwIfAborted()
      const chunk = await handle.read(buffer, read, want - read, read)
      if (chunk.bytesRead === 0) break
      read += chunk.bytesRead
    }
    const after = await handle.stat()
    return {
      regular: true,
      bytes: buffer.subarray(0, read),
      opened: { size: before.size, mtimeMs: before.mtimeMs },
      settled: { size: after.size, mtimeMs: after.mtimeMs }
    }
  } finally {
    await handle.close()
  }
}

/** stat 一次（失败给 null：电话簿式的"文件没了"是常态，不该抛） */
function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

/**
 * "现在这条路径还是授权时那条真实路径、且还是一条常规文件吗"。
 * 读取**前后各判一次**：授权之后才出现的链接 / 目录 / 置换在这里现形（fail closed）。
 */
function stillTheSameFile(root: string, relative: string, target: string): boolean {
  const again = resolveInsideWorkspace(root, relative)
  if (!again.ok || again.abs !== target) return false
  const info = statOrNull(target)
  return info !== null && info.isFile() && !info.isSymbolicLink()
}

/** 打开/读取的当口文件没了或被换掉：这些是"这次读不成立"，不是"这份文件转不了" */
const READ_REFUSED_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR'])

function readRefused(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && READ_REFUSED_CODES.has(code)
}

/** 一次"文件在变"的拒绝（办公档那条路用；表格那条路回 `changed`） */
function sourceChanged(): OfficePreviewError {
  return new OfficePreviewError('source-changed', OFFICE_PREVIEW_FAILURE_MESSAGES['source-changed'])
}

/* ── 表格原始字节通道（xls / xlsx / csv / tsv） ──────────────────────────── */

/**
 * 表格原始字节通道认的后缀 → 格式。**刻意与 `EXTENSION_FORMATS` 分开**：
 * 那张表是 `read-bytes`（老消费者：表格预览 / 二进制占位）的合同，往里面加 .xls 会改变那些
 * 消费者收到的形状；这一条新通道自己认自己的四种后缀，两边互不影响。
 */
const TABLE_EXTENSION_FORMATS: Readonly<Record<string, TableByteFormat | undefined>> = {
  '.xls': 'xls',
  '.xlsx': 'xlsx',
  '.csv': 'csv',
  '.tsv': 'tsv'
}

/** 旧版 Office 的 OLE 复合文档头（与 `mastra/tools/read.ts`、`office-legacy.ts` 同一个 8 字节魔数） */
const OLE_HEAD = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

function hasOleHead(bytes: Buffer): boolean {
  return bytes.length >= OLE_HEAD.length && bytes.subarray(0, OLE_HEAD.length).equals(OLE_HEAD)
}

/**
 * 读一个表格文件的**原始字节**（xls / xlsx / csv / tsv），给要在渲染端自己解析工作簿的预览用。
 *
 * 与 `readFileBytes` 的分工：那条把 xlsx/csv 在主进程抽成 `PreviewSheet` 结构（既有消费者按那个
 * 形状读），这条只回字节。后缀 + 文件头双重判定（xls 必须 OLE、xlsx 必须 zip、csv/tsv 不能是
 * 别的已知二进制）。
 *
 * **读不准就当没读**：读前/读后各解一次真实路径（授权之后才出现的链接、被置换、被删都要现形），
 * 再比三次身份（授权时的 stat vs 打开时 vs 读完时）与字节数 —— 任何一处对不上回 `changed`，
 * **不交半截快照、也不交别处那份文件的字节**。
 */
export async function readTableBytes(root: string, relative: string): Promise<TableBytesResult> {
  const target = resolveInside(root, relative)

  const initial = statOrNull(target)
  if (initial === null) return { kind: 'missing' }
  if (initial.isDirectory()) throw new Error('这是一个文件夹：展开它，或单击一个文件预览')

  const expected = TABLE_EXTENSION_FORMATS[extensionOf(relative)]
  if (expected === undefined) return { kind: 'unsupported', size: initial.size }
  if (initial.isSymbolicLink()) return { kind: 'changed' }
  if (!initial.isFile()) return { kind: 'unsupported', size: initial.size }
  if (initial.size > PREVIEW_TABLE_MAX_BYTES) {
    return { kind: 'too-large', size: initial.size, limit: PREVIEW_TABLE_MAX_BYTES }
  }

  if (!stillTheSameFile(root, relative, target)) return { kind: 'changed' }
  let read: BoundedFileRead
  try {
    read = await readFileBounded(target, PREVIEW_TABLE_MAX_BYTES)
  } catch (cause) {
    if (readRefused(cause)) return { kind: 'changed' }
    throw cause
  }
  if (!stillTheSameFile(root, relative, target)) return { kind: 'changed' }
  if (
    !read.regular ||
    read.opened.size !== initial.size ||
    read.opened.mtimeMs !== initial.mtimeMs ||
    read.settled.size !== read.opened.size ||
    read.settled.mtimeMs !== read.opened.mtimeMs ||
    read.bytes.length !== read.opened.size
  ) {
    return { kind: 'changed' }
  }

  const bytes = read.bytes
  const sniffed = sniffFormat(bytes)
  if (expected === 'xls') {
    if (!hasOleHead(bytes)) return { kind: 'unsupported', size: initial.size }
  } else if (expected === 'xlsx') {
    if (sniffed !== 'ooxml') return { kind: 'unsupported', size: initial.size }
  } else if (sniffed !== null) {
    // csv/tsv 没有 magic：只要不长得像别的已知格式（改名的图片/压缩包/网页/矢量图/可执行文件）就收
    return { kind: 'unsupported', size: initial.size }
  }

  // 复制成普通 Uint8Array：Buffer 是 Uint8Array 的子类，但过 IPC 的应该是干净的那一种
  return { kind: 'bytes', format: expected, bytes: new Uint8Array(bytes), size: initial.size }
}

/* ── 办公档页式预览（doc / docx / ppt / pptx → PDF）──────────────────────── */

/** 页式预览认的后缀（带点写法；与 `OFFICE_PREVIEW_FORMATS` 同一个集合） */
const OFFICE_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set(['.doc', '.docx', '.ppt', '.pptx'])

/** 一个分类失败 → 回包里的那一支（人话从共享那张表取，口径只住一处） */
function officeFailure(
  relative: string,
  code: OfficePreviewErrorCode,
  message?: string
): OfficePreviewResult {
  return {
    kind: 'failed',
    path: relative,
    code,
    message: message ?? OFFICE_PREVIEW_FAILURE_MESSAGES[code]
  }
}

/**
 * 引擎要的那一次读：读前后各复验一次真实路径，再比三次身份。
 *
 * 交回去的版本**只可能是授权时那个** —— 对不上（读的时候文件被改/被换/被删）一律抛
 * `source-changed`，绝不把一份与授权版本不符的字节交给引擎（那会转出一份"谁也不知道是哪版"的 PDF）。
 */
async function readOfficeSource(
  root: string,
  relative: string,
  target: string,
  authorizedVersion: string,
  signal: AbortSignal,
  maxBytes: number
): Promise<{ bytes: Uint8Array; version: string }> {
  signal.throwIfAborted()
  if (!stillTheSameFile(root, relative, target)) throw sourceChanged()

  let read: BoundedFileRead
  try {
    read = await readFileBounded(target, maxBytes + 1, signal)
  } catch (cause) {
    if (readRefused(cause)) throw sourceChanged()
    throw cause
  }
  signal.throwIfAborted()
  if (!stillTheSameFile(root, relative, target)) throw sourceChanged()

  // 一次读要同时成立的四件事：是常规文件、读前读后是同一份、字节数与身份对得上、且与授权版本一致
  if (!read.regular) throw sourceChanged()
  if (
    read.settled.size !== read.opened.size ||
    read.settled.mtimeMs !== read.opened.mtimeMs ||
    read.bytes.length !== Math.min(read.opened.size, maxBytes + 1) ||
    officePreviewSourceVersion(read.opened) !== authorizedVersion
  ) {
    throw sourceChanged()
  }

  return { bytes: new Uint8Array(read.bytes), version: authorizedVersion }
}

/**
 * 把一个**已授权**的办公档转成 PDF（授权与"读的是不是同一份"都在这里；引擎那侧只认字节、不认路径）。
 *
 * 顺序：containment（越权抛人话，fail closed）→ 后缀白名单 → 存在性 / 目录 / 链接 / 大小上限 →
 * 交给引擎（源就是 `readOfficeSource`，那里读前后各再验一次）。
 * **命中缓存也要先过前面几道**：别名表按（授权键, 版本, 后缀）判，键与版本都来自本次 stat。
 * 取消（`signal` 响了）回 `cancelled`，不 reject：取消是用户自己的动作。
 */
export async function convertOfficeToPdf(
  root: string,
  relative: string,
  priority: OfficePreviewPriority,
  preview: OfficePreviewService,
  signal: AbortSignal
): Promise<OfficePreviewResult> {
  const target = resolveInside(root, relative)
  // containment 永远先判（越权路径不许因为"这一路已取消"变得不可见），之后才看中止
  if (signal.aborted) return officeFailure(relative, 'cancelled')

  const extension = extensionOf(relative)
  if (!OFFICE_PREVIEW_EXTENSIONS.has(extension)) {
    return officeFailure(relative, 'unsupported-format')
  }
  const before = statOrNull(target)
  if (before === null || before.isSymbolicLink()) {
    // 不存在 = 树是旧的；**已经是符号链接** = `resolveInside` 给的是真实路径，说明刚被换过
    return officeFailure(relative, before === null ? 'missing' : 'source-changed')
  }
  if (before.isDirectory()) throw new Error('这是一个文件夹：展开它，或单击一个文件预览')
  if (!before.isFile()) return officeFailure(relative, 'invalid-document')
  if (before.size > PREVIEW_OFFICE_MAX_BYTES) {
    // 前置闸门用工作台既有的办公档上限（32MB，与 read-bytes 同档）：连读都不读
    return officeFailure(relative, 'input-too-large')
  }

  const version = officePreviewSourceVersion(before)
  try {
    const result = await preview.convert(
      {
        extension: extension.slice(1) as OfficePreviewFormat,
        priority,
        source: {
          key: officePreviewSourceKey(root, relative, target),
          version,
          bytes: before.size,
          read: (readSignal, maxBytes) =>
            readOfficeSource(root, relative, target, version, readSignal, maxBytes)
        }
      },
      signal
    )
    return {
      kind: 'pdf',
      path: relative,
      version,
      // 拷一份普通 Uint8Array：回包 schema 的 `z.instanceof(Uint8Array)` 推出来是 `Uint8Array<ArrayBuffer>`，
      // 而引擎给的字节来自 Buffer/子数组（ArrayBufferLike）。这次拷贝也在"过 IPC 前"，结构化克隆本来就要拷一遍。
      pdf: Uint8Array.from(result.pdf),
      size: result.pdf.byteLength,
      missingFonts: result.missingFonts,
      generation: result.generation
    }
  } catch (cause) {
    if (signal.aborted) return officeFailure(relative, 'cancelled')
    if (cause instanceof OfficePreviewError) {
      return officeFailure(relative, cause.code, cause.message)
    }
    throw cause
  }
}
