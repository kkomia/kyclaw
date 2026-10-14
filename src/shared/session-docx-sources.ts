/**
 * 会话↔Word **源结构**的契约：这份 .docx 当初是拿哪份结构渲染出来的。
 *
 * 与「会话↔PPT 源结构」（shared/session-ppt-sources.ts，落 libsql 的 `session_ppt_sources`）同一套路数，
 * 落的是 `session_docx_sources` 表（见 mastra/session-docx-sources.ts）——区别只在**数的东西**：
 *   - `path` 那几列是"哪一份文件"（`(threadId, path)` 是主键：一条会话里可以有好几份文档）；
 *   - `source_json` 是**产出物的输入**（create_docx 当时的 title/blocks），
 *     `blocks` / `sha256` / `size` 是落盘那一刻的**指纹**（块数与文件内容摘要）。
 *
 * 为什么要它：`create_docx` 每调用一次都要求模型把**整份** `blocks` 重发一遍，改一段 = 重发全篇。
 * 有这份源结构之后，`edit_docx` 只收"改第几块 + 改成什么"，其余块从库里读（见 tools/docx-edit.ts）。
 *
 * 指纹为什么要存：文件可能被**用户手动改过**（Word 里改完保存、或删掉）。那时我们记的源已经不是
 * 那份文件的内容了 —— 再按源重渲染就是**静默覆盖用户的改动**。所以编辑前比对指纹，不一致就让调用方
 * 显式选口径（v1 只支持 stop / overwrite，见 docx-edit.ts）。
 */
import { z } from './zod'

/**
 * 源结构 JSON 的**体积上限**（2MB）：`blocks` 单块可以到 2 万字、整篇 1000 块，源结构本身
 * 可能是几十 MB —— 那既写不动库，也不该进模型上下文。超限的**不记录**（不是截断：截断的源
 * 渲染出来会少内容），并在 create_docx 的回执里如实写"源结构未登记，edit_docx 不可用"。
 */
export const MAX_DOCX_SOURCE_BYTES = 2 * 1024 * 1024

/**
 * 一条记录：**某条会话里的某个文件**是用哪种结构渲染出来的。
 *
 * 键是 `(threadId, path)` 而不是只有 `threadId`：一条会话里可以先后做几份不同的文档
 * （"采购管理办法.docx" 与 "周报.docx"），只有 threadId 分不出改的是哪一份。
 */
export const docxSourceRecordSchema = z.strictObject({
  threadId: z.string().min(1),
  /**
   * 会话工作区里的**绝对路径**（落盘那一刻 guard 引擎解析出来的那个 abs）。
   * 用绝对路径当键是因为它唯一：模型给 "文档/a.docx" 与 "./文档/a.docx" 是同一个文件。
   * 编辑时这个路径会被**同一个引擎再解析一遍**（越界/工作区换了都拦得住）。
   */
  path: z.string().min(1),
  /** 渲染这份文件时用的输入（title/blocks 的 JSON 文本；形状由 tools/docx.ts 的 docxSourceSchema 校验） */
  sourceJson: z.string().min(1),
  /** 落盘时的**内容块数**（诊断用：文件被改过时，回执要能报"我记的那份是几块"） */
  blocks: z.number().int().nonnegative(),
  /** 落盘时的文件内容 sha256（指纹主判据） */
  sha256: z.string().min(1),
  /** 落盘时的字节数（指纹辅判据；与 sha256 一起看不一致时能说清"是改了还是被换了"） */
  size: z.number().int().nonnegative(),
  updatedAt: z.string().min(1)
})

export type DocxSourceRecord = z.infer<typeof docxSourceRecordSchema>

/** 写入侧的入参：`updatedAt` 由 store 现算（调用方不该自己编时间） */
export const docxSourceRecordInputSchema = docxSourceRecordSchema.omit({ updatedAt: true })

export type DocxSourceRecordInput = z.infer<typeof docxSourceRecordInputSchema>
