/**
 * 笔记（M5）· 跨端契约：数据形状 + 入参/回包 schema + 硬上限。
 *
 * 产品口径（plan §1.1/§2.1）：笔记是**用户自己的 Markdown 文件**，落在主进程
 * `userData/notes/`（`index.json` 元数据 + `<id>.md` 正文）；渲染端只拿元数据与正文，
 * 不碰磁盘。写域纪律（id 形状、正文/标题上限）由这里的常量 + 主进程闸门共同兜住。
 *
 * 与 `shared/projects.ts` 同一分工：**这里只定跨边界形状与上限**；落盘/自愈/原子写
 * 等业务实现全在 `main/notes.ts`（由 notes 实现任务填充）。
 */
import { z } from './zod'

/** 正文上限（2 MB）：超出由主进程给人工话（闸门只管形状） */
export const NOTE_TEXT_MAX = 2 * 1024 * 1024

/** 标题上限（120 字；首尾空白由主进程 trim） */
export const NOTE_TITLE_MAX = 120

/** 列表/搜索结果里 excerpt 的截断长度（正文首 120 字纯文本） */
export const NOTE_EXCERPT_MAX = 120

/** 搜索命中上限（标题 + 正文；超出截断） */
export const NOTE_SEARCH_LIMIT = 50

/** 笔记 id：主进程 `randomUUID()` 生成（渲染端传的 id 只认这个形状） */
export const noteIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '不是合法的笔记 id')

/** 一条笔记的元数据（`index.json` 的元素 + `notes:list` 回包元素） */
export const noteMetaSchema = z.strictObject({
  id: noteIdSchema,
  /** 显示标题；空标题由主进程兜底成「未命名笔记」 */
  title: z.string().min(1),
  /** ISO 时间串（主进程生成） */
  createdAt: z.string(),
  updatedAt: z.string(),
  /** 置顶（列表排序：置顶优先，再按 updatedAt 倒序） */
  pinned: z.boolean(),
  /** 正文首 120 字纯文本（列表预览用；主进程生成） */
  excerpt: z.string()
})

export type NoteMeta = z.infer<typeof noteMetaSchema>

/** `notes:create` 的入参：标题可省略（缺省「未命名笔记」） */
export const noteCreateInputSchema = z.strictObject({
  title: z.string().optional()
})

export type NoteCreateInput = z.infer<typeof noteCreateInputSchema>

/** `notes:save` 的入参：标题 + 正文一起写（updatedAt 由主进程生成） */
export const noteSaveInputSchema = z.strictObject({
  id: noteIdSchema,
  title: z.string(),
  text: z.string()
})

export type NoteSaveInput = z.infer<typeof noteSaveInputSchema>

/** `notes:list` 回包 */
export const notesListResultSchema = z.strictObject({
  notes: z.array(noteMetaSchema)
})

/** `notes:get` 回包（`.md` 原文） */
export const noteGetResultSchema = z.strictObject({ text: z.string() })

/** `notes:create` 回包：新笔记元数据 + 空正文 */
export const noteCreateResultSchema = z.strictObject({
  note: noteMetaSchema,
  text: z.literal('')
})

/** `notes:save` 回包：写入后的元数据（含新 updatedAt） */
export const noteSaveResultSchema = z.strictObject({ note: noteMetaSchema })

/** `notes:delete` 回包 */
export const noteDeleteResultSchema = z.strictObject({ ok: z.literal(true) })

/** 搜索命中（标题/正文命中都给同一形状；snippet 是命中片段 ±上下文） */
export const noteSearchHitSchema = z.strictObject({
  id: noteIdSchema,
  title: z.string().min(1),
  snippet: z.string()
})

export type NoteSearchHit = z.infer<typeof noteSearchHitSchema>

/** `notes:search` 回包 */
export const notesSearchResultSchema = z.strictObject({
  hits: z.array(noteSearchHitSchema)
})

/** `notes:openFolder` 回包：实际打开的目录（绝对路径，测试与排障可见） */
export const notesOpenFolderResultSchema = z.strictObject({ path: z.string().min(1) })

export type NotesListResult = z.infer<typeof notesListResultSchema>
export type NoteGetResult = z.infer<typeof noteGetResultSchema>
export type NoteCreateResult = z.infer<typeof noteCreateResultSchema>
export type NoteSaveResult = z.infer<typeof noteSaveResultSchema>
export type NoteDeleteResult = z.infer<typeof noteDeleteResultSchema>
export type NotesSearchResult = z.infer<typeof notesSearchResultSchema>
export type NotesOpenFolderResult = z.infer<typeof notesOpenFolderResultSchema>
