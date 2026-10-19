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
  /**
   * PB-047：`session/list` 的 `projections.asOfSeq` —— 该会话"能读到哪"的水位，
   * 可直接当 `session/page` 的 `throughSeq`（重启后没有 live follow opening 时的兜底 cursor）。
   */
  asOfSeq?: number
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
  // PB-047：list 的 `projections.asOfSeq` 是"这条会话能读到哪"的水位，可直接当 page 的 throughSeq。
  const asOfSeq =
    projections !== undefined && typeof projections.asOfSeq === 'number'
      ? projections.asOfSeq
      : undefined
  return {
    sessionId,
    title,
    updatedAt,
    ...(asOfSeq === undefined ? {} : { asOfSeq }),
    ...(typeof item.running === 'boolean' ? { running: item.running } : {}),
    ...(typeof item.blank === 'boolean' ? { blank: item.blank } : {}),
    ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
    ...(typeof item.parentSessionId === 'string' ? { parentSessionId: item.parentSessionId } : {}),
    ...(typeof item.origin === 'string' ? { origin: item.origin } : {}),
    ...(typeof item.formatStatus === 'string' ? { formatStatus: item.formatStatus } : {})
  }
}

/** follow 接不上时视为"该路径不可用"的错误（不吞其它错误） */
function isSessionUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /session\/not-found|not\s*found|unknown session|session\/follow timeout|adapter is stopped/i.test(
    message
  )
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
    /**
     * PB-047（P0）：**读历史不能依赖"活跃会话 / live follow"**。
     * 重启后内存里没有 follow，`openingOf` 可能抛 not-found 或拿不到 cursor；旧实现在这里
     * 静默 `return []`，于是所有会话在重启后都读不回（Nia 真机：磁盘日志在、`session/list` 也有）。
     *
     * cursor 来源（按优先级）：
     *   1. live follow opening 的 cursor（follow 会按 id 接上历史会话）；
     *   2. `session/list` 的 `projections.asOfSeq`（Nia 真机原始 RPC 验证：可直接当 throughSeq）；
     *   3. 两条都没有：**会话存在就报错**（不许静默空）；会话不存在（list 里没有）才回空。
     *
     * 另：`asOfSeq` 是**缓存水位**，可能落后于内核真实末尾；读完一轮后**再取一次 list**，
     * 水位前进了就补读（最多 3 轮，防"永远停在 21"）。
     */
    let listed = (await listSessions()).find((session) => session.sessionId === threadId)
    if (listed === undefined) return [] // 真正的未知 thread：不是"读不出来"，是"没有"

    let cursor: number | undefined
    if (deps.openingOf !== undefined) {
      try {
        const opening = await deps.openingOf(threadId)
        if (typeof opening.cursor === 'number') cursor = opening.cursor
      } catch (error) {
        // follow 接不上（不存在/内核不让接）不算致命：下面用 asOfSeq 兜底；未知错误继续抛。
        if (!isSessionUnavailableError(error)) throw error
      }
    }
    if (cursor === undefined) cursor = listed.asOfSeq
    // R1：-1 不是哨兵，page 会“cut 到 -1”返回空页；必须用真实 cursor。
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) {
      throw new KernelSessionOpsError(
        'session/history-unavailable',
        `会话存在但拿不到可读水位（live opening / projections.asOfSeq 都没有）：${threadId}`
      )
    }

    /** 从 throughSeq 往回翻完全部页（R1 的 beforeSeq 游标链） */
    const readPages = async (throughSeq: number): Promise<KernelSessionEventLike[]> => {
      const collected: KernelSessionEventLike[][] = []
      let beforeSeq: number | undefined
      for (let guard = 0; guard < 200; guard += 1) {
        const page = await wire.rpc<{
          records?: Array<{ type?: unknown; event?: unknown }>
          hasMore?: unknown
        }>('session/page', {
          request: {
            address: { kind: 'session', sessionId: threadId },
            throughSeq,
            ...(beforeSeq === undefined ? {} : { beforeSeq }),
            maxMessages: 200
          }
        })
        const records = Array.isArray(page.records) ? page.records : []
        const events = records.flatMap((record) => {
          if (!isRecord(record) || !isRecord(record.event)) return []
          return [record.event as KernelSessionEventLike]
        })
        collected.unshift(events)
        if (page.hasMore !== true || events.length === 0) break
        const firstSeq = events[0]?.seq
        if (typeof firstSeq !== 'number' || firstSeq <= 0) break
        beforeSeq = firstSeq
      }
      return collected.flat()
    }

    // 按 seq 去重合并（水位补读会与首轮重叠）
    const bySeq = new Map<number, KernelSessionEventLike>()
    const merge = (events: readonly KernelSessionEventLike[]): void => {
      for (const event of events) {
        const seq = typeof event.seq === 'number' ? event.seq : undefined
        if (seq === undefined) continue
        bySeq.set(seq, event)
      }
    }
    let waterline = cursor
    merge(await readPages(waterline))
    // asOfSeq 是缓存水位：补一次 list，水位前进就补读到新水位（防止停在旧值）。
    for (let round = 0; round < 3; round += 1) {
      const refreshed = (await listSessions()).find((session) => session.sessionId === threadId)
      listed = refreshed ?? listed
      const next = listed.asOfSeq
      if (typeof next !== 'number' || next <= waterline) break
      waterline = next
      merge(await readPages(waterline))
    }
    return [...bySeq.entries()].sort((left, right) => left[0] - right[0]).map(([, event]) => event)
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
