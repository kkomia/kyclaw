// @vitest-environment node
/**
 * 笔记存储（`src/main/notes.ts`）：create/save/list/get/delete/search/置顶/自愈/非法 id/
 * 超长正文/标题清洗/excerpt。全部用**真磁盘**（mkdtemp 临时目录），不 mock fs —— 存储层
 * 的 bug 基本都在路径、原子写与自愈细节上。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOTE_SEARCH_LIMIT, NOTE_TEXT_MAX, NOTE_TITLE_MAX } from '../../shared/notes'
import {
  createNote,
  deleteNote,
  getNoteText,
  isNoteId,
  listNotes,
  noteFilePath,
  notesDirOf,
  notesIndexPath,
  saveNote,
  searchNotes,
  setNotePinned,
  titleFromBody
} from '../notes'

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const UUID_C = '33333333-3333-4333-8333-333333333333'

let root: string
let notesDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kyclaw-notes-'))
  notesDir = notesDirOf(root)
  mkdirSync(notesDir, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function readIndexJson(): {
  version: number
  notes: Array<{ id: string; title: string; createdAt: string; updatedAt: string; pinned: boolean }>
} {
  return JSON.parse(readFileSync(notesIndexPath(notesDir), 'utf8')) as ReturnType<
    typeof readIndexJson
  >
}

function writeIndex(index: { version: 1; notes: unknown[] }): void {
  writeFileSync(notesIndexPath(notesDir), `${JSON.stringify(index, null, 2)}\n`, 'utf8')
}

function writeBody(id: string, body: string): void {
  writeFileSync(noteFilePath(notesDir, id), body, 'utf8')
}

function tmpLeft(): string[] {
  return readdirSync(notesDir).filter((name) => name.endsWith('.tmp'))
}

describe('create / list / get：空正文 + 元数据 + 原子写', () => {
  it('新建：写 <id>.md（空）与 index.json；list 回 NoteMeta；get 回空串；不留 tmp', () => {
    const created = createNote(notesDir, {})

    expect(created.text).toBe('')
    expect(isNoteId(created.note.id)).toBe(true)
    expect(created.note.title).toBe('未命名笔记')
    expect(created.note.pinned).toBe(false)
    expect(created.note.excerpt).toBe('')

    expect(existsSync(noteFilePath(notesDir, created.note.id))).toBe(true)
    expect(readFileSync(noteFilePath(notesDir, created.note.id), 'utf8')).toBe('')
    expect(tmpLeft()).toEqual([])

    const index = readIndexJson()
    expect(index.version).toBe(1)
    expect(index.notes.map((note) => note.id)).toEqual([created.note.id])

    const listed = listNotes(notesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]).toEqual(created.note)
    expect(getNoteText(notesDir, created.note.id)).toBe('')
  })

  it('新建可带标题（trim；空白 → 未命名笔记）', () => {
    const a = createNote(notesDir, { title: '  周会纪要  ' })
    const b = createNote(notesDir, { title: '   ' })
    expect(a.note.title).toBe('周会纪要')
    expect(b.note.title).toBe('未命名笔记')
  })
})

describe('save：标题 + 正文一起写；updatedAt 由主进程生成；pinned 保留', () => {
  it('保存后正文/标题/excerpt 更新，pinned 不被 save 覆盖', () => {
    const created = createNote(notesDir, { title: '旧标题' })
    setNotePinned(notesDir, created.note.id, true)
    const before = listNotes(notesDir)[0]!

    const saved = saveNote(notesDir, {
      id: created.note.id,
      title: '新标题',
      text: '# 小节\n\n正文第一行，带 **加粗** 与 `代码`。'
    })

    expect(saved.title).toBe('新标题')
    expect(saved.pinned).toBe(true)
    expect(saved.updatedAt >= before.updatedAt).toBe(true)
    expect(saved.excerpt).toBe('小节 正文第一行，带 加粗 与 代码。')
    expect(getNoteText(notesDir, created.note.id)).toContain('正文第一行')
    expect(readFileSync(noteFilePath(notesDir, created.note.id), 'utf8')).toBe(
      '# 小节\n\n正文第一行，带 **加粗** 与 `代码`。'
    )
    expect(readIndexJson().notes[0]!.title).toBe('新标题')
    expect(tmpLeft()).toEqual([])
  })

  it('标题超 120 字 / 正文超 2 MB：人话拒绝，磁盘保持原样', () => {
    const created = createNote(notesDir, { title: '原文' })
    const original = readFileSync(noteFilePath(notesDir, created.note.id), 'utf8')

    expect(() =>
      saveNote(notesDir, {
        id: created.note.id,
        title: '长'.repeat(NOTE_TITLE_MAX + 1),
        text: 'x'
      })
    ).toThrow(`笔记标题最多 ${String(NOTE_TITLE_MAX)} 个字`)

    expect(() =>
      saveNote(notesDir, {
        id: created.note.id,
        title: '正常',
        text: 'a'.repeat(NOTE_TEXT_MAX + 1)
      })
    ).toThrow('笔记正文太长')

    expect(readFileSync(noteFilePath(notesDir, created.note.id), 'utf8')).toBe(original)
    expect(readIndexJson().notes[0]!.title).toBe('原文')
  })
})

describe('排序 / 置顶', () => {
  beforeEach(() => {
    writeBody(UUID_A, 'A 正文')
    writeBody(UUID_B, 'B 正文')
    writeBody(UUID_C, 'C 正文')
    writeIndex({
      version: 1,
      notes: [
        {
          id: UUID_A,
          title: 'A',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-03T00:00:00.000Z',
          pinned: false
        },
        {
          id: UUID_B,
          title: 'B',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
          pinned: false
        },
        {
          id: UUID_C,
          title: 'C',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          pinned: true
        }
      ]
    })
  })

  it('list：置顶优先，再按 updatedAt 倒序', () => {
    expect(listNotes(notesDir).map((note) => note.title)).toEqual(['C', 'A', 'B'])
  })

  it('setNotePinned 真落 index.json，返回置顶后的 NoteMeta；不改正文/updatedAt', () => {
    const before = listNotes(notesDir).find((note) => note.id === UUID_B)!
    const pinned = setNotePinned(notesDir, UUID_B, true)

    expect(pinned.pinned).toBe(true)
    expect(pinned.title).toBe('B')
    expect(pinned.updatedAt).toBe(before.updatedAt)
    expect(readIndexJson().notes.find((note) => note.id === UUID_B)!.pinned).toBe(true)
    expect(listNotes(notesDir).map((note) => note.title)).toEqual(['B', 'C', 'A'])

    const unpinned = setNotePinned(notesDir, UUID_C, false)
    expect(unpinned.pinned).toBe(false)
    expect(listNotes(notesDir).map((note) => note.title)).toEqual(['B', 'A', 'C'])
  })
})

describe('delete / 非法 id', () => {
  it('删除：.md 与 index 条目一起清；再删给人话', () => {
    const created = createNote(notesDir, { title: '要删的' })
    deleteNote(notesDir, created.note.id)

    expect(existsSync(noteFilePath(notesDir, created.note.id))).toBe(false)
    expect(listNotes(notesDir)).toEqual([])
    expect(readIndexJson().notes).toEqual([])
    expect(() => deleteNote(notesDir, created.note.id)).toThrow('没有这篇笔记')
  })

  it('非法 id：get/save/delete/pin 都拒绝（uuid 闸门）', () => {
    expect(() => getNoteText(notesDir, '../index.json')).toThrow('不是合法的笔记 id')
    expect(() => saveNote(notesDir, { id: 'not-a-uuid', title: 'x', text: 'x' })).toThrow(
      '不是合法的笔记 id'
    )
    expect(() => deleteNote(notesDir, '123')).toThrow('不是合法的笔记 id')
    expect(() => setNotePinned(notesDir, 'nope', true)).toThrow('不是合法的笔记 id')
    // 合法 uuid 但不存在：人话
    expect(() => getNoteText(notesDir, UUID_A)).toThrow('没有这篇笔记')
    expect(() => deleteNote(notesDir, UUID_A)).toThrow('没有这篇笔记')
    expect(() => setNotePinned(notesDir, UUID_A, true)).toThrow('没有这篇笔记')
  })
})

describe('search：标题 + 正文、大小写不敏感、snippet ±60、上限 50', () => {
  it('正文命中给上下文片段（含省略号）；标题命中回开头摘要；空查询空结果', () => {
    const created = createNote(notesDir, { title: '周会纪要' })
    saveNote(notesDir, {
      id: created.note.id,
      title: '周会纪要',
      text: `${'前'.repeat(100)}知识图谱${'后'.repeat(100)}`
    })
    const titled = createNote(notesDir, { title: 'Knowledge Graph 笔记' })

    const bodyHits = searchNotes(notesDir, '知识图谱')
    expect(bodyHits).toHaveLength(1)
    expect(bodyHits[0]!.id).toBe(created.note.id)
    expect(bodyHits[0]!.snippet).toContain('知识图谱')
    expect(bodyHits[0]!.snippet.startsWith('…')).toBe(true)

    // 大小写不敏感
    expect(searchNotes(notesDir, 'knowledge graph').map((hit) => hit.id)).toEqual([titled.note.id])
    expect(searchNotes(notesDir, '   ')).toEqual([])
    expect(searchNotes(notesDir, '不存在的词')).toEqual([])
  })

  it(`命中上限 ${String(NOTE_SEARCH_LIMIT)} 条`, () => {
    const notes = Array.from({ length: NOTE_SEARCH_LIMIT + 5 }, (_, index) => ({
      id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
      title: `笔记 ${String(index)}`,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      pinned: false
    }))
    for (const note of notes) writeBody(note.id, '共同关键词')
    writeIndex({ version: 1, notes })

    expect(searchNotes(notesDir, '共同关键词')).toHaveLength(NOTE_SEARCH_LIMIT)
  })
})

describe('index 自愈', () => {
  it('index 缺失：按 *.md 重建（标题取首个标题行/首行/未命名，时间取 stat）并落盘', () => {
    writeBody(UUID_A, '# 会议记录\n\n正文')
    writeBody(UUID_B, '第一行就是标题\n第二行')
    writeBody(UUID_C, '')

    const listed = listNotes(notesDir)
    expect(listed.map((note) => note.title).sort()).toEqual(
      ['会议记录', '第一行就是标题', '未命名笔记'].sort()
    )
    expect(existsSync(notesIndexPath(notesDir))).toBe(true)
    const index = readIndexJson()
    expect(index.notes).toHaveLength(3)
    expect(index.notes.map((note) => note.id).sort()).toEqual([UUID_A, UUID_B, UUID_C].sort())
    expect(index.notes.every((note) => note.pinned === false)).toBe(true)
  })

  it('index 坏掉（非 JSON）：同样重建，不整页失败', () => {
    writeBody(UUID_A, '# 修好的标题\n正文')
    writeFileSync(notesIndexPath(notesDir), '{ 这不是 JSON', 'utf8')

    const listed = listNotes(notesDir)
    expect(listed).toHaveLength(1)
    expect(listed[0]!.title).toBe('修好的标题')
    expect(readIndexJson().notes).toHaveLength(1)
  })

  it('index 与文件不一致：孤儿文件补进索引、缺文件的条目删掉，并落盘', () => {
    writeBody(UUID_B, '孤儿文件')
    writeIndex({
      version: 1,
      notes: [
        {
          id: UUID_A,
          title: '幽灵',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          pinned: false
        }
      ]
    })

    const listed = listNotes(notesDir)
    expect(listed.map((note) => note.id)).toEqual([UUID_B])
    const index = readIndexJson()
    expect(index.notes.map((note) => note.id)).toEqual([UUID_B])
  })

  it('删除 md 文件后（外部操作）再读：条目被对账清掉，不抛', () => {
    const created = createNote(notesDir, { title: '外部删档' })
    unlinkSync(noteFilePath(notesDir, created.note.id))

    expect(listNotes(notesDir)).toEqual([])
    expect(readIndexJson().notes).toEqual([])
  })
})

describe('标题派生 / 工具', () => {
  it('titleFromBody：## 标题 / 首个非空行 / 空正文兜底；isNoteId 只认 uuid', () => {
    expect(titleFromBody('## 小节标题\n正文')).toBe('小节标题')
    expect(titleFromBody('\n\n第一行\n第二行')).toBe('第一行')
    expect(titleFromBody('   \n')).toBe('未命名笔记')
    expect(isNoteId(UUID_A)).toBe(true)
    expect(isNoteId('not-a-uuid')).toBe(false)
    expect(isNoteId('11111111-1111-4111-8111-11111111111')).toBe(false)
  })

  it('create/save 的 excerpt 压空白并截 120 字', () => {
    const created = createNote(notesDir, { title: '摘要' })
    saveNote(notesDir, {
      id: created.note.id,
      title: '摘要',
      text: `  第一段\n\n第二段   ${'尾'.repeat(200)}`
    })
    const excerpt = listNotes(notesDir)[0]!.excerpt
    expect(excerpt.startsWith('第一段 第二段')).toBe(true)
    expect(excerpt.length).toBeLessThanOrEqual(120)
  })
})
