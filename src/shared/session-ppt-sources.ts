/**
 * 会话↔PPT **源结构**的契约（round 76）：这份 .pptx 当初是拿哪份结构渲染出来的。
 *
 * 与「会话↔项目映射」「会话↔PPT 模板映射」同一套路数的第三张会话级表（落 libsql 的
 * `session_ppt_sources`，见 mastra/session-ppt-sources.ts）——区别在**存的东西**：
 *   - 那两张存的是"选了一个什么"（模板名 / 项目 id），一行一个字符串；
 *   - 这张存的是**产出物的输入**（`source_json` = create_ppt 当时的 title/subtitle/theme/slides）
 *     ＋落盘那一刻文件的**指纹**（sha256 + 字节数）。
 *
 * 为什么要它：`create_ppt` 每调用一次都要求模型把**整份** `slides` 重发一遍，改一页 = 重发全篇
 * （实测量化过：一次"简单做 PPT"里自检后改 4 版 = 输出 token 7.9K → 20.2K、成本 1.8×）。
 * 有这份源结构之后，`edit_ppt` 只收"改哪一页 + 改什么"，其余页从库里读。
 *
 * 指纹为什么要存：文件可能被**用户手动改过**（PowerPoint 里改完保存、或删掉）。那时我们记的源
 * 已经不是那份文件的内容了 —— 再按源重渲染就是**静默覆盖用户的改动**。所以编辑前比对指纹，
 * 不一致就让调用方显式选：以源为准覆盖，还是以文件为准重建源（见 tools/ppt-edit.ts）。
 */
import { z } from './zod'

/**
 * 一条记录：**某条会话里的某个文件**是用哪种结构渲染出来的。
 *
 * 键是 `(threadId, path)` 而不是只有 `threadId`：一条会话里可以先后做几份不同的演示文稿
 * （"年度规划.pptx" 与 "周报.pptx"），只有 threadId 分不出改的是哪一份。
 */
export const pptSourceRecordSchema = z.strictObject({
  threadId: z.string().min(1),
  /**
   * 会话工作区里的**绝对路径**（落盘那一刻 guard 引擎解析出来的那个 abs）。
   * 用绝对路径当键是因为它唯一：模型给 "演示/a.pptx" 与 "./演示/a.pptx" 是同一个文件。
   * 编辑时这个路径会被**同一个引擎再解析一遍**（越界/工作区换了都拦得住）。
   */
  path: z.string().min(1),
  /** 渲染这份文件时用的输入（title/subtitle/theme/slides 的 JSON 文本；形状由 ppt.ts 校验） */
  sourceJson: z.string().min(1),
  /** 落盘时的页数（诊断用：文件被改过时，回执要能报"我记的那份是几页"） */
  pages: z.number().int().nonnegative(),
  /** 落盘时的文件内容 sha256（指纹主判据） */
  sha256: z.string().min(1),
  /** 落盘时的字节数（指纹辅判据；与 sha256 一起看不一致时能说清"是改了还是被换了"） */
  size: z.number().int().nonnegative(),
  updatedAt: z.string().min(1)
})

export type PptSourceRecord = z.infer<typeof pptSourceRecordSchema>

/** 写入侧的入参：`updatedAt` 由 store 现算（调用方不该自己编时间） */
export const pptSourceRecordInputSchema = pptSourceRecordSchema.omit({ updatedAt: true })

export type PptSourceRecordInput = z.infer<typeof pptSourceRecordInputSchema>
