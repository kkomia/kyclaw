/**
 * 附件口径的**跨进程常量与契约**（模块 2）：渲染端的 composer 与主进程的 PDF 抽取共用一处。
 *
 * 为什么单独一份（不并进 shared/ipc.ts）：这些是"业务上限"，两边的判定都要用同一组数字——
 * 渲染端拦在选文件那一步（给用户人话），主进程再拦一道（IPC 是另一个入口，谁能保证只有 composer 会用）。
 * 尺寸常量写成字节、字数写成字符，名字里带单位，避免 16*1024 那种"数着零读"。
 *
 * 图片上限的取值：不开 vision 的模型会**人话拒收**图片，所以上限只需要照顾"能收"的那一路——
 * 8MB 是单张截图/照片的常见上限（再大就该先压缩，v2 的事）。
 */
import { z } from './zod'

/** 文本类附件的内联上限（byte）：内容会进消息文本与气泡，避免一条消息膨胀成几 MB */
export const ATTACHMENT_MAX_BYTES = 16 * 1024

/** 图片附件上限（byte）：vision=true 时随消息真发（data URL），太大就先别发 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024

/** 认得出的图片 MIME（都要走 data URL 真发；别的一律按"不是文本文件"拒收） */
export const IMAGE_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif'
] as const

/**
 * PDF 原文件上限（byte）：它要整份过 IPC 到主进程抽取，是内存/IPC 的护栏而不是业务口径
 * （正常文档远小于它；超了给人话拒收，不做"截一半去解析"那种半截事）。
 */
export const PDF_MAX_BYTES = 64 * 1024 * 1024

/** PDF 页数上限：只抽前这么多页（超了在结果里标 truncated，界面据实说"只读了前 N 页"） */
export const PDF_MAX_PAGES = 200

/** 单页文本截断（字符）：一页排版成几十万字的那种（表格/日志）不该整页灌进消息 */
export const PDF_PAGE_MAX_CHARS = 8_000

/**
 * 抽取文本的总量上限（字符）：文本类附件的内联上限是 16KB，PDF 按"一份文档"的口径放宽到
 * 64K 字符（约四倍字节数；中文一个字三字节，实际落进 message 的体量仍在几十 KB 级）。
 * 到顶就截断并留一行说明——不静默丢内容。
 */
export const PDF_TEXT_MAX_CHARS = 64_000

/**
 * PDF 文本抽取结果：`ok:false` 是**产品语言的一等结果**（扫描件、加密、半截文件），
 * 不抛异常——渲染端把它当"这个附件没收"的原样提示展示（与 translate:run 同一口径）。
 */
export const pdfExtractResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    /** 原文件页数 */
    pages: z.number().int().nonnegative(),
    /** 是否因页数/字数上限被截断 */
    truncated: z.boolean(),
    /** 带页码标记的内联文本 */
    text: z.string()
  }),
  z.strictObject({ ok: z.literal(false), message: z.string() })
])

export type PdfExtractResult = z.infer<typeof pdfExtractResultSchema>
