/**
 * 用户消息的**展示上下文 + 发送时刻协议**（0.1.3 / 006 + 008）：
 * 渲染端写入、历史回读（lib/message-map）读出的那一份 metadata 形状，**契约放这里**，
 * 两侧共用一份 schema —— 形状漂了就是这里红。
 *
 * 为什么放 shared：写侧（features/chat/composer-attachments 组装 + ChatPage 落 metadata）与
 * 读侧（lib/message-map 从存储回读）分属两层，lib 不依赖 features（本仓的分层口径），
 * 于是契约单独一处；带平台能力（crypto.subtle）的行为不放这里，留在 features/chat/message-context.ts。
 *
 * 三件事（详细口径见 features/chat/message-context.ts 头注）：
 *   1. `kyclawContext`：这次组装往正文里追加了哪几段附件 / 摘选、各自边界与摘要；
 *   2. `kyclawSentAt`：用户消息的**发送时刻**（自有键；不复用 `createdAt` —— 见那一格的注释）；
 *   3. `formatSentAt` / `readSentAt`：本地时间文案与回读（008 的气泡发送时间；返工后是裸文字）。
 *
 * metadata 是**旁注**：它**不改**模型拿到的正文与 file part（两者逐字相同）；读坏了一律按原文显示。
 * 摘录的口径是"不复制**大段**正文"——单段最多留 48 字头尾（短段即整段），正文本身不整段进 metadata。
 *
 * 体量口径（138 复核要求）：单个条目里的字符串字段都有长度上限，整份上下文还有**总量上限** ——
 * 超限不采信（读侧）/ 不写（写侧），一律退化成"按原文显示"，不会把大正文或脏数据带进存储。
 * 总量按**真 UTF-8 字节**算（`TextEncoder`），不是 UTF-16 字符数 —— 中文路径 / 内容不会被低估。
 */
import { z } from './zod'

/** 展示上下文那一格的键名（放进 content.metadata） */
export const MESSAGE_CONTEXT_KEY = 'kyclawContext'

/**
 * 发送时刻那一格的键名（008 复核后新立）：**我们自己的键**，刻意不复用 `metadata.createdAt`。
 *
 * 为什么：Mastra 的 **v5 UI 消息**适配路径会把它认识的 `metadata.createdAt` 从
 * `content.metadata` 里剔掉（`AIV5Adapter.fromUIMessage` 的 cleanMetadata），而带 file part
 * 的消息正走那条路 —— 复用 `createdAt` 就会出现"图片消息的发送时刻在落库时被吃掉"。
 * 自有键不参与任何适配器的识别，原样落库、原样读回（实测见 message-context-wire.spec.ts）。
 */
export const SENT_AT_KEY = 'kyclawSentAt'

/** 这份展示记录的版本（不认识就不采信：宁可显示原文，也不猜新格式） */
export const MESSAGE_CONTEXT_VERSION = 1

/**
 * 头尾摘录各取多少字符：**同步一阶**的门槛（不必算摘要就能判"这一段的头尾还对得上吗"）。
 *
 * 口径说清楚（138 复核）：摘录最多 48 字/段，**≤48 字的短段等于整段原样留档** —— 它本来
 * 就只有这么长；真正的口径是"不复制**大段**正文"：整份附件内容（PDF 抽取文本可达 6.4 万字符、
 * 文本内联 16KB）不会被整段复制进 metadata。
 */
export const SEGMENT_EXCERPT_CHARS = 48

/** 追加段之间的分隔符（与 composeOutgoingText 的 `blocks.join('\n\n')` 同一份口径） */
export const BLOCK_JOIN = '\n\n'

/** 一条消息最多记多少条上下文（防御脏数据；正常远小于这个数） */
const MAX_ENTRIES = 200

/** 条目里「名字」的长度上限（正常是文件名；zod 的字符串长度按 UTF-16 码元计） */
export const CONTEXT_NAME_MAX_CHARS = 256

/** 条目里「来源 / 绝对路径」的长度上限（超长路径按脏数据处理，不采信） */
export const CONTEXT_SOURCE_MAX_CHARS = 1024

/**
 * 整份展示上下文的总量上限：**UTF-8 字节数**（16 Ki ≈ 1.6 万个 ASCII 字符；中文按 3 字节算）。
 * 超了：读侧整块不采信、写侧干脆不挂 —— 两条路都退化成"按原文显示"，不会半藏半露。
 */
export const MESSAGE_CONTEXT_MAX_BYTES = 16 * 1024

/** 复用同一个 encoder（TypedArray 分配只在这里发生；共享模块顶层建一次是安全的） */
const utf8Encoder = new TextEncoder()

/** UTF-8 真字节数（`String.length` 是 UTF-16 码元，中文会被低估三分之一，不拿它当字节用） */
function utf8Bytes(text: string): number {
  return utf8Encoder.encode(text).byteLength
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 应当是 64 位小写 hex')

const appendSegmentSchema = z
  .strictObject({
    /** 这一段的 UTF-16 长度（与 `String.prototype.length` 同口径） */
    length: z.number().int().positive(),
    /** 它前面垫了几个分隔符字符：0 = 它是正文的第一段；2 = 前面还有正文 / 别的段 */
    join: z.union([z.literal(0), z.literal(2)]),
    /** 段首摘录（长度 = min(48, length)） */
    head: z.string().min(1),
    /** 段尾摘录（长度 = min(48, length)） */
    tail: z.string().min(1),
    /** 发送时算好的 SHA-256；null = 平台没有 crypto.subtle / 边界没对上（这种段不藏） */
    sha256: sha256Schema.nullable()
  })
  .refine(
    (segment) => {
      const excerpt = Math.min(SEGMENT_EXCERPT_CHARS, segment.length)
      return segment.head.length === excerpt && segment.tail.length === excerpt
    },
    { message: '头尾摘录长度应当等于 min(48, length)' }
  )

const contextEntrySchema = z.strictObject({
  /** file = 文件（整份 / 路径引用）；quote = 摘选；image = 随消息真发的图片（不在下方重复画） */
  kind: z.enum(['file', 'quote', 'image']),
  /** 文件名 / 摘选名（气泡下方图标项上写的那个名字） */
  name: z.string().min(1).max(CONTEXT_NAME_MAX_CHARS),
  size: z.number().int().nonnegative(),
  /** 正文抬头里用的那个标签（路径引用 = 路径；整文件 = 相对路径；都没有 = 文件名） */
  source: z.string().min(1).max(CONTEXT_SOURCE_MAX_CHARS),
  /** 拿得到绝对路径时的那一份（图标项的 tooltip 用） */
  absolute: z.string().min(1).max(CONTEXT_SOURCE_MAX_CHARS).optional(),
  /** 摘选在源文里的行号区间（1 基闭区间；定位不到就没有） */
  lines: z
    .strictObject({ start: z.number().int().positive(), end: z.number().int().positive() })
    .optional(),
  /** PDF 抽取信息 */
  pdf: z.strictObject({ pages: z.number().int().nonnegative(), truncated: z.boolean() }).optional(),
  /** 真被追加进正文的那一段（图片没有；其余条目正常情况下都有） */
  append: appendSegmentSchema.optional()
})

const messageContextBaseSchema = z.strictObject({
  v: z.literal(MESSAGE_CONTEXT_VERSION),
  entries: z.array(contextEntrySchema).max(MAX_ENTRIES)
})

export type AppendSegment = z.infer<typeof appendSegmentSchema>
export type ContextEntry = z.infer<typeof contextEntrySchema>
export type MessageContext = z.infer<typeof messageContextBaseSchema>

/** 基础形状先立（`MessageContext` 从它推出来），再挂体量 refine —— 避免"自引用类型"（tsc 2456） */
const messageContextSchema = messageContextBaseSchema.refine(messageContextFits, {
  message: '展示上下文超过体量预算'
})

/**
 * 整份上下文是否在总量预算内（写侧挂之前、读侧采信之前都过这一道）。
 * 口径是**真 UTF-8 字节**（见 MESSAGE_CONTEXT_MAX_BYTES），不是 `String.length`。
 * 序列化失败（循环引用之类）也算超限：宁可不藏，也不带一份说不清的东西上屏。
 */
export function messageContextFits(context: MessageContext): boolean {
  try {
    return utf8Bytes(JSON.stringify(context)) <= MESSAGE_CONTEXT_MAX_BYTES
  } catch {
    return false
  }
}

/**
 * 从消息 metadata 里读回展示记录：**只认完整合规的一份**（含体量上限），任何一处不合规 = null
 * （调用方拿到 null 就按原文显示 —— 保守方向写死在这里）。
 */
export function readMessageContext(metadata: unknown): MessageContext | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const raw = (metadata as Record<string, unknown>)[MESSAGE_CONTEXT_KEY]
  if (raw === undefined) return null
  const parsed = messageContextSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** 时间值 → epoch ms（Date / ISO 串 / 正数毫秒都认；别的一律 null） */
function timeOf(value: unknown): number | null {
  if (value instanceof Date) {
    const at = value.getTime()
    return Number.isFinite(at) ? at : null
  }
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value === 'string') {
    const at = Date.parse(value)
    return Number.isNaN(at) ? null : at
  }
  return null
}

/** 一条消息的时间来源（008）：`exact` 区分"发送那一刻的精确记录"与"存储落库的记录时间" */
export interface SentAtSource {
  /** epoch ms */
  at: number
  /**
   * true = 来自 `kyclawSentAt`（我们自己写的**发送时刻**，逐毫秒准）；
   * false = 来自 `createdAt`（历史消息的**记录时间**：落库时刻，够用但不是按下发送的那一瞬）。
   */
  exact: boolean
}

/**
 * 消息的时间：`kyclawSentAt` 优先（精确发送时刻），没有才认 `createdAt`
 * （回读时 message-map 挂的是存储自己落的**记录时间**；旧消息只有它）。
 * 两者都读不出来 = null（**不编造**：没有就是没有，气泡不画时间）。
 */
export function readSentAt(metadata: unknown): SentAtSource | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const record = metadata as Record<string, unknown>
  const exact = timeOf(record[SENT_AT_KEY])
  if (exact !== null) return { at: exact, exact: true }
  const recorded = timeOf(record.createdAt)
  return recorded === null ? null : { at: recorded, exact: false }
}

/** 发送时刻的**本地**呈现（008）：`YYYY-MM-DD HH:mm`，本机时区、零本地化歧义（不看 locale） */
export function formatSentAt(epochMs: number): string {
  const at = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    ` ${pad(at.getHours())}:${pad(at.getMinutes())}`
  )
}

/**
 * 从一段追加段文字算出的 append 记录（长度 + 头尾摘录；摘要另外盖章）。
 * 放 shared 的原因：写侧（组装）与读侧的核验口径必须逐字一致，共用同一个构造。
 */
export function appendSegmentOf(segment: string, join: 0 | 2): AppendSegment {
  return {
    length: segment.length,
    join,
    head: segment.slice(0, SEGMENT_EXCERPT_CHARS),
    tail: segment.slice(-SEGMENT_EXCERPT_CHARS),
    sha256: null
  }
}
