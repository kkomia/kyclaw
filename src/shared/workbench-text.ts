/**
 * **文本分页通道**（`workbench:read-text-page` / `workbench:text-version`）的跨进程协议。
 *
 * 为什么要有这条：既有的文本预览走 `workbench:read-file`，**一次读完 64KB 就到底** ——
 * 大文件（日志、长文档、生成物）只能看到开头，没有"加载更多"这条路。这一条把"读文本"拆成
 * **有界的一页一页**，让整份文本都看得到，同时不出下面这些岔子：
 *
 *   - **不交半截字节**：页边界永远落在 `\n` 之后（或超长行按规定切开），并**从 UTF-8 字符边界上收**
 *     （复用 `trimIncompleteTail` 的口径）——渲染端把各页**直接拼接**就是原文，多一个字符少一个字符都不行；
 *   - **不混两个版本**：第一页回 `version`（`size:mtimeMs`，与办公档同一条派生口径）；续读必须带上它，
 *     与当前文件不符即回 `changed`，渲染端**只提示、不拼接**（旧内容与新增内容混排比"看不到"更糟）；
 *     读的当口文件在变（开读前后两次 stat 不同）同样回 `changed`；
 *   - **超长单行有上限**：一页最多 `TEXT_PAGE_MAX_BYTES`，但"一行 200MB"的压缩件/生成件不能靠
 *     "找上一行末尾"来收敛 —— 找不到行边界时按 `TEXT_PAGE_MAX_LINE_BYTES` 切开并置 `overlongLine`，
 *     渲染端据此如实说明"这一行被切开了"；
 *   - **EOF 与错误都显式**：`eof` 为真就是读完了；`binary` / `missing` / `too-large` / `changed`
 *     各有判别结果，不用"空文本"这种含糊话糊过去。
 *
 * 安全口径与其它工作台读通道同源：会话根只在主进程解析、containment 走 `resolveInsideWorkspace`、
 * **绝对路径不给渲染端**；这条通道本身**不落任何跨请求状态**（没有 watcher、没有缓存），
 * 所以渲染端卸载即自然清算（轮询间隔由渲染端自己持有并清理）。
 */
import { z } from './zod'

/** 一页最多读多少字节（在主进程截到行边界；超长单行再受下面那条约束）。 */
export const TEXT_PAGE_MAX_BYTES = 256 * 1024

/** 单页里一行最多多少字节；超了就把这一行切成多段（`overlongLine: true`），保证一页有界。 */
export const TEXT_PAGE_MAX_LINE_BYTES = 32 * 1024

/**
 * 单个文本文件的展示上限（字节）：64MB。
 * 超过它就不是"在预览里看文本"了（渲染端还在累加各页），如实回 `too-large` 让人用别的办法看。
 * 这个数远大于旧文本通道的 5MB（`PREVIEW_MAX_BYTES`）—— 分页存在的意义就是让大文件能看。
 */
export const TEXT_FILE_MAX_BYTES = 64 * 1024 * 1024

/**
 * 续读游标：`offset` = 上一页的 `nextOffset`，`version` = 上一页的 `version`。
 * 第一页传 `null`（见 `textPageArgsSchema`）。
 */
export const textPageCursorSchema = z.strictObject({
  offset: z.number().int().min(0),
  version: z.string().min(1)
})
export type TextPageCursor = z.infer<typeof textPageCursorSchema>

/** `workbench:read-text-page` 的入参：[threadId, relative, cursor|null]（null = 读第一页）。 */
export const textPageArgsSchema = z.tuple([
  z.string().min(1),
  z.string(),
  textPageCursorSchema.nullable()
])

/**
 * `workbench:read-text-page` 的回包（判别联合）：
 *   - `page`：这一页的文本 + 游标。`text` 是**原文切片**（未做任何替换）；
 *     `nextOffset` 是下一页的起点；`eof` 为真表示读完了；
 *   - `binary`：页里出现 NUL（第一页判定；不是文本档，不吐乱码）；
 *   - `missing`：文件不在磁盘上了；
 *   - `too-large`：超过 `TEXT_FILE_MAX_BYTES`（`limit` 就是那个上限）；
 *   - `changed`：文件与请求里的 `version` 不符，或读的当口正在被改 —— **不交半截**，重读即可。
 */
export const textPageResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('page'),
    text: z.string(),
    /** 这一页从哪个字节开始（续读时与请求里的 offset 相同） */
    offset: z.number().int().min(0),
    /** 下一页从哪个字节开始；`eof` 为真时等于文件大小 */
    nextOffset: z.number().int().min(0),
    /** 读这一页时看到的文件大小（整个文件，不是这一页） */
    size: z.number().int().min(0),
    /** 这一页所属的文件版本（`size:mtimeMs`）；续读必须原样带回来 */
    version: z.string().min(1),
    /** 读完（`nextOffset === size`） */
    eof: z.boolean(),
    /** 这一页为"超长单行"切开过一次（渲染端如实说明，正文不受影响） */
    overlongLine: z.boolean()
  }),
  z.strictObject({ kind: z.literal('binary'), size: z.number() }),
  z.strictObject({ kind: z.literal('missing') }),
  z.strictObject({ kind: z.literal('too-large'), size: z.number(), limit: z.number() }),
  z.strictObject({ kind: z.literal('changed') })
])
export type TextPageResult = z.infer<typeof textPageResultSchema>
/** 成功的那一支（渲染端累加时用）。 */
export type TextPage = Extract<TextPageResult, { kind: 'page' }>

/** `workbench:text-version` 的入参：[threadId, relative]（只 stat、不读正文）。 */
export const textVersionArgsSchema = z.tuple([z.string().min(1), z.string()])

/**
 * `workbench:text-version` 的回包：给"文件变了没有"的轮询用。
 * 只回版本与大小（不读正文）：看见版本变了就提示/重读，**不静默把新内容拼进来**。
 */
export const textVersionResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('version'),
    version: z.string().min(1),
    size: z.number().int().min(0)
  }),
  z.strictObject({ kind: z.literal('missing') })
])
export type TextVersionResult = z.infer<typeof textVersionResultSchema>
