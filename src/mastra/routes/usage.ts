/**
 * 用量 API（T14；round 18 加会话上下文）——挂在 agent 服务（service.ts）上的 Hono 子路由：
 *
 * 三条：
 *   GET /api/usage?range=today|month    窗口内的 token 与花费（含按模型拆分）
 *   GET /api/usage/context?threadId=    该会话的"最近一轮 / 首轮基线 / 今日缓存合计"
 *                                       （上下文环与 hover 明细的数据面）
 *   GET /api/usage/thread?threadId=     该会话的**逐轮用量行**（时间升序）——轨迹视图的
 *                                       "这一轮 token 花在哪"的原料（见 shared/trajectory.ts）
 *
 * 纪律同线程/MCP 路由：入参过 zod（range / threadId 脏值即 400）、回包过 shared/usage 的 schema。
 * 窗口边界按**本地日历**切（rangeStart），与用户在页面上看到的"今天/本月"一致。
 */
import { Hono } from 'hono'
import { usageRangeSchema, usageResponseSchema, usageThreadContextSchema } from '../../shared/usage'
import { trajectoryThreadUsageResponseSchema } from '../../shared/trajectory'
import { rangeStart, summarizeUsage, threadTokenReadout, type UsageStore } from '../usage'

export interface UsageRouterOptions {
  store: UsageStore
  /** 测试注入"现在"；生产不传 = 真时间 */
  now?: () => Date
}

function badRequest(detail: string): { error: string } {
  return { error: `invalid-input: ${detail}` }
}

export function createUsageRouter(options: UsageRouterOptions): Hono {
  const router = new Hono()
  const now = options.now ?? ((): Date => new Date())

  router.get('/', async (context) => {
    // 不传 range 走"今天"（页面默认档）；脏值 400，不静默回落
    const range = usageRangeSchema.safeParse(context.req.query('range') ?? 'today')
    if (!range.success) return context.json(badRequest('range'), 400)

    const rows = await options.store.listSince(rangeStart(range.data, now()))
    return context.json(usageResponseSchema.parse(summarizeUsage(rows, range.data)))
  })

  router.get('/context', async (context) => {
    const raw = context.req.query('threadId')
    const threadId = typeof raw === 'string' ? raw.trim() : ''
    if (threadId === '') return context.json(badRequest('threadId'), 400)

    // round 59：lastInput / baselineInput / lastCachedInput 统一走 usage.ts 的 threadTokenReadout
    // （压缩记录的 tokensBefore 用的是同一口径，两处不能各算一套）
    const { lastInput, lastCachedInput, baselineInput } = await threadTokenReadout(
      options.store,
      threadId
    )
    const today = await options.store.listSince(rangeStart('today', now()))

    let todayInput = 0
    let todayCachedInput = 0
    for (const row of today) {
      todayInput += row.tokens.input
      todayCachedInput += Math.max(0, row.cachedInput ?? 0)
    }

    return context.json(
      usageThreadContextSchema.parse({
        threadId,
        lastInput,
        lastCachedInput,
        baselineInput,
        todayInput,
        todayCachedInput
      })
    )
  })

  /**
   * 轨迹视图的用量面：该会话**逐轮**的用量行（`listByThread` 已是时间升序）。
   * 为什么不做聚合：轨迹要回答的是"这一轮花了多少、缓存命中多少、哪几轮没记账"，
   * 聚合掉的正是它要看的。行数 = 该会话的 run 数（几十量级），不需要分页。
   * 没记过账的会话回空数组（老会话的 run 早于记账上线，这是**事实**，不是错误）。
   *
   * `contextInput / contextCachedInput / stepCount` 是记账那条线（round 67）加的列：
   * 这里**按可选读**——列还没补上的老库 / 老记录读出来是 undefined，一律归一成 null，
   * 让轨迹照实显示"未记录"，而不是拿整轮合计去顶替"上下文大小"。
   */
  router.get('/thread', async (context) => {
    const raw = context.req.query('threadId')
    const threadId = typeof raw === 'string' ? raw.trim() : ''
    if (threadId === '') return context.json(badRequest('threadId'), 400)

    const rows = await options.store.listByThread(threadId)
    return context.json(
      trajectoryThreadUsageResponseSchema.parse({
        threadId,
        runs: rows.map((row) => {
          const extras = row as Partial<UsageRunExtras>
          return {
            id: row.id,
            runId: row.runId,
            model: row.model,
            provider: row.provider,
            input: row.tokens.input,
            output: row.tokens.output,
            total: row.tokens.total,
            cachedInput: row.cachedInput,
            contextInput: countOrNull(extras.contextInput),
            contextCachedInput: countOrNull(extras.contextCachedInput),
            stepCount: countOrNull(extras.stepCount),
            cost: row.cost,
            createdAt: row.createdAt
          }
        })
      })
    )
  })

  return router
}

/**
 * round 67 记账线在 `UsageRun` 上补的三个字段。轨迹这里**只读且按可选读**：
 * 它们还在演进（另一条改动正在给 usage_runs 补列），轨迹不该被那条线的形状变动拽着走。
 */
interface UsageRunExtras {
  contextInput: number | null
  contextCachedInput: number | null
  stepCount: number | null
}

/** 计数类字段归一：不是非负有限数就是 null（不把 undefined 当 0） */
function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
