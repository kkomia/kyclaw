/**
 * 工作台（右侧边栏四项工具）的跨进程数据形状（shared 层：主进程 handler 与渲染端共用一份）。
 *
 * 三块：
 *   1. 文件树 —— 目录条目 / 文件预览（文本、二进制、过大三种结果按 `kind` 判别）；
 *   2. Git —— 仓库总览（分支 + 未提交变更）/ 提交历史（`--graph` 解析后的结构化行）/ 单提交详情；
 *   3. 终端 —— 会话描述（id + shell 名 + cwd）与退出事件。
 *
 * 所有路径都是**相对会话根**的写法（正斜杠），绝对路径只活在主进程里 —— 与 `workspace:list-files`
 * 同一套 containment 口径（渲染端传不了任意绝对路径）。zod schema 与类型同源，preload 双向都用它。
 */
import { z } from './zod'

/** 会话根解析不出来 / 不唯一时给渲染端的人话（工作台各工具的空态与错误行共用） */
export const WORKBENCH_NO_WORKSPACE = '这个会话还没有工作区：先在设置里添加一个文件夹'
export const WORKBENCH_ROOT_NOT_UNIQUE =
  '这个会话的工作区不唯一：指认默认工作区（或给会话选一个项目）后再用工作台'

/* ── 文件树 ─────────────────────────────────────────────────────────────── */

/** 目录条目的种类：v1 只区分目录与文件（符号链接/设备不进列表，与 @ 引用清单同口径） */
export const dirEntryKindSchema = z.enum(['dir', 'file'])
export type DirEntryKind = z.infer<typeof dirEntryKindSchema>

export const dirEntrySchema = z.strictObject({
  /** 条目名（不含路径） */
  name: z.string(),
  kind: dirEntryKindSchema,
  /** 文件字节数；目录给 0（渲染端不显示目录体积） */
  size: z.number()
})
export type DirEntry = z.infer<typeof dirEntrySchema>

/** workbench:list-dir 的回包：一层目录的内容（**不递归** —— 子目录展开时再列） */
export const listDirResultSchema = z.strictObject({
  entries: z.array(dirEntrySchema),
  /** 条目数到上限被截断（超大目录：如实说，不假装列全了） */
  truncated: z.boolean()
})
export type ListDirResult = z.infer<typeof listDirResultSchema>

/**
 * 文件预览按 `kind` 判别：
 *   - `text`：文本档，`text` 是被截到上限的内容，`truncated` 说明磁盘上的还没读完；
 *   - `binary`：读到的字节里有 NUL，按二进制处理（不吐乱码）；
 *   - `too-large`：超过硬上限（连一行都不值得传），只给大小。
 */
export const filePreviewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    text: z.string(),
    size: z.number(),
    truncated: z.boolean()
  }),
  z.strictObject({ kind: z.literal('binary'), size: z.number() }),
  z.strictObject({ kind: z.literal('too-large'), size: z.number() })
])
export type FilePreview = z.infer<typeof filePreviewSchema>

/** workbench:reveal 的回包：真正交给系统的那条绝对路径（测试与排障都看得到） */
export const revealResultSchema = z.strictObject({ path: z.string().min(1) })

/**
 * workbench:open 的回包：真正交给**系统默认应用**的那条绝对路径。
 * 形状与 reveal 一样（都是"我拿哪条路径去办的事"），但语义**不同**，别混用：
 * reveal 是"在文件资源管理器里定位"，open 是"用本机装了的那件应用打开这个文件"。
 */
export const openResultSchema = z.strictObject({ path: z.string().min(1) })

/* ── 文件字节（按格式渲染的那条通道） ────────────────────────────────────── */

/**
 * 带类型字节通道认得的格式：扩展名与文件头**双重**判定，两者对不上就按不支持处理。
 * 只列渲染端真能画出来的**字节**格式（图片走 data URL、PDF 走 pdfjs）；
 * 办公三件（docx/xlsx/pptx）与 csv 也走这条通道，但回的是主进程抽好的结构
 * （见下面 `fileBytesResultSchema` 的 `docx` / `xlsx` / `pptx`）。
 */
export const fileByteFormatSchema = z.enum([
  'image-png',
  'image-jpeg',
  'image-gif',
  'image-webp',
  'image-bmp',
  'pdf'
])
export type FileByteFormat = z.infer<typeof fileByteFormatSchema>

/**
 * 图片预览上限（byte）：round 53 起**独立**于附件口径，放宽到 30MB（用户点名）。
 *
 * 为什么可以和发送上限不一样：预览只是一趟"本机 → IPC → 画出来"（data URL 膨胀 ~33%，
 * 30MB 图 = 约 40MB 字符串，可以接受），不进模型请求体；而随消息真发的图片上限仍是
 * `IMAGE_MAX_BYTES`（8MB，见 shared/attachments）——那张图要进 provider 请求体，是另一回事。
 * 别把这两个数再合并回去。
 */
export const PREVIEW_IMAGE_MAX_BYTES = 30 * 1024 * 1024

/**
 * PDF 预览上限（自定）：文本档的 5MB 对带图 PDF 偏紧，这里放宽到 32MB
 * （整份过 IPC，是内存护栏而不是业务口径；超了给人话，不做"截一半去解析"）。
 */
export const PREVIEW_PDF_MAX_BYTES = 32 * 1024 * 1024

/**
 * 办公档（Word/Excel/PPT）与表格（csv/tsv）的统一上限：与 PDF 同档 32MB。
 * 这几类在渲染前要在主进程整份解包/解析，上限是内存护栏而不是业务口径；
 * 超了给人话，不做"截一半去解析"（csv 是唯一例外：只读头部 2MB 就够，见主进程）。
 */
export const PREVIEW_OFFICE_MAX_BYTES = 32 * 1024 * 1024

/**
 * 一张表的抽取结果（xlsx 每张工作表一条，csv/tsv 只有一条）。
 * 单元格一律是**字符串**（数字/日期/公式结果都由主进程的表格库转好），渲染端不再猜类型。
 */
export const previewSheetSchema = z.strictObject({
  name: z.string(),
  /** 行 × 列（可能是空表：`rows: []`） */
  rows: z.array(z.array(z.string())),
  /** 这张表的行/列到上限被截断了（多出来的没抽） */
  truncated: z.boolean()
})
export type PreviewSheet = z.infer<typeof previewSheetSchema>

/**
 * 一页幻灯片的**文字提要**（版式不还原，见 PptxPreview 的说明）：
 * `index` 是原稿里的页码（1 起），`title` 只在认得出标题占位符时才有（不猜）。
 */
export const previewSlideSchema = z.strictObject({
  index: z.number(),
  title: z.string().optional(),
  lines: z.array(z.string())
})
export type PreviewSlide = z.infer<typeof previewSlideSchema>

/**
 * workbench:read-bytes 的回包（判别联合）：
 *   - `bytes`：认得出的**字节**格式 + 原始字节（Uint8Array 过结构化克隆，不转 base64）；
 *   - `docx` / `xlsx` / `pptx`：办公三件在**主进程抽好的结构**（markdown / 表 / 文字提要）——
 *     原始字节没有意义（渲染端解不了 OOXML），所以不往 `bytes` 里塞；
 *   - `too-large`：超过该格式的上限（`limit` 是上限本身，渲染端如实说）；
 *   - `unsupported`：扩展名不认得，或文件头与扩展名对不上（渲染端回落二进制占位）；
 *   - `missing`：文件不在磁盘上了（可能刚被删除或改名）。
 */
export const fileBytesResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('bytes'),
    format: fileByteFormatSchema,
    bytes: z.instanceof(Uint8Array),
    size: z.number()
  }),
  z.strictObject({ kind: z.literal('too-large'), size: z.number(), limit: z.number() }),
  z.strictObject({ kind: z.literal('unsupported'), size: z.number() }),
  z.strictObject({ kind: z.literal('missing') }),
  z.strictObject({
    kind: z.literal('docx'),
    markdown: z.string(),
    /** markdown 字符数到上限被截断（内嵌图片一律不抽，见主进程） */
    truncated: z.boolean()
  }),
  z.strictObject({
    kind: z.literal('xlsx'),
    sheets: z.array(previewSheetSchema),
    /** 工作表**张数**到上限被截断（行/列的截断记在各表自己的 `truncated` 上） */
    truncated: z.boolean()
  }),
  z.strictObject({
    kind: z.literal('pptx'),
    slides: z.array(previewSlideSchema),
    truncated: z.boolean()
  })
])
export type FileBytesResult = z.infer<typeof fileBytesResultSchema>

/* ── 文件搜索（round 44） ───────────────────────────────────────────────── */

/**
 * 搜索的两种口径（同一轮只走一种）：
 *   - `name`：按**文件名**匹配（不看路径），递归遍历（跳过 `node_modules` / `.git`）；
 *   - `content`：按**文件内容**匹配（文本文件逐行扫，二进制按"有没有 NUL"跳过）。
 * 两者都不区分大小写；命中里的路径一律是**相对会话根**的写法（正斜杠）。
 */
export const workbenchSearchModeSchema = z.enum(['name', 'content'])
export type WorkbenchSearchMode = z.infer<typeof workbenchSearchModeSchema>

/** 查询至少要有这么多字符（trim 之后）：不够时渲染端不发，主进程闸门也拒 */
export const SEARCH_QUERY_MIN = 2

/**
 * 一条命中：
 *   - `path` / `name`：相对路径（正斜杠）与文件名；
 *   - `line` / `preview`：**内容**命中才有 —— 行号（1 起）与该行预览（已去首尾空白、已截断）。
 */
export const workbenchSearchHitSchema = z.strictObject({
  path: z.string().min(1),
  name: z.string().min(1),
  line: z.number().int().min(1).optional(),
  preview: z.string().optional()
})
export type WorkbenchSearchHit = z.infer<typeof workbenchSearchHitSchema>

/**
 * workbench:search 的回包：
 *   - `results`：命中（顺序 = 遍历顺序：目录在前、名字升序）；
 *   - `truncated`：结果**不是全部** —— 条数到上限 / 时间到预算 / 某个文件只扫了前一段；
 *   - `scanned`：真扫过的文件数（目录不计；跳过的目录里的文件也不计）。
 */
export const workbenchSearchResultSchema = z.strictObject({
  results: z.array(workbenchSearchHitSchema),
  truncated: z.boolean(),
  scanned: z.number()
})
export type WorkbenchSearchResult = z.infer<typeof workbenchSearchResultSchema>

/* ── Git ───────────────────────────────────────────────────────────────── */

/** 未提交变更的归类（由 porcelain 的两字母码算出来，渲染端据此给中文标签与配色） */
export const gitChangeStatusSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'conflicted'
])
export type GitChangeStatus = z.infer<typeof gitChangeStatusSchema>

export const gitChangeSchema = z.strictObject({
  /** 相对仓库根的路径（正斜杠；重命名给新路径） */
  path: z.string().min(1),
  status: gitChangeStatusSchema,
  /** 有已暂存的那一半（porcelain 的第一列不是空格/问号） */
  staged: z.boolean()
})
export type GitChange = z.infer<typeof gitChangeSchema>

/**
 * `workbench:git-overview` 的回包。三种状态：
 *   - `isRepo: false` —— 不是 git 仓库（其余字段无意义）；
 *   - `isRepo: true, empty: true` —— 空仓库（还没有任何提交，分支名可能已经存在）；
 *   - 否则有 `branch` 与 `changes`。
 */
export const gitOverviewSchema = z.strictObject({
  isRepo: z.boolean(),
  empty: z.boolean(),
  /** 当前分支短名（detached HEAD 时给 'HEAD'）；未出生分支给 symbolic-ref 的名字 */
  branch: z.string().nullable(),
  changes: z.array(gitChangeSchema)
})
export type GitOverview = z.infer<typeof gitOverviewSchema>

/** 一条提交历史（`git log --graph` 结构化后的行） */
export const gitCommitSchema = z.strictObject({
  sha: z.string().min(1),
  short: z.string().min(1),
  /** 图形列（`* | \ /` 这些字符，含缩进）；渲染端 monospace 原样画 */
  graph: z.string(),
  /** refs（HEAD -> main, origin/main, tag: v1）；没有就是空串 */
  refs: z.string(),
  subject: z.string(),
  author: z.string(),
  /** ISO 8601（作者时间） */
  date: z.string()
})
export type GitCommit = z.infer<typeof gitCommitSchema>

export const gitLogResultSchema = z.strictObject({ commits: z.array(gitCommitSchema) })

/** 单提交详情里的一个变更文件（`--numstat` 的行；二进制给 null） */
export const gitFileStatSchema = z.strictObject({
  path: z.string().min(1),
  additions: z.number().nullable(),
  deletions: z.number().nullable()
})
export type GitFileStat = z.infer<typeof gitFileStatSchema>

export const gitCommitDetailSchema = z.strictObject({
  sha: z.string().min(1),
  short: z.string().min(1),
  author: z.string(),
  email: z.string(),
  date: z.string(),
  /** 完整提交信息（`%B`：标题 + 正文 + trailer，末尾换行已去掉） */
  message: z.string(),
  files: z.array(gitFileStatSchema)
})
export type GitCommitDetail = z.infer<typeof gitCommitDetailSchema>

/* ── 终端 ──────────────────────────────────────────────────────────────── */

/** 终端会话的自我介绍（start 的回包） */
export const terminalSessionSchema = z.strictObject({
  id: z.string().min(1),
  /** shell 可执行文件的完整路径（排障用；界面不显示） */
  shell: z.string().min(1),
  /** 起始工作目录（= 会话根） */
  cwd: z.string().min(1)
})
export type TerminalSession = z.infer<typeof terminalSessionSchema>

/** 主进程 → 渲染端：一段终端输出 */
export const terminalDataSchema = z.strictObject({ id: z.string().min(1), data: z.string() })

/** 主进程 → 渲染端：终端进程结束（exitCode 为 null 表示被信号杀掉） */
export const terminalExitSchema = z.strictObject({
  id: z.string().min(1),
  exitCode: z.number().nullable()
})
export type TerminalExit = z.infer<typeof terminalExitSchema>
