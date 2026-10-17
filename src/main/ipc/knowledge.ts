/**
 * knowledge 通道的 handler（M5）：入参闸门 → 知识库存储 → 回包；导入/定位/打开目录碰 electron。
 *
 * 范式照 `main/ipc/projects.ts`：
 *   - **导入**只用原生多选（`dialog.showOpenDialog`）：路径由选择器给，渲染端传不了任意路径；
 *     filters 与主进程二次判定共用 shared 的白名单；
 *   - **reveal** 走 `shell.showItemInFolder`（只定位、不执行），**openFolder** 走 `shell.openPath`
 *     （只打开 userData/knowledge 自己这个目录）；
 *   - 形状由 `parseIpcArgs` 管；业务校验（标题 trim/上限、查询 trim、单次数量上限）在这一层给
 *     人话；磁盘动作全在 `main/knowledge.ts`（真实实现）。
 */
import { basename } from 'node:path'
import { BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import {
  IPC_CHANNELS,
  knowledgeIdArgsSchema,
  knowledgeRenameArgsSchema,
  knowledgeSearchArgsSchema,
  noArgsSchema,
  parseIpcArgs
} from '../../shared/ipc'
import {
  KNOWLEDGE_IMPORT_MAX_FILES,
  KNOWLEDGE_TEXT_EXTENSIONS,
  KNOWLEDGE_TITLE_MAX
} from '../../shared/knowledge'
import {
  deleteKnowledge,
  ensureKnowledgeDir,
  importKnowledgeFiles,
  knowledgeDirOf,
  listKnowledge,
  readKnowledgeText,
  renameKnowledge,
  resolveKnowledgeReveal,
  searchKnowledge
} from '../knowledge'

/** 重命名标题归一：trim 后不能为空（与笔记不同，这里不兜底成「未命名」——用户是在改已有文档） */
function normalizeKnowledgeTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed === '') throw new Error('标题不能为空')
  if (trimmed.length > KNOWLEDGE_TITLE_MAX) {
    throw new Error(`标题最多 ${String(KNOWLEDGE_TITLE_MAX)} 个字，请精简一下`)
  }
  return trimmed
}

export function registerKnowledgeIpc(userDataDir: string): void {
  const dir = knowledgeDirOf(userDataDir)

  ipcMain.handle(IPC_CHANNELS.knowledge.list, (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.knowledge.list)
    return { documents: listKnowledge(dir) }
  })

  ipcMain.handle(IPC_CHANNELS.knowledge.import, async (event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.knowledge.import)
    const options: OpenDialogOptions = {
      title: '导入资料到知识库',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文本资料', extensions: [...KNOWLEDGE_TEXT_EXTENSIONS] }]
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled) return { documents: [], skipped: [] }

    // 单次数量上限：多出来的如实进 skipped（不静默吞）
    const picked = result.filePaths.slice(0, KNOWLEDGE_IMPORT_MAX_FILES)
    const tooMany = result.filePaths.slice(KNOWLEDGE_IMPORT_MAX_FILES).map((path) => ({
      name: basename(path),
      reason: `一次最多导入 ${String(KNOWLEDGE_IMPORT_MAX_FILES)} 个文件`
    }))
    const imported = importKnowledgeFiles(dir, picked)
    return { documents: imported.documents, skipped: [...tooMany, ...imported.skipped] }
  })

  ipcMain.handle(IPC_CHANNELS.knowledge.readText, (_event, ...args) => {
    const [id] = parseIpcArgs(knowledgeIdArgsSchema, args, IPC_CHANNELS.knowledge.readText)
    return readKnowledgeText(dir, id)
  })

  ipcMain.handle(IPC_CHANNELS.knowledge.search, (_event, ...args) => {
    const [query] = parseIpcArgs(knowledgeSearchArgsSchema, args, IPC_CHANNELS.knowledge.search)
    const trimmed = query.trim()
    if (trimmed === '') return { hits: [] }
    return { hits: searchKnowledge(dir, trimmed) }
  })

  ipcMain.handle(IPC_CHANNELS.knowledge.rename, (_event, ...args) => {
    const [input] = parseIpcArgs(knowledgeRenameArgsSchema, args, IPC_CHANNELS.knowledge.rename)
    return {
      document: renameKnowledge(dir, { id: input.id, title: normalizeKnowledgeTitle(input.title) })
    }
  })

  ipcMain.handle(IPC_CHANNELS.knowledge.delete, (_event, ...args) => {
    const [id] = parseIpcArgs(knowledgeIdArgsSchema, args, IPC_CHANNELS.knowledge.delete)
    deleteKnowledge(dir, id)
    return { ok: true as const }
  })

  ipcMain.handle(IPC_CHANNELS.knowledge.reveal, (_event, ...args) => {
    const [id] = parseIpcArgs(knowledgeIdArgsSchema, args, IPC_CHANNELS.knowledge.reveal)
    const path = resolveKnowledgeReveal(dir, id)
    shell.showItemInFolder(path)
    return { path }
  })

  ipcMain.handle(IPC_CHANNELS.knowledge.openFolder, async (_event, ...args) => {
    parseIpcArgs(noArgsSchema, args, IPC_CHANNELS.knowledge.openFolder)
    // 目录不存在就建（用户点「打开数据文件夹」时希望看到它，而不是报"不存在"）
    ensureKnowledgeDir(dir)
    const problem = await shell.openPath(dir)
    if (problem !== '') throw new Error(`没法打开知识库文件夹：${problem}`)
    return { path: dir }
  })
}
