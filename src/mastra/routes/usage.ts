/**
 * 用量 API（T14；round 18 加会话上下文）——挂在 agent 服务（service.ts）上的 Hono 子路由：
 *
 * 四条（**只管 token，不管轨迹原料**）：
 *   GET /api/usage?range=today|month    窗口内的 token（含按模型拆分）
 *   GET /api/usage/calendar?year=YYYY  该**本地年**按日聚合（首页日历热力图的数据面；task-127）
 *   GET /api/usage/context?threadId=    该会话的"最近一轮 / 首轮基线 / 今日缓存合计"
 *                                       （上下文环与 hover 明细的数据面）
 *   GET /api/usage/thread?threadId=     该会话的**逐轮用量行**（时间升序）——轨迹视图的
 *                                       "这一轮 token 花在哪"的原料（见 shared/trajectory.ts）
 *
 * 请求快照（轨迹的"系统 / 上下文"两行的原料）**不在这里**：round 87 起住在
 * `routes/trajectory.ts`（`/api/trajectory/requests*`）—— 用户反馈 017 要的就是"用量坏了
 * 不该把轨迹一起带走"，所以两条数据面各有各的路由、表与异常处理。
 *
 * 纪律同线程/MCP 路由：入参过 zod（range / threadId 脏值即 400）、回包过 shared/usage 的 schema。
 * 窗口边界按**本地日历**切（rangeStart），与用户在页面上看到的"今天/本月"一致。
 *
 * round 87（用户反馈 017）：**每条腿自己兜住异常**。以前只有入参校验，任何抛出（库坏了 / 读表失败 /
 * 行形状对不上）都变成裸 500 —— 渲染端拿不到人话，整页轨迹跟着一起挂。现在统一走 `fail()`：
 * 200 之外一定回 `{ error: 人话 }`，让上游（trajectory-api.ts）能把这句人话带出来。
 */
import { Hono, type Context } from 'hono'
import {
  usageCalendarSchema,
  usageCalendarYearSchema,
  usageRangeSchema,
  usageResponseSchema,
  usageThreadContextSchema
} from '../../shared/usage'
import { trajectoryThreadUsageResponseSchema } from '../../shared/trajectory'
import {
  rangeStart,
  summarizeCalendar,
  summarizeThreadUsage,
  summarizeUsage,
  type UsageStore
} from '../usage'
import type { RequestSnapshotStore } from '../request-log'

export interface UsageRouterOptions {
  store: UsageStore
  /** 请求快照（可选）：只用来把 baselineInput 按字符占比拆成系统提示词/工具定义；缺省则不拆 */
  snapshots?: RequestSnapshotStore
  /** 测试注入"现在"；生产不传 = 真时间 */
  now?: () => Date
}

function badRequest(detail: string): { error: string } {
  return { error: `invalid-input: ${detail}` }
}

/** 抛出 → 人话（不带栈、不带内部类型名；500 是"服务这边出错了"，不是入参问题） */
function failureMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return detail.trim() === '' ? '读取失败' : `读取失败：${detail}`
}

export function createUsageRouter(options: UsageRouterOptions): Hono {
  const router = new Hono()
  const now = options.now ?? ((): Date => new Date())

  /** 一次请求的读表动作包一层：抛出 → 500 + 人话（不是裸 500），并在这里落一条日志 */
  const read = async (context: Context, load: () => Promise<Response>): Promise<Response> => {
    try {
      return await load()
    } catch (error) {
      console.error('[kyclaw] 用量接口读表失败（已回人话）', error)
      return context.json({ error: failureMessage(error) }, 500)
    }
  }

  router.get('/', async (context) => {
    // 不传 range 走"今天"（页面默认档）；脏值 400，不静默回落
    const range = usageRangeSchema.safeParse(context.req.query('range') ?? 'today')
    if (!range.success) return context.json(badRequest('range'), 400)
    const window = range.data

    return read(context, async () => {
      const rows = await options.store.listSince(rangeStart(window, now()))
      return context.json(usageResponseSchema.parse(summarizeUsage(rows, window)))
    })
  })

  router.get('/calendar', async (context) => {
    // 不传 year 走"当前本地年"；脏值（非整数/越界/空串）400，不静默回落
    const raw = context.req.query('year')
    const year = usageCalendarYearSchema.safeParse(raw ?? String(now().getFullYear()))
    if (!year.success) return context.json(badRequest('year'), 400)

    return read(context, async () => {
      // 现有 listSince 就够：拉「本地年起点之后」的 usage_runs，按本地日聚合在纯函数里做；
      // 不新增表、不造数（summarizeCalendar 只保留该年的行）。
      const rows = await options.store.listSince(new Date(year.data, 0, 1))
      return context.json(usageCalendarSchema.parse(summarizeCalendar(rows, year.data)))
    })
  })

  router.get('/context', async (context) => {
    const raw = context.req.query('threadId')
    const threadId = typeof raw === 'string' ? raw.trim() : ''
    if (threadId === '') return context.json(badRequest('threadId'), 400)

    return read(context, async () => {
      // round 59 / task-107：最近一轮、首轮基线与全会话合计都走 usage.ts 的 summarizeThreadUsage
      // （同一份 rows、同一个口径；压缩记录的 tokensBefore 也走同一处，不能各算一套）
      const summary = summarizeThreadUsage(await options.store.listByThread(threadId))
      const { lastInput, lastCachedInput, baselineInput, totals, usageReported } = summary
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
          usageReported,
          todayInput,
          todayCachedInput,
          totals,
          composition: await compositionOf(options.snapshots, threadId, baselineInput)
        })
      )
    })
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

    return read(context, async () => {
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
              createdAt: row.createdAt
            }
          })
        })
      )
    })
  })

  /**
   * 轨迹视图的"请求"面**不在这里**：round 87 起是 `/api/trajectory/requests*`
   * （用户反馈 017：用量这条路坏了不该把轨迹原料一起带走）。
   */
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

/**
 * baselineInput 的 sys/tools 拆分（~估算）：首份请求快照的 system_chars / tools_chars 字符占比。
 * 请求快照是**可选**数据面：读不到 / 老会话没有 → null（UI 合并一行，不编两个数）；
 * 快照读失败也**不拖垮**用量路由（这条腿只做锦上添花）。
 */
async function compositionOf(
  snapshots: RequestSnapshotStore | undefined,
  threadId: string,
  baselineInput: number | null
): Promise<{ systemPrompt: number; toolDefinitions: number } | null> {
  if (snapshots === undefined || baselineInput === null || baselineInput <= 0) return null
  let rows
  try {
    rows = await snapshots.listByThread(threadId)
  } catch {
    return null
  }
  const first = rows.find((row) => (row.systemChars ?? 0) + (row.toolsChars ?? 0) > 0)
  if (first === undefined) return null
  const systemChars = Math.max(0, first.systemChars ?? 0)
  const toolsChars = Math.max(0, first.toolsChars ?? 0)
  const chars = systemChars + toolsChars
  if (chars <= 0) return null
  const systemPrompt = Math.round((baselineInput * systemChars) / chars)
  return { systemPrompt, toolDefinitions: Math.max(0, baselineInput - systemPrompt) }
}

/** 计数类字段归一：不是非负有限数就是 null（不把 undefined 当 0） */
function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}
