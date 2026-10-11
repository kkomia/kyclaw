/**
 * 用量 API（T14；round 18 加会话上下文）——挂在 agent 服务（service.ts）上的 Hono 子路由：
 *
 * 两条：
 *   GET /api/usage?range=today|month    窗口内的 token 与花费（含按模型拆分）
 *   GET /api/usage/context?threadId=    该会话的"最近一轮 / 首轮基线 / 今日缓存合计"
 *                                       （上下文环与 hover 明细的数据面）
 *
 * 纪律同线程/MCP 路由：入参过 zod（range / threadId 脏值即 400）、回包过 shared/usage 的 schema。
 * 窗口边界按**本地日历**切（rangeStart），与用户在页面上看到的"今天/本月"一致。
 */
import { Hono } from 'hono'
import { usageRangeSchema, usageResponseSchema, usageThreadContextSchema } from '../../shared/usage'
import { rangeStart, summarizeUsage, type UsageStore } from '../usage'

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

    const rows = await options.store.listByThread(threadId)
    const first = rows[0]
    const last = rows[rows.length - 1]
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
        lastInput: last?.tokens.input ?? null,
        lastCachedInput: last?.cachedInput ?? null,
        baselineInput: first?.tokens.input ?? null,
        todayInput,
        todayCachedInput
      })
    )
  })

  return router
}
