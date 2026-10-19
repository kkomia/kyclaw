/**
 * PB-024：用 DSH kernel session 能力实现旧 `/api/threads` 9 端点。
 *
 * 设计边界：
 * - 不 import `src/mastra/**`，不依赖 MastraMemory；
 * - 不直接摸 kernel-adapter；只依赖 `KernelSessionOps`（生产由 adapter.rpcCall 注入）；
 * - 旧 HTTP 形状尽量保持：id/title/updatedAt、StoredMessage、{ok:true} 等；
 * - 明确降级：truncate 501；delete=归档；title 只读；compact 无 keep，记录从事件派生。
 */
import { Hono } from 'hono'
import {
  compactThreadRequestSchema,
  createThreadRequestSchema,
  renameThreadRequestSchema,
  threadCompactionResponseSchema,
  threadIdParamsSchema,
  threadListResponseSchema,
  threadMessagesResponseSchema,
  threadSummarySchema,
  threadTitleResponseSchema,
  truncateThreadRequestSchema,
  type ThreadSummary
} from '../../shared/threads'
import type { KernelSessionOps, KernelSessionSummary } from '../kernel/kernel-session-ops'
import { KernelSessionOpsError } from '../kernel/kernel-session-ops'
import {
  projectThreadCompaction,
  projectThreadMessages,
  projectThreadSummary
} from './thread-projection'

export interface KernelThreadsRouterOptions {
  ops: KernelSessionOps
  /** 当前线程所属工作区；缺省回 defaultCwd。由调用方（service）注入，不读 adapter.appDataDir。 */
  cwdOf?: (threadId: string) => string | undefined
  /** 兜底 cwd；生产 = 当前工作区，测试 = 临时目录。 */
  defaultCwd: string
  /** 可选列表过滤（例如只显示当前 workspace）；默认过滤 subagent + archived。 */
  sessionFilter?: (summary: KernelSessionSummary) => boolean
}

function errorBody(error: string, detail?: string): { error: string; detail?: string } {
  return detail === undefined ? { error } : { error, detail }
}

/** PB-022 统一 code：renderer 用它显示“该功能 0.2.0 暂不可用”。 */
function featureDisabled(
  feature: string,
  detail?: string
): {
  error: 'feature-disabled'
  feature: string
  availableIn: '0.2.x'
  detail?: string
} {
  return {
    error: 'feature-disabled',
    feature,
    availableIn: '0.2.x',
    ...(detail === undefined ? {} : { detail })
  }
}

function opsErrorStatus(error: unknown): 400 | 404 | 409 | 500 | 501 {
  if (!(error instanceof KernelSessionOpsError)) return 500
  switch (error.code) {
    case 'session/not-found':
      return 404
    case 'session/conflict':
      return 409
    case 'session/title-invalid':
      return 400
    case 'feature-disabled':
      return 501
    default:
      return 500
  }
}

function opsErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 当前 list 里找一条 summary；不存在返回 null（与旧路由的 404/空结果口径在调用处区分）。 */
async function findSummary(
  ops: KernelSessionOps,
  threadId: string
): Promise<KernelSessionSummary | null> {
  const sessions = await ops.listSessions()
  return sessions.find((session) => session.sessionId === threadId) ?? null
}

function summaryJson(summary: KernelSessionSummary): ThreadSummary {
  return projectThreadSummary(summary)
}

/**
 * 9 端点。旧 `/api/threads` 的路径保持不变，便于 renderer 的 threads-api.ts 无感。
 */
export function createKernelThreadsRouter(options: KernelThreadsRouterOptions): Hono {
  const app = new Hono()
  const { ops } = options
  // 0.2.0 的最小归档缓存：DSH 的 workspace/follow 是 stream，当前没有一元 list；
  // 至少保证本进程内 archive 后立刻从列表消失。跨重启的历史归档待后续接 follow/persist。
  const archivedInProcess = new Set<string>()

  app.get('/', async (context) => {
    try {
      const [sessions, archived] = await Promise.all([
        ops.listSessions(),
        ops.listArchivedSessionIds()
      ])
      const archivedSet = new Set([...archived, ...archivedInProcess])
      const threads = sessions
        .filter((session) => session.origin !== 'subagent')
        .filter((session) => !archivedSet.has(session.sessionId))
        .filter((session) => options.sessionFilter?.(session) ?? true)
        .map(summaryJson)
      return context.json(threadListResponseSchema.parse({ threads }))
    } catch (error) {
      return context.json(errorBody('threads/list-failed', opsErrorText(error)), 500)
    }
  })

  app.post('/', async (context) => {
    const body = createThreadRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json(errorBody('invalid-input: 线程 id'), 400)
    const cwd = options.cwdOf?.(body.data.threadId) ?? options.defaultCwd
    if (cwd.trim() === '') return context.json(errorBody('invalid-input: cwd'), 400)
    try {
      const result = await ops.createSession({
        threadId: body.data.threadId,
        cwd,
        ...(body.data.title === undefined ? {} : { title: body.data.title })
      })
      return context.json(threadSummarySchema.parse(summaryJson(result.session)))
    } catch (error) {
      return context.json(
        errorBody(
          opsErrorText(error),
          error instanceof KernelSessionOpsError ? error.code : undefined
        ),
        opsErrorStatus(error)
      )
    }
  })

  app.get('/:id/messages', async (context) => {
    const params = threadIdParamsSchema.safeParse(context.req.param())
    if (!params.success) return context.json(errorBody('invalid-input: 线程 id'), 400)
    try {
      const events = await ops.readEvents(params.data.id)
      const messages = projectThreadMessages(events)
      return context.json(threadMessagesResponseSchema.parse({ messages }))
    } catch (error) {
      return context.json(errorBody('threads/messages-failed', opsErrorText(error)), 500)
    }
  })

  app.patch('/:id', async (context) => {
    const params = threadIdParamsSchema.safeParse(context.req.param())
    if (!params.success) return context.json(errorBody('invalid-input: 线程 id'), 400)
    const body = renameThreadRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json(errorBody('invalid-input: 标题不合法'), 400)
    try {
      await ops.renameSession(params.data.id, body.data.title)
      const summary = await findSummary(ops, params.data.id)
      if (summary === null) return context.json(errorBody('not-found'), 404)
      return context.json(threadSummarySchema.parse(summaryJson(summary)))
    } catch (error) {
      return context.json(
        errorBody(
          opsErrorText(error),
          error instanceof KernelSessionOpsError ? error.code : undefined
        ),
        opsErrorStatus(error)
      )
    }
  })

  app.delete('/:id', async (context) => {
    const params = threadIdParamsSchema.safeParse(context.req.param())
    if (!params.success) return context.json(errorBody('invalid-input: 线程 id'), 400)
    try {
      await ops.archiveSession(params.data.id)
      archivedInProcess.add(params.data.id)
      return context.json({ ok: true })
    } catch (error) {
      // 旧 DELETE 是幂等的：不存在也回 ok。
      if (error instanceof KernelSessionOpsError && error.code === 'session/not-found') {
        return context.json({ ok: true })
      }
      return context.json(errorBody('threads/archive-failed', opsErrorText(error)), 500)
    }
  })

  // 0.2.0 明确不支持 truncate：不造 deleted 数，也不假装成功。
  app.post('/:id/truncate', async (context) => {
    const params = threadIdParamsSchema.safeParse(context.req.param())
    if (!params.success) return context.json(errorBody('invalid-input: 线程 id'), 400)
    const body = truncateThreadRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json(errorBody('invalid-input: messageId'), 400)
    return context.json(
      featureDisabled('truncate', '0.2.0 暂不支持截断/编辑重发；0.2.x 再补（不做 fork 假象）'),
      501
    )
  })

  app.post('/:id/title', async (context) => {
    const params = threadIdParamsSchema.safeParse(context.req.param())
    if (!params.success) return context.json(errorBody('invalid-input: 线程 id'), 400)
    try {
      const summary = await findSummary(ops, params.data.id)
      if (summary === null) return context.json(errorBody('not-found'), 404)
      // 内核默认首轮自动生成标题；这里只读 projection，没有远程 refresh/generate。
      return context.json(
        threadTitleResponseSchema.parse({ title: summary.title ?? '', generated: false })
      )
    } catch (error) {
      return context.json(errorBody('threads/title-failed', opsErrorText(error)), 500)
    }
  })

  app.post('/:id/compact', async (context) => {
    const params = threadIdParamsSchema.safeParse(context.req.param())
    if (!params.success) return context.json(errorBody('invalid-input: 线程 id'), 400)
    const body = compactThreadRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json(errorBody('invalid-input: 压缩参数'), 400)
    if (body.data.keep !== undefined) {
      return context.json(
        featureDisabled('compact-keep', '0.2.0 的 /compact 不接受 keep 参数'),
        501
      )
    }
    try {
      const result = await ops.compact(params.data.id)
      const events = await ops.readEvents(params.data.id)
      return context.json({
        compacted: result.compacted,
        compaction: projectThreadCompaction(events, params.data.id)
      })
    } catch (error) {
      return context.json(
        errorBody(
          opsErrorText(error),
          error instanceof KernelSessionOpsError ? error.code : undefined
        ),
        opsErrorStatus(error)
      )
    }
  })

  app.get('/:id/compaction', async (context) => {
    const params = threadIdParamsSchema.safeParse(context.req.param())
    if (!params.success) return context.json(errorBody('invalid-input: 线程 id'), 400)
    try {
      const events = await ops.readEvents(params.data.id)
      const compaction = projectThreadCompaction(events, params.data.id)
      return context.json(threadCompactionResponseSchema.parse({ compaction }))
    } catch (error) {
      return context.json(errorBody('threads/compaction-failed', opsErrorText(error)), 500)
    }
  })

  return app
}

/**
 * flag 关 / 没有 kernel adapter 时的 threads 路由：
 * **不注册旧 createThreadsRouter**，也不假装可用；统一 503 feature-disabled。
 */
export function createKernelThreadsUnavailableRouter(reason = 'kernel-not-running'): Hono {
  const app = new Hono()
  app.use('*', async (context) =>
    context.json(featureDisabled('threads', `线程内核未启动（${reason}）；0.2.0 不回退旧实现`), 503)
  )
  return app
}
