/**
 * 轨迹契约：轨迹视图要的**服务端侧**数据面（渲染端投影出步骤列表与时间轴的原料）。
 *
 * 为什么是新增文件而不是扩既有 schema：轨迹视图的原料只有三样——
 *   1. 存储消息（`GET /api/threads/:id/messages`，既有路由，逐 part 带时间戳）；
 *   2. 该会话的**逐轮用量行**（`usage_runs` 按 thread 升序；本文件定义它的回包）；
 *   3. 压缩记录（`GET /api/threads/:id/compaction`，既有路由）。
 * 前两样各自的既有契约（shared/threads.ts / shared/usage.ts）都在被别的改动碰着，
 * 所以这里只声明"轨迹专用"的那一条回包，不去动别人的 schema。
 *
 * 口径（都是**实测字段**，不是估算）：
 *   - 一行 = `usage_runs` 的一行 = 一次 run（一轮对话的一次模型调用循环）收尾时落的账；
 *   - `createdAt` 是**落账时刻**（run 结束），所以它落在该轮的时间窗内 —— 渲染端按
 *     "该轮起始 → 下一轮起始"归属到轮，不做插值、不摊派；
 *   - `cost` 为 null = 价目表不认识这个模型（只记 token），不是"花费为 0"。
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
  /** 该次 run 的花费；价目表没有这个模型 = null */
  cost: z.number().nullable(),
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
