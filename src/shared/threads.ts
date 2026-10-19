/**
 * 线程（会话）契约：agent 服务的线程 HTTP 路由、渲染端线程客户端、消息回灌共用一处。
 *
 * 边界与 IPC 同款：入参（路由参数 / 请求体）与回包都给 zod schema，两侧 parse。
 * 走 `./zod` 的 jitless 入口——渲染端与 preload 一样受 CSP 限制（禁 new Function）。
 *
 * `StoredMessage` 刻意是**松**结构：它是 Mastra 存储里的消息 JSON（format 2 的 parts 数组，
 * 形状由存储层决定），跨版本演进时宁可让映射层逐 part 防御，也不在这里把 schema 写死成
 * 一版零件的白名单。
 */
import { z } from './zod'

/** 本机用户固定资源 id：MVP 单用户，agent 服务只认这一个 resource（多用户是后话） */
export const LOCAL_USER_RESOURCE_ID = 'local-user'

/**
 * chat 路由的线程上下文 —— **Mastra `AgentMemoryOption` 的形状**：
 * chatRoute 把请求体里除了 messages/trigger 之外的字段原样当 `agent.stream()` 的选项，
 * 所以这个字段名（`memory.thread` / `memory.resource`）是服务端唯一认的口径。
 * 渲染端发请求、服务端测试造请求都从这里来：两边共用同一个构造函数，
 * 名字写错就是测试红，而不是"对话看着正常、其实什么都没存"（T9 冒烟抓到的真事）。
 */
export function threadMemoryBody(threadId: string): {
  memory: { thread: string; resource: string }
} {
  return { memory: { thread: threadId, resource: LOCAL_USER_RESOURCE_ID } }
}

/** 侧栏一条会话要的最小集（GET /api/threads 的回包元素） */
export const threadSummarySchema = z.strictObject({
  id: z.string().min(1),
  /** 标题：未生成为 null（存储里是空串，路由层归一化） */
  title: z.string().nullable(),
  /** ISO 时间串（分组"今天/更早"、排序都用它） */
  updatedAt: z.string()
})

export type ThreadSummary = z.infer<typeof threadSummarySchema>

/** GET /api/threads 的回包 */
export const threadListResponseSchema = z.strictObject({
  threads: z.array(threadSummarySchema)
})

/**
 * 存储消息（MastraDBMessage 的 JSON 形态）：只锁 id/role/content 三件事，
 * 其余字段（createdAt / threadId / resourceId / content 里的 parts）由映射层逐项防御。
 */
export const storedMessageSchema = z.looseObject({
  id: z.string().min(1),
  role: z.string().min(1),
  content: z.unknown()
})

export type StoredMessage = z.infer<typeof storedMessageSchema>

/** GET /api/threads/:id/messages 的回包 */
export const threadMessagesResponseSchema = z.strictObject({
  messages: z.array(storedMessageSchema)
})

/** PATCH /api/threads/:id 的入参（重命名） */
export const renameThreadRequestSchema = z.strictObject({
  title: z.string().trim().min(1).max(120)
})

/**
 * POST /api/threads 的入参（round 26）：把草稿会话**物化**成真实线程——与"首条消息建线程"
 * 同一条存储路径（`memory.createThread`），只是不带消息。置顶/归档/移至项目这类
 * "给会话记归属"的动作要求服务端认识它，所以先物化再执行；已在的线程幂等回现况。
 */
export const createThreadRequestSchema = z.strictObject({
  threadId: z.string().min(1).max(200),
  /** 创建时就带标题（草稿被就地重命名过时把本地标题带过来；不传 = 无标题） */
  title: z.string().trim().min(1).max(120).optional()
})

/** POST /api/threads/:id/truncate 的入参（R2：编辑重发的服务端半边，从这条消息起截掉） */
export const truncateThreadRequestSchema = z.strictObject({
  messageId: z.string().min(1)
})

/** 截断回包：被删掉的条数（线程/消息不存在时就是 0，幂等） */
export const truncateThreadResponseSchema = z.strictObject({
  deleted: z.number().int().min(0)
})

/** POST /api/threads/:id/title 的回包：是否本次真生成（已有标题时为 false） */
export const threadTitleResponseSchema = z.strictObject({
  title: z.string(),
  generated: z.boolean()
})

/**
 * 压缩档位：**这次是怎么省的**——记录里区分出来，供分界线 / 轨迹页说人话。
 * 数组顺序 = 力度递增的顺序（从轻到重），也是机器档"同一档不重复停"的次序：
 *
 *   - `snip`（裁剪，round 75）：只把**较早的大工具结果**换成占位说明（工具名 + 参数 + 开头
 *     若干行 + "去哪找"），用户原话与助手文字一字不动、消息一条不删；
 *   - `dedupe`（去重，round 75）：在裁剪之上，再把与更早结果重复的工具结果指向首次出现处
 *     （零信息损失）；
 *   - `fold`（折叠，round 76）：在前两档之上，再把**较早那几段已经结束的对话**里助手的正文
 *     折成一行"这里折了 N 条消息、讲的是…"（用户原话永不折叠，工具结果仍由前两档管）；
 *   - `summary`（摘要，round 19）：前面三档都不够时才走的老路——调模型把旧段摘成结构化
 *     摘要、原文删除。
 *
 * 前三档（`snip` / `dedupe` / `fold`）都是**零 API 成本**的（不调模型、不记账、不删消息，
 * 改写只发生在"这一轮发给模型的那份"上）；只有它们都不够才走 `summary`（那一档要付一次
 * 模型调用、且会删掉旧消息）。
 * 老库（round 71 及更早）的记录没有这一列，读出来按 `summary` 归一（那时只有摘要这一条路）。
 */
export const compactionLevels = ['snip', 'dedupe', 'fold', 'summary'] as const

export const compactionLevelSchema = z.enum(compactionLevels)

export type CompactionLevel = z.infer<typeof compactionLevelSchema>

/**
 * 会话级压缩记录（round 19）：更早的历史被摘要后，原始消息从存储删除，摘要存这里。
 * 后续请求由 agent 的输入处理器把摘要注入成系统前缀（不落 UI 消息流）；顶部标记读它。
 *
 * round 75 起这条记录也承载**机械档**（snip / dedupe，round 76 又加了 fold）：那时没有摘要、
 * 也没有消息被删——`summary` 字段装的是"这次精简/折叠了什么"的人话说明（分界线展开里给
 * 用户看的那段）。
 */
export const threadCompactionSchema = z.strictObject({
  threadId: z.string().min(1),
  /**
   * 摘要原文（`summary` 档）或"这次是怎么省的"的人话说明（`snip` / `dedupe` / `fold` 档）；
   * 两种都非空——分界线展开后显示的就是它。
   */
  summary: z.string().min(1),
  /**
   * 被处理的消息条数：`summary` 档 = 被摘要并删除的条数；`snip` / `dedupe` 档 = 被改写的
   * 条数（工具结果换成占位 / 指向首次出现处，消息本身没删）；`fold` 档 = 被折叠的消息条数
   * （助手正文换成折叠说明，消息本身没删）。
   */
  summarized: z.number().int().min(1),
  /**
   * 保留的最近消息条数（压缩时刻）。
   * PB-024：内核没有 kept 字段；DSH 路径无法给出这个数字时必须是 null（UI 显示 —），
   * 不允许用派生值冒充精确值。
   */
  kept: z.number().int().min(0).nullable(),
  /**
   * round 75：本次走的档位（见 compactionLevels）。
   *
   * **服务端每条记录都会写**（老库的行读出来归一成 `summary`，见 compaction.ts 的
   * `compactionLevelOf`），所以回包上总有值；这里写成可选是**读侧宽容**：既有的记录字面量
   * （测试夹件、渲染端夹具）不必为一个新字段集体补值，读侧按 `level ?? 'summary'` 解释——
   * 缺省语义正好等于 round 75 之前的唯一档位。
   */
  level: compactionLevelSchema.optional(),
  /** ISO 时间串（压缩完成时刻） */
  createdAt: z.string(),
  /**
   * round 59：压缩前的上下文 token（该会话最近一轮输入的实测值；拿不到 = null）。
   * 与 tokensAfter 一起给对话流里的「上下文已压缩（before → after tokens）」分界线用。
   */
  tokensBefore: z.number().int().min(0).nullable(),
  /**
   * round 59：压缩后的上下文 token（**估算**：真实基线 + 摘要与保留消息的字符折算；
   * 公式与理由见 src/mastra/compaction.ts 的 estimateTokens 注释；拿不到 = null）。
   */
  tokensAfter: z.number().int().min(0).nullable()
})

export type ThreadCompaction = z.infer<typeof threadCompactionSchema>

/** POST /api/threads/:id/compact 的入参：keep = 保留最近多少条（缺省由服务端定） */
export const compactThreadRequestSchema = z.strictObject({
  keep: z.number().int().min(2).max(40).optional()
})

/** 压缩回包：compacted=false（没到可压的规模）时 compaction 为现有记录或 null */
export const compactThreadResponseSchema = z.strictObject({
  compacted: z.boolean(),
  compaction: threadCompactionSchema.nullable()
})

/** GET /api/threads/:id/compaction 的回包（没有记录 = null，读侧幂等） */
export const threadCompactionResponseSchema = z.strictObject({
  compaction: threadCompactionSchema.nullable()
})

/** 无内容回包（删除等） */
export const okResponseSchema = z.strictObject({ ok: z.literal(true) })

/** 带 :id 的路由参数 */
export const threadIdParamsSchema = z.strictObject({
  id: z.string().min(1).max(200)
})
