/**
 * 知识库（M5）· 跨端契约：文档形状 + 入参/回包 schema + 白名单/上限。
 *
 * 产品口径（plan §1.2/§2.2）：把**本机文本资料**复制进库（`userData/knowledge/`），
 * 之后能搜、能看。v1 只收文本类格式、不解析 PDF/Office、不做向量检索。
 * 落盘/解码/搜索全在 `main/knowledge.ts`（由 knowledge 实现任务填充）；这里只定形状。
 */
import { z } from './zod'

/** 一次导入的文件数上限（超出的文件如实进 skipped） */
export const KNOWLEDGE_IMPORT_MAX_FILES = 20

/** 单个文件大小上限（5 MB；超出进 skipped 并给人话） */
export const KNOWLEDGE_FILE_MAX_BYTES = 5 * 1024 * 1024

/** 抽取文本上限（2 MB；超出截断并如实标 truncated） */
export const KNOWLEDGE_TEXT_MAX = 2 * 1024 * 1024

/** 列表/搜索结果里 excerpt 的截断长度（正文首 120 字纯文本） */
export const KNOWLEDGE_EXCERPT_MAX = 120

/** 搜索命中上限 */
export const KNOWLEDGE_SEARCH_LIMIT = 50

/** 标题上限（120 字；重命名时 trim） */
export const KNOWLEDGE_TITLE_MAX = 120

/**
 * v1 支持的文本类扩展名（小写、不带点）。
 * 白名单同时用于原生选择器 filters 与主进程二次判定（两边同源，不在两处各写一份）。
 */
export const KNOWLEDGE_TEXT_EXTENSIONS = [
  'md',
  'markdown',
  'txt',
  'json',
  'csv',
  'tsv',
  'log',
  'yaml',
  'yml',
  'xml',
  'html'
] as const

export type KnowledgeTextExtension = (typeof KNOWLEDGE_TEXT_EXTENSIONS)[number]

/** 知识库文档 id：主进程 `randomUUID()` 生成 */
export const knowledgeIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    '不是合法的知识库文档 id'
  )

/** 一篇知识库文档的元数据（`index.json` 的元素 + `knowledge:list` 回包元素） */
export const knowledgeDocSchema = z.strictObject({
  id: knowledgeIdSchema,
  /** 标题（默认 = 原文件名，可重命名） */
  title: z.string().min(1),
  /** 导入时的原文件绝对路径（只作来源展示；文件本体已复制进库） */
  originalPath: z.string().min(1),
  /** 原字节大小（字节） */
  size: z.number().int().min(0),
  /** 小写、不带点的扩展名（`md` / `txt` / …） */
  ext: z.string().min(1),
  /** ISO 时间串（主进程生成） */
  addedAt: z.string(),
  updatedAt: z.string(),
  /** 解码后的纯文本字符数（可能因 2 MB 截断而小于实际） */
  charCount: z.number().int().min(0),
  /** 正文首 120 字纯文本（列表预览用） */
  excerpt: z.string()
})

export type KnowledgeDoc = z.infer<typeof knowledgeDocSchema>

/** `knowledge:rename` 的入参 */
export const knowledgeRenameInputSchema = z.strictObject({
  id: knowledgeIdSchema,
  title: z.string()
})

export type KnowledgeRenameInput = z.infer<typeof knowledgeRenameInputSchema>

/** `knowledge:list` 回包 */
export const knowledgeListResultSchema = z.strictObject({
  documents: z.array(knowledgeDocSchema)
})

/** 导入时被跳过的文件（如实列出原因，不静默吞） */
export const knowledgeSkippedSchema = z.strictObject({
  name: z.string().min(1),
  reason: z.string().min(1)
})

export type KnowledgeSkipped = z.infer<typeof knowledgeSkippedSchema>

/** `knowledge:import` 回包：成功导入的文档 + 被跳过的清单 */
export const knowledgeImportResultSchema = z.strictObject({
  documents: z.array(knowledgeDocSchema),
  skipped: z.array(knowledgeSkippedSchema)
})

/** `knowledge:readText` 回包：抽取文本 + 是否因超上限被截断 */
export const knowledgeReadTextResultSchema = z.strictObject({
  text: z.string(),
  truncated: z.boolean()
})

/** 搜索命中（标题/正文命中都给同一形状） */
export const knowledgeSearchHitSchema = z.strictObject({
  id: knowledgeIdSchema,
  title: z.string().min(1),
  snippet: z.string()
})

export type KnowledgeSearchHit = z.infer<typeof knowledgeSearchHitSchema>

/** `knowledge:search` 回包 */
export const knowledgeSearchResultSchema = z.strictObject({
  hits: z.array(knowledgeSearchHitSchema)
})

/** `knowledge:rename` 回包 */
export const knowledgeRenameResultSchema = z.strictObject({
  document: knowledgeDocSchema
})

/** `knowledge:delete` 回包 */
export const knowledgeDeleteResultSchema = z.strictObject({ ok: z.literal(true) })

/** `knowledge:reveal` / `knowledge:openFolder` 回包：实际操作的文件/目录绝对路径 */
export const knowledgePathResultSchema = z.strictObject({ path: z.string().min(1) })

export type KnowledgeListResult = z.infer<typeof knowledgeListResultSchema>
export type KnowledgeImportResult = z.infer<typeof knowledgeImportResultSchema>
export type KnowledgeReadTextResult = z.infer<typeof knowledgeReadTextResultSchema>
export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>
export type KnowledgeRenameResult = z.infer<typeof knowledgeRenameResultSchema>
export type KnowledgeDeleteResult = z.infer<typeof knowledgeDeleteResultSchema>
export type KnowledgePathResult = z.infer<typeof knowledgePathResultSchema>
