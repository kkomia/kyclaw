/**
 * PB-018（0.2.0 B3.3 renderer 半端）：main 侧「内核命令平面」UI 网关。
 *
 * 为什么需要这一层：adapter 在内核进程这一侧（`src/main/kernel/kernel-adapter.ts`），renderer
 * 拿不到内核 token/cookie，也不 import 内核类型（ADR-1）。renderer 继续只吃本地 HTTP/SSE：
 *   - `GET  /api/kernel/status`      → 内核是否启用（renderer 据此决定菜单/命令走哪条路）
 *   - `GET  /api/kernel/catalog`     → `commands/list` 的命令目录（菜单唯一来源）
 *   - `GET  /api/kernel/projection`  → goal 六行 + plan 的**只读**投影
 *   - `POST /api/kernel/command`     → 执行一条命令，回 `command/run` → `command/done` 的 SSE
 *
 * 纪律：
 *   - 命令**不产生模型消息**：这条路由不调 `startTurn`，renderer 也不把命令写进消息流；
 *   - 帧复用 adapter 的 onFrame 语义（`data: <json>\n\n`、一次一个事件），不另造协议；
 *   - `threadId` 缺失/为空一律 400（PB-018 批复：不许静默落到 adapter 的 defaultSessionId）；
 *   - flag 关时**不静默**：内核命令在 flag 关不可用（PB-020 A2a 起旧 goal store 降级已删），
 *     统一回 503 / 命令错误；renderer 不再走旧解析器。
 *
 * 归属：main 侧 UI 网关由 PB-018 交付；adapter 的命令/投影方法已接受可选 `threadId`
 * （Bao 的 B3.4/PB-004 前置，见 `kernel-adapter.ts:89-97`），这里一律按会话调用，不落默认会话。
 */
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type {
  KernelCommandFrame,
  KernelCommandResult,
  KernelGoalProjection,
  KernelPlanProjection,
  KernelProjectionSnapshot
} from '../../shared/kernel-ui'
import { projectGoalDock } from './goal-projection'
import type { KernelAdapter } from './kernel-adapter'

export const KERNEL_UI_ROUTE_PREFIX = '/api/kernel'

export interface KernelUiRouterOptions {
  /** 内核 adapter；flag 关/内核未起时为 null（命令面回 503，不再降级旧 store） */
  adapter: KernelAdapter | null
  /** PB-020 A2a：旧 store 降级已删；字段仅为旧测试编译保留（A2b 删） */
  legacyGoal?: unknown
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-store',
  connection: 'keep-alive'
} as const

function jsonError(error: string, message: string, status: 400 | 500 | 502 | 503): Response {
  return Response.json({ error, message }, { status })
}

function readThreadId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** adapter 的 `commands/execute` 回包形状兼容：`{commandId,result}` / `{kind,text}` / 原始文本 */
export function normalizeCommandResult(raw: unknown, line: string): KernelCommandResult {
  if (raw === undefined || raw === null) {
    return { kind: 'error', text: `未识别的命令：${line}` }
  }
  if (typeof raw === 'string') {
    return raw.trim() === ''
      ? { kind: 'error', text: `未识别的命令：${line}` }
      : { kind: 'success', text: raw }
  }
  if (typeof raw !== 'object') {
    return { kind: 'error', text: `命令返回了无法识别的结果（${String(raw)}）` }
  }
  const envelope = raw as { result?: unknown }
  const payload =
    envelope.result !== null && typeof envelope.result === 'object'
      ? (envelope.result as Record<string, unknown>)
      : (raw as Record<string, unknown>)
  const text =
    typeof payload.text === 'string'
      ? payload.text
      : typeof payload.message === 'string'
        ? payload.message
        : undefined
  if (payload.kind === 'success') {
    return text === undefined ? { kind: 'success' } : { kind: 'success', text }
  }
  if (payload.kind === 'error') {
    return { kind: 'error', text: text ?? '命令执行失败（内核未给出原因）' }
  }
  if (text !== undefined) return { kind: 'error', text }
  return { kind: 'error', text: `命令返回了无法识别的结果：${JSON.stringify(raw)}` }
}

async function readProjection(
  adapter: KernelAdapter,
  threadId: string
): Promise<KernelProjectionSnapshot> {
  const [goalState, plan] = await Promise.all([
    adapter.readGoalState(threadId).catch(() => null),
    adapter.readPlanState(threadId).catch(() => null)
  ])
  return {
    goal: goalState === null ? null : projectGoalDock(goalState),
    plan: plan === null ? null : { active: plan.active === true, pending: plan.pending === true }
  }
}

interface CommandOutcome {
  result: KernelCommandResult
  goal: KernelGoalProjection | null
  plan: KernelPlanProjection | null
}

async function runKernelCommand(
  adapter: KernelAdapter,
  threadId: string,
  line: string
): Promise<CommandOutcome> {
  let raw: unknown
  try {
    raw = await adapter.executeCommand(line, threadId)
  } catch (error) {
    return {
      result: {
        kind: 'error',
        text: `命令执行失败：${error instanceof Error ? error.message : String(error)}`
      },
      goal: null,
      plan: null
    }
  }
  const result = normalizeCommandResult(raw, line)
  const snapshot = await readProjection(adapter, threadId)
  return { result, goal: snapshot.goal, plan: snapshot.plan }
}

/**
 * 命令执行 → SSE：`command/run` 在**执行前**发出，`command/done` 带结算结果与最新投影。
 * 客户端断开/写入失败只停止发帧，不影响命令本身（命令没有可取消的模型轮）。
 */
function commandSse(
  produce: (emit: (frame: KernelCommandFrame) => void) => Promise<void>
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const emit = (frame: KernelCommandFrame): void => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
        } catch {
          closed = true
        }
      }
      const close = (): void => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          // 已关闭
        }
      }
      void produce(emit).finally(close)
    }
  })
  return new Response(stream, { status: 200, headers: SSE_HEADERS })
}

export function createKernelUiRouter(options: KernelUiRouterOptions): Hono {
  const router = new Hono()
  const adapter = options.adapter

  router.get('/status', (context) => context.json({ enabled: adapter !== null }))

  /**
   * 命令目录是 agent 级注册表（不随会话状态变化），不带 threadId —— 新会话还没有内核 session 时
   * 菜单也必须能用。`threadId` 只对**有状态的**投影/执行有意义（下面两条强制校验）。
   */
  router.get('/catalog', async (context) => {
    if (adapter === null) return context.json({ enabled: false, commands: [] })
    try {
      const commands = await adapter.listCommands()
      return context.json({ enabled: true, commands })
    } catch (error) {
      return jsonError(
        'KERNEL_CATALOG_FAILED',
        `命令目录读取失败：${error instanceof Error ? error.message : String(error)}`,
        502
      )
    }
  })

  router.get('/projection', async (context) => {
    const threadId = readThreadId(context.req.query('threadId'))
    if (threadId === null) {
      return jsonError(
        'KERNEL_THREAD_REQUIRED',
        '缺少 threadId：内核 goal/plan 投影必须指定会话。',
        400
      )
    }
    try {
      if (adapter === null) {
        return jsonError(
          'KERNEL_DISABLED',
          '内核未启用：0.2.0 起内核必启；请检查内核启动错误或重启应用。',
          503
        )
      }
      return context.json(await readProjection(adapter, threadId))
    } catch (error) {
      return jsonError(
        'KERNEL_PROJECTION_FAILED',
        `goal/plan 投影读取失败：${error instanceof Error ? error.message : String(error)}`,
        500
      )
    }
  })

  router.post('/command', async (context) => {
    const body = (await context.req.json().catch(() => null)) as {
      threadId?: unknown
      line?: unknown
    } | null
    const threadId = readThreadId(body?.threadId)
    if (threadId === null) {
      return jsonError('KERNEL_THREAD_REQUIRED', '缺少 threadId：内核命令必须指定会话。', 400)
    }
    const line = typeof body?.line === 'string' ? body.line.trim() : ''
    if (line === '' || !line.startsWith('/')) {
      return jsonError('KERNEL_COMMAND_INVALID', '命令格式不对：需要以 / 开头的完整命令。', 400)
    }
    const commandId = randomUUID()
    return commandSse(async (emit) => {
      emit({ type: 'command/run', commandId, line })
      const outcome =
        adapter !== null
          ? await runKernelCommand(adapter, threadId, line)
          : {
              result: {
                kind: 'error' as const,
                text: '内核未启用：0.2.0 起内核必启，命令不可用。'
              },
              goal: null,
              plan: null
            }
      emit({ type: 'command/done', commandId, line, ...outcome })
    })
  })

  return router
}
