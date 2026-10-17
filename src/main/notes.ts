/**
 * 笔记存储（M5）：**本地 Markdown 真实现**（纯 Node，目录注入、可单测）。
 *
 * 数据布局（plan §2.1，全部在 `userData/notes/` 下）：
 *   - `index.json`：`{ version: 1, notes: [{ id, title, createdAt, updatedAt, pinned }] }`
 *     （原子写：`index.json.tmp` → rename；Windows 的 rename 会覆盖已存在目标）；
 *   - `<id>.md`：正文原文（UTF-8，无 frontmatter）。
 *
 * 纪律：
 *   - id 只认 uuid 形状（`randomUUID()` 生成）；正文 ≤ 2 MB、标题 ≤ 120 字（主进程闸门 + store 双保险，
 *     store 直接单测也走同一份口径）；
 *   - 启动/每次读索引自愈：index 缺失/损坏 → 按目录里的 `*.md` 重建（title 取首个标题行/首行，
 *     缺省「未命名笔记」，时间取 stat）；index 与文件不一致（少了文件 / 多了文件）→ 对账修正并落盘；
 *   - 删除 = 先删 `.md` 再移出 index（index 写失败时下次自愈会把残留条目清掉）；
 *   - 搜索在进程内扫正文（大小写不敏感、snippet ±60、上限 50），不把整库文本发给渲染端。
 *
 * 纯 Node：**不 import electron**；目录由调用方注入（`userDataDir`），便于单测与换存储。
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
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import {
  NOTE_EXCERPT_MAX,
  NOTE_SEARCH_LIMIT,
  NOTE_TEXT_MAX,
  NOTE_TITLE_MAX,
  type NoteCreateInput,
  type NoteMeta,
  type NoteSaveInput,
  type NoteSearchHit
} from '../shared/notes'

/** 笔记数据目录：`userData/notes` */
export function notesDirOf(userDataDir: string): string {
  return join(userDataDir, 'notes')
}

/** 索引文件：`userData/notes/index.json` */
export function notesIndexPath(notesDir: string): string {
  return join(notesDir, 'index.json')
}

/** 一篇笔记的正文文件路径 */
export function noteFilePath(notesDir: string, id: string): string {
  return join(notesDir, `${id}.md`)
}

/** index.json 里的一条（不含 excerpt —— excerpt 由正文即时派生） */
export interface NotesIndexEntry {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  pinned: boolean
}

/** index.json 的形状（v1） */
export interface NotesIndex {
  version: 1
  notes: NotesIndexEntry[]
}

/** 空标题的兜底文案（plan §2.1） */
export const UNTITLED_NOTE = '未命名笔记'

/** 笔记 id 的合法形状（与 shared/notes.ts 的 zod 闸门同一口径） */
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isNoteId(id: string): boolean {
  return NOTE_ID_PATTERN.test(id)
}

function assertNoteId(id: string): void {
  if (!isNoteId(id)) throw new Error('不是合法的笔记 id')
}

/** 空索引（自愈/测试用） */
export function emptyNotesIndex(): NotesIndex {
  return { version: 1, notes: [] }
}

/** 建目录 */
function ensureNotesDir(notesDir: string): void {
  mkdirSync(notesDir, { recursive: true })
}

/** 原子写索引：tmp + rename（Windows 覆盖式 rename；目标被占时删掉重命名一次） */
function writeIndexAtomic(notesDir: string, index: NotesIndex): void {
  ensureNotesDir(notesDir)
  const target = notesIndexPath(notesDir)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  try {
    renameSync(tmp, target)
  } catch {
    rmSync(target, { force: true })
    renameSync(tmp, target)
  }
}

/** 原子写正文：tmp + rename（正文是原文，不做任何加工） */
function writeNoteFileAtomic(notesDir: string, id: string, text: string): void {
  ensureNotesDir(notesDir)
  const target = noteFilePath(notesDir, id)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, target)
  } catch {
    rmSync(target, { force: true })
    renameSync(tmp, target)
  }
}

/** 索引元素形状校验（自愈时只认字段齐全的） */
function isIndexEntry(value: unknown): value is NotesIndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    isNoteId(entry.id) &&
    typeof entry.title === 'string' &&
    entry.title.length > 0 &&
    typeof entry.createdAt === 'string' &&
    typeof entry.updatedAt === 'string' &&
    typeof entry.pinned === 'boolean'
  )
}

/** 标题归一：trim → 空则「未命名笔记」→ 超 120 字给人话（与 IPC 层同一口径） */
export function normalizeNoteTitle(title: string | undefined): string {
  const trimmed = (title ?? '').trim()
  if (trimmed === '') return UNTITLED_NOTE
  if (trimmed.length > NOTE_TITLE_MAX) {
    throw new Error(`笔记标题最多 ${String(NOTE_TITLE_MAX)} 个字，请精简一下`)
  }
  return trimmed
}

/** 从正文里取一个兜底标题：首个标题行 → 首个非空行 → 「未命名笔记」 */
export function titleFromBody(text: string): string {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^#{1,6}\s*/, '')
      .replace(/[*_`>~]/g, '')
      .trim()
    if (line === '') continue
    return line.slice(0, NOTE_TITLE_MAX)
  }
  return UNTITLED_NOTE
}

/** 正文 → 列表摘要（压空白 + 截 120 字） */
function excerptOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, NOTE_EXCERPT_MAX)
}

/** 正文 → 纯文本（用于搜索/摘要：去掉常见 Markdown 记号，保留可读内容） */
function plainTextOf(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从 `.md` 文件重建一条 index 条目（自愈用；时间取 stat） */
function entryFromFile(notesDir: string, id: string): NotesIndexEntry | null {
  const file = noteFilePath(notesDir, id)
  let body = ''
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(file)
    if (!stat.isFile()) return null
    body = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const time = stat.mtime.toISOString()
  return {
    id,
    title: titleFromBody(body),
    createdAt: time,
    updatedAt: time,
    pinned: false
  }
}

/** 目录里所有合法 `<id>.md` 的 id */
function noteIdsOnDisk(notesDir: string): string[] {
  if (!existsSync(notesDir)) return []
  const ids: string[] = []
  for (const name of readdirSync(notesDir)) {
    const match = /^([0-9a-f-]{36})\.md$/i.exec(name)
    if (match === null) continue
    if (!isNoteId(match[1])) continue
    ids.push(match[1])
  }
  return ids
}

/** 按目录里的 `*.md` 重建整个索引（自愈） */
function rebuildIndexFromFiles(notesDir: string): NotesIndex {
  const entries = noteIdsOnDisk(notesDir).flatMap((id) => {
    const entry = entryFromFile(notesDir, id)
    return entry === null ? [] : [entry]
  })
  entries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  return { version: 1, notes: entries }
}

/** 读原始索引文件（失败/形状不对回 null，交给自愈） */
function readIndexFile(notesDir: string): NotesIndex | null {
  const file = notesIndexPath(notesDir)
  if (!existsSync(file)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as { version?: unknown; notes?: unknown }
    if (candidate.version !== 1 || !Array.isArray(candidate.notes)) return null
    return { version: 1, notes: candidate.notes.filter(isIndexEntry) }
  } catch {
    return null
  }
}

/**
 * 读索引并**对账**：删掉没有 `.md` 的条目、补上目录里多出来的 `.md`；有变化就原子落盘。
 * 这是 plan §8「index 与文件不同步」的兜底：宁可重建，也不让整页报错。
 */
export function readNotesIndex(notesDir: string): NotesIndex {
  const stored = readIndexFile(notesDir)
  const base = stored ?? rebuildIndexFromFiles(notesDir)
  const ids = new Set(noteIdsOnDisk(notesDir))
  const known = new Set<string>()
  const kept: NotesIndexEntry[] = []
  let changed = stored === null

  for (const entry of base.notes) {
    if (!ids.has(entry.id)) {
      changed = true
      continue
    }
    if (known.has(entry.id)) {
      changed = true
      continue
    }
    known.add(entry.id)
    kept.push(entry)
  }
  for (const id of ids) {
    if (known.has(id)) continue
    const entry = entryFromFile(notesDir, id)
    if (entry === null) continue
    kept.push(entry)
    changed = true
  }

  if (stored === null || changed || kept.length !== stored.notes.length) {
    // 保持与 listNotes 相同的排序（置顶优先 + updatedAt 倒序），让磁盘上的索引也稳定
    kept.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return a.updatedAt < b.updatedAt ? 1 : -1
    })
    const next: NotesIndex = { version: 1, notes: kept }
    try {
      writeIndexAtomic(notesDir, next)
    } catch {
      // 自愈落盘失败不影响本次读（下次再试）；不把内部错误抛给 UI
    }
    return next
  }
  return base
}

/** 读一篇正文（文件缺失明确抛，让上层显示真话） */
function storedTextOf(notesDir: string, id: string): string {
  const file = noteFilePath(notesDir, id)
  if (!existsSync(file)) throw new Error('这篇笔记的文件不见了（可能被外部删除了）')
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`读不到这篇笔记：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** index 条目 → 渲染端 NoteMeta（excerpt 从正文派生） */
function metaOf(entry: NotesIndexEntry, text: string): NoteMeta {
  return {
    id: entry.id,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    pinned: entry.pinned,
    excerpt: excerptOf(plainTextOf(text))
  }
}

/** 读一篇正文 */
export function getNoteText(notesDir: string, id: string): string {
  assertNoteId(id)
  const entry = readNotesIndex(notesDir).notes.find((item) => item.id === id)
  if (entry === undefined) throw new Error('没有这篇笔记（可能已被删除）')
  return storedTextOf(notesDir, id)
}

/** 列全部笔记：置顶优先，再按 updatedAt 倒序；excerpt 即时从正文派生 */
export function listNotes(notesDir: string): NoteMeta[] {
  const index = readNotesIndex(notesDir)
  const sorted = index.notes.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
    return a.createdAt < b.createdAt ? 1 : -1
  })
  return sorted.map((entry) => {
    let text = ''
    try {
      text = storedTextOf(notesDir, entry.id)
    } catch {
      text = ''
    }
    return metaOf(entry, text)
  })
}

/** 新建笔记：空正文 + 标题归一；返回元数据与空正文 */
export function createNote(notesDir: string, input: NoteCreateInput): { note: NoteMeta; text: '' } {
  const title = normalizeNoteTitle(input.title)
  const id = randomUUID()
  const now = new Date().toISOString()
  const entry: NotesIndexEntry = {
    id,
    title,
    createdAt: now,
    updatedAt: now,
    pinned: false
  }
  ensureNotesDir(notesDir)
  // 先读（并对账）索引，再落空正文：否则刚写的 .md 会被对账当成孤儿补一条，和下面 push 的重复
  const index = readNotesIndex(notesDir)
  writeNoteFileAtomic(notesDir, id, '')
  index.notes.push(entry)
  writeIndexAtomic(notesDir, index)
  return { note: metaOf(entry, ''), text: '' }
}

/** 保存标题 + 正文：updatedAt 由主进程生成；pinned 保持不变 */
export function saveNote(notesDir: string, input: NoteSaveInput): NoteMeta {
  assertNoteId(input.id)
  const title = normalizeNoteTitle(input.title)
  if (Buffer.byteLength(input.text, 'utf8') > NOTE_TEXT_MAX) {
    throw new Error('笔记正文太长（上限 2 MB），请拆份后再保存')
  }
  const index = readNotesIndex(notesDir)
  const position = index.notes.findIndex((entry) => entry.id === input.id)
  if (position < 0) throw new Error('没有这篇笔记（可能已被删除）')
  const now = new Date().toISOString()
  const entry: NotesIndexEntry = {
    ...index.notes[position]!,
    title,
    updatedAt: now
  }
  writeNoteFileAtomic(notesDir, input.id, input.text)
  index.notes[position] = entry
  writeIndexAtomic(notesDir, index)
  return metaOf(entry, input.text)
}

/** 删除笔记：先删 .md 再移出 index（index 写失败时下次自愈会清掉残条） */
export function deleteNote(notesDir: string, id: string): void {
  assertNoteId(id)
  const index = readNotesIndex(notesDir)
  const position = index.notes.findIndex((entry) => entry.id === id)
  if (position < 0) throw new Error('没有这篇笔记（可能已被删除）')
  try {
    unlinkSync(noteFilePath(notesDir, id))
  } catch {
    // 文件已经不在：继续把索引条目清掉（目标一致）
  }
  index.notes.splice(position, 1)
  writeIndexAtomic(notesDir, index)
}

/** 置顶开关：只改 pinned（不碰正文、不改 updatedAt） */
export function setNotePinned(notesDir: string, id: string, pinned: boolean): NoteMeta {
  assertNoteId(id)
  const index = readNotesIndex(notesDir)
  const position = index.notes.findIndex((entry) => entry.id === id)
  if (position < 0) throw new Error('没有这篇笔记（可能已被删除）')
  index.notes[position] = { ...index.notes[position]!, pinned }
  writeIndexAtomic(notesDir, index)
  const entry = index.notes[position]!
  return metaOf(entry, storedTextOf(notesDir, id))
}

/** 搜索：标题 + 正文，大小写不敏感，snippet ±60 字，上限 50 */
export function searchNotes(notesDir: string, query: string): NoteSearchHit[] {
  const needle = query.trim()
  if (needle === '') return []
  const lower = needle.toLowerCase()
  const hits: NoteSearchHit[] = []
  for (const entry of readNotesIndex(notesDir).notes) {
    if (hits.length >= NOTE_SEARCH_LIMIT) break
    let text = ''
    try {
      text = storedTextOf(notesDir, entry.id)
    } catch {
      continue
    }
    const plain = plainTextOf(text)
    const titleHit = entry.title.toLowerCase().includes(lower)
    const bodyIndex = plain.toLowerCase().indexOf(lower)
    if (!titleHit && bodyIndex < 0) continue
    hits.push({
      id: entry.id,
      title: entry.title,
      snippet: snippetOf(plain, bodyIndex, needle.length)
    })
  }
  return hits
}

/** snippet：正文命中取 ±60 字上下文（压空白 + 两端省略号）；标题命中回正文开头摘要 */
function snippetOf(plain: string, index: number, needleLength: number): string {
  if (index < 0) return plain.slice(0, NOTE_EXCERPT_MAX)
  const start = Math.max(0, index - 60)
  const end = Math.min(plain.length, index + needleLength + 60)
  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`
}
