/**
 * 知识库存储（M5）：本地文本资料的**真实实现**。
 *
 * 数据布局（plan §2.2，全部在 `userData/knowledge/` 下）：
 *   - `index.json`：`{ version: 1, documents: [{ id, title, originalPath, size, ext, addedAt,
 *     updatedAt, charCount, truncated }] }`（原子写：`index.json.tmp` → rename）；
 *     `truncated` 是内部字段（IPC 契约的 KnowledgeDoc 不带它，readText 的 truncated 由它回）；
 *   - `files/<id>.<ext>`：导入时复制的原字节（**原文件不动**；删除只删库内这三处）；
 *   - `text/<id>.txt`：UTF-8 解码后的纯文本（> KNOWLEDGE_TEXT_MAX 截断；搜索与预览用）。
 *
 * 纪律：
 *   - 只收 shared/knowledge.ts 白名单里的文本扩展名；单文件 ≤ 5 MB、单次 ≤ 20 个；
 *   - 含 NUL 字节 / 非 UTF-8 一律拒绝并在 `skipped` 里给**人话原因**（不静默吞）；
 *   - 搜索在主进程内做（大小写不敏感子串，snippet ±60 字，上限 50），不把整库文本发给渲染端；
 *   - index 缺失/损坏时**自愈**：按 `files/` 里还在的文件重建（title 退回 id、来源路径记库里路径）。
 *
 * 纯 Node（**不 import electron**）：目录由调用方注入（`userDataDir` → `knowledgeDirOf`），可单测。
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
  KNOWLEDGE_EXCERPT_MAX,
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_IMPORT_MAX_FILES,
  KNOWLEDGE_SEARCH_LIMIT,
  KNOWLEDGE_TEXT_EXTENSIONS,
  KNOWLEDGE_TEXT_MAX,
  type KnowledgeDoc,
  type KnowledgeImportResult,
  type KnowledgeRenameInput,
  type KnowledgeSearchHit,
  type KnowledgeSkipped
} from '../shared/knowledge'

/** 知识库数据目录：`userData/knowledge` */
export function knowledgeDirOf(userDataDir: string): string {
  return join(userDataDir, 'knowledge')
}

/** 索引文件：`userData/knowledge/index.json` */
export function knowledgeIndexPath(knowledgeDir: string): string {
  return join(knowledgeDir, 'index.json')
}

/** 复制进来的原字节目录：`userData/knowledge/files` */
export function knowledgeFilesDir(knowledgeDir: string): string {
  return join(knowledgeDir, 'files')
}

/** 抽取文本目录：`userData/knowledge/text` */
export function knowledgeTextDir(knowledgeDir: string): string {
  return join(knowledgeDir, 'text')
}

/** index.json 里的一条（内部形状 = KnowledgeDoc + truncated） */
export interface KnowledgeIndexEntry {
  id: string
  title: string
  originalPath: string
  size: number
  ext: string
  addedAt: string
  updatedAt: string
  charCount: number
  /** 导入时是否因超过 2 MB 被截断（readText 的 truncated 由它回） */
  truncated: boolean
}

/** index.json 的形状（v1） */
export interface KnowledgeIndex {
  version: 1
  documents: KnowledgeIndexEntry[]
}

/** 白名单查询（小写、不带点；handler / 测试共用同一份） */
export function isKnowledgeExtension(ext: string): boolean {
  return (KNOWLEDGE_TEXT_EXTENSIONS as readonly string[]).includes(ext)
}

/** 白名单的人话（skipped reason / 空态说明共用） */
export function knowledgeExtensionListText(): string {
  return KNOWLEDGE_TEXT_EXTENSIONS.join(' / ')
}

/** 空索引（自愈/测试用） */
export function emptyKnowledgeIndex(): KnowledgeIndex {
  return { version: 1, documents: [] }
}

/** 库里文件路径 */
function filePathOf(knowledgeDir: string, entry: { id: string; ext: string }): string {
  return join(knowledgeFilesDir(knowledgeDir), `${entry.id}.${entry.ext}`)
}

/** 抽取文本路径 */
function textPathOf(knowledgeDir: string, id: string): string {
  return join(knowledgeTextDir(knowledgeDir), `${id}.txt`)
}

/** 建目录（files/text 一起；index 写在根） */
function ensureDirs(knowledgeDir: string): void {
  mkdirSync(knowledgeFilesDir(knowledgeDir), { recursive: true })
  mkdirSync(knowledgeTextDir(knowledgeDir), { recursive: true })
}

/** 原子写索引：tmp + rename（Windows 的 rename 会覆盖已存在目标） */
function writeIndexAtomic(knowledgeDir: string, index: KnowledgeIndex): void {
  ensureDirs(knowledgeDir)
  const target = knowledgeIndexPath(knowledgeDir)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, target)
  } catch {
    // 目标被占用/杀软短锁：删了再重命名一次；仍失败就如实抛（不交半截索引）
    rmSync(target, { force: true })
    renameSync(tmp, target)
  }
}

/** 索引元素形状校验（自愈时只认字段齐全的） */
function isIndexEntry(value: unknown): value is KnowledgeIndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    typeof entry.title === 'string' &&
    typeof entry.originalPath === 'string' &&
    typeof entry.size === 'number' &&
    typeof entry.ext === 'string' &&
    typeof entry.addedAt === 'string' &&
    typeof entry.updatedAt === 'string' &&
    typeof entry.charCount === 'number' &&
    typeof entry.truncated === 'boolean'
  )
}

/** 从 files/ 里现存文件重建 index（自愈；读不到任何东西就回空索引） */
function rebuildIndexFromFiles(knowledgeDir: string): KnowledgeIndex {
  const directory = knowledgeFilesDir(knowledgeDir)
  if (!existsSync(directory)) return emptyKnowledgeIndex()
  const documents: KnowledgeIndexEntry[] = []
  for (const name of readdirSync(directory)) {
    const match = /^([0-9a-f-]{36})\.([a-z0-9]+)$/i.exec(name)
    if (match === null) continue
    const id = match[1]
    const ext = match[2].toLowerCase()
    if (!isKnowledgeExtension(ext)) continue
    const file = join(directory, name)
    let size = 0
    let updatedAt = new Date(0).toISOString()
    try {
      const stat = statSync(file)
      size = stat.size
      updatedAt = stat.mtime.toISOString()
    } catch {
      continue
    }
    const textFile = textPathOf(knowledgeDir, id)
    let text = ''
    let truncated = false
    if (existsSync(textFile)) {
      try {
        text = readFileSync(textFile, 'utf8')
        truncated = text.length >= KNOWLEDGE_TEXT_MAX
      } catch {
        text = ''
      }
    }
    documents.push({
      id,
      // 自愈时原始文件名已经丢了：标题退回库内文件名（用户可重命名）
      title: `${id}.${ext}`,
      // 来源路径同样不可知：记库内路径（只作展示，删除不碰它）
      originalPath: file,
      size,
      ext,
      addedAt: updatedAt,
      updatedAt,
      charCount: text.length,
      truncated
    })
  }
  documents.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1))
  return { version: 1, documents }
}

/**
 * 读索引：缺失/损坏/元素不合法 → 按 files/ 自愈重建并立刻落盘。
 * 这是 plan §8「index 与文件不同步」的兜底：宁可用库内文件重建，也不让整页报错。
 */
export function readKnowledgeIndex(knowledgeDir: string): KnowledgeIndex {
  const file = knowledgeIndexPath(knowledgeDir)
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        const candidate = parsed as { version?: unknown; documents?: unknown }
        if (candidate.version === 1 && Array.isArray(candidate.documents)) {
          const documents = candidate.documents.filter(isIndexEntry)
          return { version: 1, documents }
        }
      }
    } catch {
      // JSON 坏了 / 读不了：走自愈
    }
  }
  const rebuilt = rebuildIndexFromFiles(knowledgeDir)
  try {
    writeIndexAtomic(knowledgeDir, rebuilt)
  } catch {
    // 自愈落盘失败不影响本次读（下次再试）；不把内部错误抛给 UI
  }
  return rebuilt
}

/** 正文 → 列表摘要（压空白 + 截 120 字） */
function excerptOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, KNOWLEDGE_EXCERPT_MAX)
}

/** index 元素 → IPC 契约的 KnowledgeDoc（excerpt 由 text 派生） */
function docOf(entry: KnowledgeIndexEntry, text: string): KnowledgeDoc {
  return {
    id: entry.id,
    title: entry.title,
    originalPath: entry.originalPath,
    size: entry.size,
    ext: entry.ext,
    addedAt: entry.addedAt,
    updatedAt: entry.updatedAt,
    charCount: entry.charCount,
    excerpt: excerptOf(text)
  }
}

/** 读一篇的抽取文本（文件没了就退回空串；不抛——列表/搜索不该因单篇坏掉而整页失败） */
function storedTextOf(knowledgeDir: string, entry: KnowledgeIndexEntry): string {
  const file = textPathOf(knowledgeDir, entry.id)
  if (!existsSync(file)) return ''
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 列全部文档（按加入时间倒序；excerpt 现读 text 文件） */
export function listKnowledge(knowledgeDir: string): KnowledgeDoc[] {
  const index = readKnowledgeIndex(knowledgeDir)
  return index.documents
    .slice()
    .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1))
    .map((entry) => docOf(entry, storedTextOf(knowledgeDir, entry)))
}

/** 读一篇抽取文本：超 2 MB 截断，且如实回 truncated（页脚提示用） */
export function readKnowledgeText(
  knowledgeDir: string,
  id: string
): { text: string; truncated: boolean } {
  const entry = readKnowledgeIndex(knowledgeDir).documents.find((item) => item.id === id)
  if (entry === undefined) throw new Error('知识库里没有这条资料（可能已被删除）')

  let text = storedTextOf(knowledgeDir, entry)
  let truncated = entry.truncated
  if (text === '' && existsSync(filePathOf(knowledgeDir, entry))) {
    // text 文件丢了但原字节还在：重新解码补齐（不抛）
    const raw = decodeUtf8(readFileSync(filePathOf(knowledgeDir, entry)))
    if (raw !== null) {
      truncated = raw.length > KNOWLEDGE_TEXT_MAX
      text = truncated ? raw.slice(0, KNOWLEDGE_TEXT_MAX) : raw
      try {
        writeFileSync(textPathOf(knowledgeDir, entry.id), text, 'utf8')
      } catch {
        // 补写失败仍把本次内容给出去
      }
    }
  }
  return { text, truncated }
}

/** 命中片段：±60 字上下文 + 压空白（不把整篇文本交给渲染端） */
function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 60)
  const end = Math.min(text.length, index + length + 60)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`
}

/** 搜索标题 + 正文（大小写不敏感子串；正文命中给 ±60 字 snippet；上限 50） */
export function searchKnowledge(knowledgeDir: string, query: string): KnowledgeSearchHit[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  const hits: KnowledgeSearchHit[] = []
  for (const entry of readKnowledgeIndex(knowledgeDir).documents) {
    if (hits.length >= KNOWLEDGE_SEARCH_LIMIT) break
    const text = storedTextOf(knowledgeDir, entry)
    const textIndex = text.toLowerCase().indexOf(needle)
    const titleHit = entry.title.toLowerCase().includes(needle)
    if (textIndex === -1 && !titleHit) continue
    hits.push({
      id: entry.id,
      title: entry.title,
      snippet: textIndex === -1 ? excerptOf(text) : snippetAround(text, textIndex, needle.length)
    })
  }
  return hits
}

/** UTF-8 严格解码（BOM 去掉；解不开回 null —— 调用方给人话 skipped） */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    return decoder.decode(bytes).replace(/^\uFEFF/, '')
  } catch {
    return null
  }
}

/** 导入一批文件（路径由主进程原生选择器给；白名单/大小/二进制逐条判，拒绝进 skipped） */
export function importKnowledgeFiles(
  knowledgeDir: string,
  absolutePaths: readonly string[]
): KnowledgeImportResult {
  ensureDirs(knowledgeDir)
  const index = readKnowledgeIndex(knowledgeDir)
  const existingPaths = new Set(index.documents.map((doc) => doc.originalPath.toLowerCase()))
  const documents: KnowledgeDoc[] = []
  const skipped: KnowledgeSkipped[] = []
  const now = new Date()
  let indexChanged = false

  for (const path of absolutePaths.slice(0, KNOWLEDGE_IMPORT_MAX_FILES)) {
    const name = basename(path)
    const skip = (reason: string): void => {
      skipped.push({ name, reason })
    }
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(path)
    } catch {
      skip('读不了这个文件（可能不存在、被移动或没有权限）')
      continue
    }
    if (!stat.isFile()) {
      skip('不是普通文件（知识库只收单个文件）')
      continue
    }
    const ext = extname(path).replace(/^\./, '').toLowerCase()
    if (!isKnowledgeExtension(ext)) {
      skip(`不支持的格式（v1 只收 ${knowledgeExtensionListText()} 这些文本类）`)
      continue
    }
    if (stat.size > KNOWLEDGE_FILE_MAX_BYTES) {
      skip(`文件太大（上限 5 MB，这个 ${(stat.size / 1024 / 1024).toFixed(1)} MB）`)
      continue
    }
    if (existingPaths.has(path.toLowerCase())) {
      skip('这个文件已经在知识库里了')
      continue
    }
    let bytes: Buffer
    try {
      bytes = readFileSync(path)
    } catch {
      skip('读不了这个文件（可能不存在、被移动或没有权限）')
      continue
    }
    if (bytes.includes(0)) {
      skip('看起来是二进制文件（含 NUL 字节），知识库只收文本')
      continue
    }
    const decoded = decodeUtf8(bytes)
    if (decoded === null) {
      skip('不是 UTF-8 文本（可能是其它编码或二进制）')
      continue
    }
    const truncated = decoded.length > KNOWLEDGE_TEXT_MAX
    const text = truncated ? decoded.slice(0, KNOWLEDGE_TEXT_MAX) : decoded
    const id = randomUUID()
    try {
      writeFileSync(filePathOf(knowledgeDir, { id, ext }), bytes)
      writeFileSync(textPathOf(knowledgeDir, id), text, 'utf8')
    } catch {
      skip('复制进知识库时写盘失败（磁盘可能满了或没有权限）')
      continue
    }
    const entry: KnowledgeIndexEntry = {
      id,
      title: name,
      originalPath: path,
      size: stat.size,
      ext,
      addedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      charCount: text.length,
      truncated
    }
    index.documents.push(entry)
    existingPaths.add(path.toLowerCase())
    documents.push(docOf(entry, text))
    indexChanged = true
  }

  if (indexChanged) writeIndexAtomic(knowledgeDir, index)
  return { documents, skipped }
}

/** 重命名标题（handler 已 trim/校验；这里只落 updatedAt 与索引） */
export function renameKnowledge(knowledgeDir: string, input: KnowledgeRenameInput): KnowledgeDoc {
  const index = readKnowledgeIndex(knowledgeDir)
  const entry = index.documents.find((item) => item.id === input.id)
  if (entry === undefined) throw new Error('知识库里没有这条资料（可能已被删除）')
  entry.title = input.title
  entry.updatedAt = new Date().toISOString()
  writeIndexAtomic(knowledgeDir, index)
  return docOf(entry, storedTextOf(knowledgeDir, entry))
}

/** 删除一篇（index / files / text 三处一起清；原文件不动） */
export function deleteKnowledge(knowledgeDir: string, id: string): void {
  const index = readKnowledgeIndex(knowledgeDir)
  const entry = index.documents.find((item) => item.id === id)
  if (entry === undefined) throw new Error('知识库里没有这条资料（可能已被删除）')
  rmSync(filePathOf(knowledgeDir, entry), { force: true })
  rmSync(textPathOf(knowledgeDir, id), { force: true })
  writeIndexAtomic(knowledgeDir, {
    version: 1,
    documents: index.documents.filter((item) => item.id !== id)
  })
}

/** 定位一篇要 reveal 的文件（真实实现：`files/<id>.<ext>`；不存在给人的错误） */
export function resolveKnowledgeReveal(knowledgeDir: string, id: string): string {
  const entry = readKnowledgeIndex(knowledgeDir).documents.find((item) => item.id === id)
  if (entry === undefined) throw new Error('知识库里没有这条资料（可能已被删除）')
  const file = filePathOf(knowledgeDir, entry)
  if (!existsSync(file)) throw new Error('这份资料的文件不在库里了（索引可能已过期，请重新导入）')
  return file
}

/** 打开数据文件夹前的目录准备（handler 用：目录不存在就建，用户点开时能看到） */
export function ensureKnowledgeDir(knowledgeDir: string): string {
  ensureDirs(knowledgeDir)
  return knowledgeDir
}
