/**
 * 轨迹数据面（round 87 / 用户反馈 015 + 017）——挂在 agent 服务（service.ts）上的 Hono 子路由：
 *
 *   GET /api/trajectory/requests?threadId=       该会话的**逐次模型请求**摘要（时间升序）
 *   GET /api/trajectory/requests/detail?id=      一次请求的完整形态（系统指令 / 工具表 / 消息清单）
 *
 * ## 为什么与用量分开（用户反馈 017）
 *
 * 轨迹以前把"读用量"和"读轨迹原料"混在一条腿上：用量那条路一坏（裸 500），用户看到的
 * 是"轨迹不可用"。这里把它拆成**独立的路由、独立的表、独立的读口**：
 *   - 请求快照（轨迹要的原料）在 `request_snapshots` / `request_blobs`；
 *   - 用量在 `usage_runs`；
 *   - 两条路各有各的异常处理（`fail()` → 200 之外一律回 `{ error: 人话 }`），互不牵连。
 * 轨迹页的四条腿在渲染端也是各取各的（见 use-trajectory-data.ts）：任一条软腿失败只降级。
 *
 * 纪律同其它路由：入参校验（threadId / id 空即 400）、回包过 shared/trajectory 的 schema、
 * 读失败回人话而不是裸 500。**不碰任何外部服务**：这里只读本机的 libsql。
 */
import { Hono, type Context } from 'hono'
import {
  trajectoryRequestDetailResponseSchema,
  trajectoryThreadRequestsResponseSchema
} from '../../shared/trajectory'
import type { RequestSnapshot, RequestSnapshotStore, RequestSnapshotSummary } from '../request-log'

export interface TrajectoryRouterOptions {
  /** 请求快照的读侧（与用量同库不同表；见 src/mastra/request-log.ts） */
  snapshots: RequestSnapshotStore
}

function badRequest(detail: string): { error: string } {
  return { error: `invalid-input: ${detail}` }
}

/**
 * store 行 → 回包行：**只给契约里的字段**（store 里还带着 threadId 这类内部字段，
 * 回包已经有了线程级的那个；schema 是 strictObject，多一个键就会被打回）。
 */
type RequestWire = Omit<RequestSnapshotSummary, 'threadId'>

function summaryWire(row: RequestSnapshotSummary): RequestWire {
  return {
    id: row.id,
    runId: row.runId,
    step: row.step,
    status: row.status,
    error: row.error,
    model: row.model,
    provider: row.provider,
    messageCount: row.messageCount,
    toolCount: row.toolCount,
    systemChars: row.systemChars,
    toolsChars: row.toolsChars,
    truncated: row.truncated,
    createdAt: row.createdAt
  }
}

/** 一次请求的完整形态（正文按需取的那一份）；长度按正文现算，与摘要同一口径 */
function detailWire(
  row: RequestSnapshot
): RequestWire & Pick<RequestSnapshot, 'system' | 'tools' | 'messages'> {
  return {
    id: row.id,
    runId: row.runId,
    step: row.step,
    status: row.status,
    error: row.error,
    model: row.model,
    provider: row.provider,
    messageCount: row.messageCount,
    toolCount: row.toolCount,
    systemChars: row.system === null ? null : row.system.length,
    toolsChars: row.tools === null ? null : row.tools.length,
    truncated: row.truncated,
    createdAt: row.createdAt,
    system: row.system,
    tools: row.tools,
    messages: row.messages
  }
}

/** 抛出 → 人话（不带栈、不带内部类型名；500 是"服务这边出错了"，不是入参问题） */
function failureMessage(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return detail.trim() === '' ? '读取失败' : `读取失败：${detail}`
}

export function createTrajectoryRouter(options: TrajectoryRouterOptions): Hono {
  const router = new Hono()

  /** 一次请求的读表动作包一层：抛出 → 500 + 人话（不是裸 500），并在这里落一条日志 */
  const read = async (context: Context, load: () => Promise<Response>): Promise<Response> => {
    try {
      return await load()
    } catch (error) {
      console.error('[kyclaw] 轨迹接口读表失败（已回人话）', error)
      return context.json({ error: failureMessage(error) }, 500)
    }
  }

  /**
   * 该会话的逐次请求摘要（时间升序）。
   * 没记过 = 空数组（老会话的 run 早于这条线，是**事实**不是错误）；行数 = 请求数，不分页。
   */
  router.get('/requests', async (context) => {
    const raw = context.req.query('threadId')
    const threadId = typeof raw === 'string' ? raw.trim() : ''
    if (threadId === '') return context.json(badRequest('threadId'), 400)

    return read(context, async () => {
      const requests = await options.snapshots.listByThread(threadId)
      return context.json(
        trajectoryThreadRequestsResponseSchema.parse({
          threadId,
          requests: requests.map(summaryWire)
        })
      )
    })
  })

  /** 一次请求的完整形态（正文按需取；没有这一行 = 404 + 人话） */
  router.get('/requests/detail', async (context) => {
    const raw = context.req.query('id')
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id === '') return context.json(badRequest('id'), 400)

    return read(context, async () => {
      const request = await options.snapshots.detail(id)
      if (request === null) return context.json({ error: '没有这条请求记录' }, 404)
      return context.json(
        trajectoryRequestDetailResponseSchema.parse({ request: detailWire(request) })
      )
    })
  })

  return router
}
