/**
 * PB-024：DSH session 的 main 侧只读/薄写协议层。
 *
 * 这个文件**不碰** kernel-adapter.ts：生产接线时由 adapter owner 提供一个只读
 * `rpcCall(method, payload)`（或等价的 wire），测试用 FakeKernelSessionWire。
 *
 * 纪律：
 * - 只做 RPC 透传 + 结果归一，不做 UI 业务；
 * - list-first 的幂等判定在本层（`createSession`），因为内核 `session/create`
 *   对“已存在且非 blank”的同一个 id 会换一个新 id，不能直接当 upsert；
 * - 所有字段按 rc.2 的 wire 形状读取，认不出的字段宁可缺省，不猜。
 */

export interface KernelSessionWire {
  rpc<T>(method: string, payload: Record<string, unknown>): Promise<T>
}

/** 生产 adapter 的最小结构（Bao 的 `KernelAdapter.rpcCall` 已就绪；不 import 旧文件避免耦合）。 */
export interface KernelRpcAdapter {
  rpcCall<T = unknown>(method: string, payload?: unknown): Promise<T>
}

/** 接线版：`const wire = kernelSessionWireFromAdapter(adapter)`。 */
export function kernelSessionWireFromAdapter(adapter: KernelRpcAdapter): KernelSessionWire {
  return {
    rpc<T>(method: string, payload: Record<string, unknown>): Promise<T> {
      return adapter.rpcCall<T>(method, payload)
    }
  }
}

/** 生产 adapter 的最小接线结构（rpcCall + reattach opening）。 */
export interface KernelSessionAdapter extends KernelRpcAdapter {
  reattach(threadId: string): Promise<{ cursor?: number }>
}

/** 接线版：不碰 kernel-adapter.ts；page 用 reattach opening cursor，compact 走 raw commands/execute。 */
export function createKernelSessionOpsForAdapter(adapter: KernelSessionAdapter): KernelSessionOps {
  return createKernelSessionOps(kernelSessionWireFromAdapter(adapter), {
    openingOf: (threadId) => adapter.reattach(threadId)
  })
}

/** `session/list` / `session/page` 里我们实际用到的事件形状（rc.2 原样） */
export interface KernelSessionEventLike {
  type?: string
  seq?: number
  time?: number
  data?: unknown
  surfaceOp?: unknown
}

export interface KernelSessionSummary {
  sessionId: string
  title: string | null
  updatedAt: number
  running?: boolean
  blank?: boolean
  cwd?: string
  parentSessionId?: string
  origin?: string
  formatStatus?: string
}

export interface KernelSessionOpsDeps {
  /** 生产 = adapter.reattach(threadId)；page 的 throughSeq 必须来自内核 opening cursor。 */
  openingOf?: (threadId: string) => Promise<{ cursor?: number }>
  /** 测试注入的 /compact 执行器；生产缺省直接用 raw commands/execute。 */
  executeCommand?: (line: string, threadId?: string) => Promise<unknown>
  /**
   * 归档集合来源。DSH 的 workspace/follow 是 stream，当前 adapter 没有一元 list；
   * 0.2.0 先留空（由 router 的本地 archive 缓存补当前进程），持久化后续再补。
   */
  archivedSessionIds?: () => Promise<readonly string[]>
  /** 测试可控时钟；缺省 Date.now()（仅用于 create 后 list 尚未回显时的兜底 updatedAt） */
  now?: () => number
}

export interface KernelSessionOps {
  listSessions(): Promise<KernelSessionSummary[]>
  listArchivedSessionIds(): Promise<readonly string[]>
  createSession(input: {
    threadId: string
    cwd: string
    title?: string
  }): Promise<{ session: KernelSessionSummary; created: boolean }>
  renameSession(threadId: string, title: string): Promise<void>
  readEvents(threadId: string): Promise<KernelSessionEventLike[]>
  archiveSession(threadId: string): Promise<void>
  /** 只执行命令并回文本；compaction 记录由 router 从 events 派生 */
  compact(threadId: string): Promise<{ compacted: boolean; text: string }>
}

export class KernelSessionOpsError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'KernelSessionOpsError'
    this.code = code
  }
}

type RecordLike = Record<string, unknown>

function isRecord(value: unknown): value is RecordLike {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function summaryOf(item: unknown): KernelSessionSummary | null {
  if (!isRecord(item)) return null
  const sessionId = stringOf(item.sessionId)
  if (sessionId === undefined) return null
  const projections = isRecord(item.projections) ? item.projections : undefined
  const values =
    projections !== undefined && isRecord(projections.values) ? projections.values : undefined
  const rawTitle = values?.title
  const title = typeof rawTitle === 'string' && rawTitle.trim() !== '' ? rawTitle : null
  const updatedAt = typeof item.updatedAt === 'number' ? item.updatedAt : 0
  return {
    sessionId,
    title,
    updatedAt,
    ...(typeof item.running === 'boolean' ? { running: item.running } : {}),
    ...(typeof item.blank === 'boolean' ? { blank: item.blank } : {}),
    ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
    ...(typeof item.parentSessionId === 'string' ? { parentSessionId: item.parentSessionId } : {}),
    ...(typeof item.origin === 'string' ? { origin: item.origin } : {}),
    ...(typeof item.formatStatus === 'string' ? { formatStatus: item.formatStatus } : {})
  }
}

function commandResultOf(value: unknown): { kind: 'success' | 'error'; text: string } | null {
  if (!isRecord(value) || !isRecord(value.result)) return null
  const kind = value.result.kind
  const text = value.result.text
  if (kind !== 'success' && kind !== 'error') return null
  return { kind, text: typeof text === 'string' ? text : '' }
}

/**
 * 生产实现（待 adapter owner 提供 rpcCall）：
 *   const wire = { rpc: (method, payload) => adapter.rpcCall(method, payload) }
 *   const ops = createKernelSessionOps(wire, { executeCommand: optionalTestDouble })
 */
export function createKernelSessionOps(
  wire: KernelSessionWire,
  deps: KernelSessionOpsDeps = {}
): KernelSessionOps {
  const now = deps.now ?? (() => Date.now())

  const listSessions = async (): Promise<KernelSessionSummary[]> => {
    const result = await wire.rpc<{ items?: unknown[] }>('session/list', { _request: {} })
    return (result.items ?? []).flatMap((item) => {
      const summary = summaryOf(item)
      return summary === null ? [] : [summary]
    })
  }

  const listArchivedSessionIds = async (): Promise<readonly string[]> => {
    // DSH 的 workspace/follow 是 stream，不能走 rpcCall 一元透传；0.2.0 的归档过滤
    // 由 kernel-threads 的本地 archive 缓存承担，启动前的历史归档待后续补 follow/persist。
    return deps.archivedSessionIds === undefined ? [] : deps.archivedSessionIds()
  }

  const createSession: KernelSessionOps['createSession'] = async (input) => {
    const existing = (await listSessions()).find((session) => session.sessionId === input.threadId)
    if (existing !== undefined) return { session: existing, created: false }

    const result = await wire.rpc<{ sessionId?: unknown }>('session/create', {
      request: { sessionId: input.threadId, cwd: input.cwd }
    })
    const actual = stringOf(result.sessionId)
    if (actual === undefined) {
      throw new KernelSessionOpsError(
        'session/create-failed',
        '内核 session/create 没有返回 sessionId'
      )
    }
    // 内核在“同 id 已存在且非 blank”时会 mint 一个新 id；这里绝不静默改 threadId。
    if (actual !== input.threadId) {
      throw new KernelSessionOpsError(
        'session/conflict',
        `session/create 返回了不同的 id（${actual}），拒绝把它当作 ${input.threadId} 的物化结果`
      )
    }
    if (input.title !== undefined) await renameSession(input.threadId, input.title)
    const after = (await listSessions()).find((session) => session.sessionId === input.threadId)
    return {
      session: after ?? {
        sessionId: input.threadId,
        title: input.title ?? null,
        updatedAt: now(),
        blank: true
      },
      created: true
    }
  }

  const renameSession: KernelSessionOps['renameSession'] = async (threadId, title) => {
    await wire.rpc('session/rename', { request: { sessionId: threadId, title } })
  }

  const readEvents = async (threadId: string): Promise<KernelSessionEventLike[]> => {
    const exists = (await listSessions()).some((session) => session.sessionId === threadId)
    if (!exists) return []
    if (deps.openingOf === undefined) {
      throw new KernelSessionOpsError('session/ops-unavailable', 'readEvents 需要 openingOf')
    }
    const opening = await deps.openingOf(threadId)
    const cursor = opening.cursor
    // R1：-1 不是哨兵，page 会“cut 到 -1”返回空页；必须用 follow opening 的真实 cursor。
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) return []

    const pages: KernelSessionEventLike[][] = []
    let beforeSeq: number | undefined
    for (let guard = 0; guard < 200; guard += 1) {
      const page = await wire.rpc<{
        records?: Array<{ type?: unknown; event?: unknown }>
        hasMore?: unknown
      }>('session/page', {
        request: {
          address: { kind: 'session', sessionId: threadId },
          throughSeq: cursor,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          maxMessages: 200
        }
      })
      const records = Array.isArray(page.records) ? page.records : []
      const events = records.flatMap((record) => {
        if (!isRecord(record) || !isRecord(record.event)) return []
        return [record.event as KernelSessionEventLike]
      })
      pages.unshift(events)
      if (page.hasMore !== true || events.length === 0) break
      const firstSeq = events[0]?.seq
      if (typeof firstSeq !== 'number' || firstSeq <= 0) break
      beforeSeq = firstSeq
    }
    return pages.flat()
  }

  const archiveSession = async (threadId: string): Promise<void> => {
    await wire.rpc('workspace/archiveSession', {
      request: { sessionId: threadId, stopActivity: true }
    })
  }

  const compact = async (threadId: string): Promise<{ compacted: boolean; text: string }> => {
    // 生产必须走 raw commands/execute：adapter.executeCommand 会先 sessionIdFor(threadId)，
    // 用 adapter 固定 appDataDir 物化 session；对 workspace cwd 的 thread 会 session/conflict。
    // 真机实测 raw RPC 对非活跃但有 id 的 session 可直接执行 /compact。
    const raw =
      deps.executeCommand === undefined
        ? await wire.rpc('commands/execute', {
            agentId: threadId,
            line: '/compact',
            submittedAttachments: []
          })
        : await deps.executeCommand('/compact', threadId)
    const parsed = commandResultOf(raw)
    if (parsed === null) {
      throw new KernelSessionOpsError('session/compact-failed', '内核 /compact 返回形状不可识别')
    }
    if (parsed.kind === 'error')
      throw new KernelSessionOpsError('session/compact-failed', parsed.text)
    const noHistory = parsed.text.toLowerCase().includes('no compactable history yet')
    return { compacted: !noHistory, text: parsed.text }
  }

  return {
    listSessions,
    listArchivedSessionIds,
    createSession,
    renameSession,
    readEvents,
    archiveSession,
    compact
  }
}
