/**
 * 轨迹契约：轨迹视图要的**服务端侧**数据面（渲染端投影出步骤列表与时间轴的原料）。
 *
 * 为什么是新增文件而不是扩既有 schema：轨迹视图的原料只有几样——
 *   1. 存储消息（`GET /api/threads/:id/messages`，既有路由，逐 part 带时间戳）；
 *   2. 该会话的**逐轮用量行**（`usage_runs` 按 thread 升序；本文件定义它的回包）；
 *   3. 压缩记录（`GET /api/threads/:id/compaction`，既有路由）；
 *   4. round 87 起：该会话的**请求快照**（`request_snapshots` 按 thread 升序；本文件定义它的回包）
 *      —— 每一次模型请求（逐步）的摘要 + 按 id 取正文的明细："这一轮实际发出去的请求长什么样"。
 * 前几样各自的既有契约（shared/threads.ts / shared/usage.ts）都在被别的改动碰着，
 * 所以这里只声明"轨迹专用"的那几条回包，不去动别人的 schema。
 *
 * 口径（都是**实测字段**，不是估算）：
 *   - 一行 = `usage_runs` 的一行 = 一次 run（一轮对话的一次模型调用循环）收尾时落的账；
 *   - `createdAt` 是**落账时刻**（run 结束），所以它落在该轮的时间窗内 —— 渲染端按
 *     "该轮起始 → 下一轮起始"归属到轮，不做插值、不摊派；
 *   - 只带 token 口径（用户口径 014：不做计费）—— 回包里没有金额/币种一类字段。
 */
import { z } from './zod'

/** 一次 run 的用量行（usage_runs 的可读形态） */
export const trajectoryUsageRunSchema = z.strictObject({
  id: z.string().min(1),
  /** 该次 run 的 id（Mastra 的 runId；端点没报 = null） */
  runId: z.string().nullable(),
  /** 运行时的模型 id 原文（未知也照记） */
  model: z.string().min(1),
  provider: z.string().nullable(),
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  total: z.number().int().min(0),
  /** provider 报的缓存命中输入；没报 = null（**不是 0**） */
  cachedInput: z.number().int().min(0).nullable(),
  /**
   * 这一轮**最后一次**模型调用的输入 tokens = 这一轮结束时真实的上下文大小。
   * 记账那条线（round 67）加的字段；老记录没有 → null（**不拿 `input` 顶替**）。
   */
  contextInput: z.number().int().min(0).nullable(),
  /** `contextInput` 那一份的缓存命中数（与它同一次调用，配对比值才有意义） */
  contextCachedInput: z.number().int().min(0).nullable(),
  /** 这一轮一共调了几次模型；老记录没有 → null */
  stepCount: z.number().int().min(0).nullable(),
  /** 落账时刻（ISO）——该轮时间窗内，见文件头注 */
  createdAt: z.string()
})

export type TrajectoryUsageRun = z.infer<typeof trajectoryUsageRunSchema>

/** GET /api/usage/thread?threadId= 的回包（时间升序：首行 = 首轮基线，末行 = 最近一轮） */
export const trajectoryThreadUsageResponseSchema = z.strictObject({
  threadId: z.string().min(1),
  runs: z.array(trajectoryUsageRunSchema)
})

export type TrajectoryThreadUsageResponse = z.infer<typeof trajectoryThreadUsageResponseSchema>

/**
 * 一次**模型请求**（step）的摘要（round 87 / 用户反馈 015；`request_snapshots` 的可读形态）。
 *
 * 与用量行同源（都来自 onFinish 事件、都以"run 收尾时刻"归属到轮），但回答的是另一个问题：
 * "这一次**实际发出去**的请求里带了什么" —— 一步一步（一轮里每调一次模型 = 一次请求）。
 * 列表只带**计数与状态**：一条请求的体量实测 ~96 KB（3 条 system 1.4 万字 + 35 件工具 8.1 万字），
 * 长会话整份下发没有意义 —— 正文按 id 从 `GET /api/trajectory/requests/detail` 取。
 */
export const trajectoryRequestSummarySchema = z.strictObject({
  id: z.string().min(1),
  /** 该次 run 的 id；拿不到 = null */
  runId: z.string().nullable(),
  /** 这一次调用是这一轮的第几步（0 基）；失败记录认不出步号 = null */
  step: z.number().int().min(0).nullable(),
  /** `complete` = 拿到了请求体；`error` = 这一次请求失败了（正文未知，见 error） */
  status: z.enum(['complete', 'error']),
  /** 失败原因（已脱敏）；成功 = null */
  error: z.string().nullable(),
  /** 运行时的模型 id 原文 */
  model: z.string().min(1),
  provider: z.string().nullable(),
  /** 这一次请求发出去的消息条数（含 system）；认不出 = null */
  messageCount: z.number().int().min(0).nullable(),
  /** 这一次请求带着几件工具；认不出 = null */
  toolCount: z.number().int().min(0).nullable(),
  /** 系统指令原文长度；请求里没有 system = null */
  systemChars: z.number().int().min(0).nullable(),
  /** 工具表原文长度；没有工具 = null */
  toolsChars: z.number().int().min(0).nullable(),
  /** 有正文被截断（系统指令 / 工具表 / 某条消息超上限）——界面照实标"已截断" */
  truncated: z.boolean(),
  /** 落账时刻（ISO）——该轮时间窗内，见 trajectoryUsageRunSchema 的同名说明 */
  createdAt: z.string()
})

export type TrajectoryRequestSummary = z.infer<typeof trajectoryRequestSummarySchema>

/** 一条发给模型的消息（正文可能超上限被截断；`chars` 是原文长度） */
export const trajectoryRequestMessageSchema = z.strictObject({
  role: z.string().min(1),
  text: z.string(),
  chars: z.number().int().min(0),
  truncated: z.boolean()
})

export type TrajectoryRequestMessage = z.infer<typeof trajectoryRequestMessageSchema>

/**
 * 一次请求的**完整形态**（`GET /api/trajectory/requests/detail?id=`）。
 * 三样正文都是 provider 真收到的原文（媒体 base64 已被换成一行说明，其余一字不改）。
 */
export const trajectoryRequestDetailSchema = trajectoryRequestSummarySchema.extend({
  system: z.string().nullable(),
  tools: z.string().nullable(),
  messages: z.array(trajectoryRequestMessageSchema)
})

export type TrajectoryRequestDetail = z.infer<typeof trajectoryRequestDetailSchema>

/** GET /api/trajectory/requests?threadId= 的回包（时间升序，同步号升序） */
export const trajectoryThreadRequestsResponseSchema = z.strictObject({
  threadId: z.string().min(1),
  requests: z.array(trajectoryRequestSummarySchema)
})

export type TrajectoryThreadRequestsResponse = z.infer<
  typeof trajectoryThreadRequestsResponseSchema
>

/** GET /api/trajectory/requests/detail?id= 的回包 */
export const trajectoryRequestDetailResponseSchema = z.strictObject({
  request: trajectoryRequestDetailSchema
})

export type TrajectoryRequestDetailResponse = z.infer<typeof trajectoryRequestDetailResponseSchema>
