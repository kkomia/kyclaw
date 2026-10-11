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
