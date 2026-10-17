/**
 * notes 通道的 handler（M5）：入参闸门 → 笔记存储 → 回包。
 *
 * 范式照 `main/ipc/projects.ts`：**形状**由 `parseIpcArgs` + shared 的 tuple schema 管；
 * **业务**校验（正文 2 MB / 标题 120 字 / trim 后空标题兜底）在这一层给人话；
 * 磁盘动作全在 `main/notes.ts`（stub，由 notes 实现任务替换）。
 *
 * 打开数据文件夹是唯一碰 electron 的动作（`shell.openPath`），其余都是纯 Node 存储调用。
 */
import { mkdirSync } from 'node:fs'
import { ipcMain, shell } from 'electron'
import {
  IPC_CHANNELS,
  noArgsSchema,
  noteCreateArgsSchema,
  noteIdArgsSchema,
  notePinArgsSchema,
  noteSaveArgsSchema,
  notesSearchArgsSchema,
  parseIpcArgs
} from '../../shared/ipc'
import { NOTE_TEXT_MAX, NOTE_TITLE_MAX } from '../../shared/notes'
import {
  createNote,
  deleteNote,
  getNoteText,
  listNotes,
  notesDirOf,
  saveNote,
  searchNotes,
  setNotePinned
} from '../notes'

/** 空标题的兜底文案（plan §2.1） */
const UNTITLED_NOTE = '未命名笔记'

/**
 * 标题归一：去首尾空白 → 空则「未命名笔记」→ 超 120 字给人话（不静默截断）。
 * 新建与保存共用一份口径，避免两条路写出不同标题。
 */
function normalizeNoteTitle(title: string | undefined): string {
  const trimmed = (title ?? '').trim()
  if (trimmed === '') return UNTITLED_NOTE
  if (trimmed.length > NOTE_TITLE_MAX) {
    throw new Error(`笔记标题最多 ${String(NOTE_TITLE_MAX)} 个字，请精简一下`)
  }
  return trimmed
}

export function registerNotesIpc(userDataDir: string): void {
  const dir = notesDirOf(userDataDir)

  ipcMain.handle(IPC_CHANNELS.notes.list, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.notes.list)
    return { notes: listNotes(dir) }
  })

  ipcMain.handle(IPC_CHANNELS.notes.get, (_event, ...args) => {
    const [id] = parseIpcArgs(noteIdArgsSchema, args, IPC_CHANNELS.notes.get)
    return { text: getNoteText(dir, id) }
  })

  ipcMain.handle(IPC_CHANNELS.notes.create, (_event, ...args) => {
    const [input] = parseIpcArgs(noteCreateArgsSchema, args, IPC_CHANNELS.notes.create)
    return createNote(dir, { title: normalizeNoteTitle(input.title) })
  })

  ipcMain.handle(IPC_CHANNELS.notes.save, (_event, ...args) => {
    const [input] = parseIpcArgs(noteSaveArgsSchema, args, IPC_CHANNELS.notes.save)
    if (Buffer.byteLength(input.text, 'utf8') > NOTE_TEXT_MAX) {
      throw new Error('笔记正文太长（上限 2 MB），请拆分后再保存')
    }
    return {
      note: saveNote(dir, {
        id: input.id,
        title: normalizeNoteTitle(input.title),
        text: input.text
      })
    }
  })

  ipcMain.handle(IPC_CHANNELS.notes.delete, (_event, ...args) => {
    const [id] = parseIpcArgs(noteIdArgsSchema, args, IPC_CHANNELS.notes.delete)
    deleteNote(dir, id)
    return { ok: true as const }
  })

  ipcMain.handle(IPC_CHANNELS.notes.pin, (_event, ...args) => {
    const [id, pinned] = parseIpcArgs(notePinArgsSchema, args, IPC_CHANNELS.notes.pin)
    return { note: setNotePinned(dir, id, pinned) }
  })

  ipcMain.handle(IPC_CHANNELS.notes.search, (_event, ...args) => {
    const [query] = parseIpcArgs(notesSearchArgsSchema, args, IPC_CHANNELS.notes.search)
    const trimmed = query.trim()
    // 空查询不发去扫盘（渲染端也可能直接清空搜索框）
    if (trimmed === '') return { hits: [] }
    return { hits: searchNotes(dir, trimmed) }
  })

  ipcMain.handle(IPC_CHANNELS.notes.openFolder, async (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.notes.openFolder)
    // 目录不存在就建（用户点「打开数据文件夹」时希望看到它，而不是报"不存在"）
    mkdirSync(dir, { recursive: true })
    const problem = await shell.openPath(dir)
    if (problem !== '') throw new Error(`没法打开笔记文件夹：${problem}`)
    return { path: dir }
  })
}
