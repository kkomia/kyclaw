/**
 * 上下文压缩（round 19）：把会话里更早的历史交给**当前配置的模型**做结构化摘要，
 * 原始消息从存储删除、摘要存 thread 级记录；后续每轮请求由输入处理器把摘要注入成
 * **系统前缀**（紧跟基础指令之后的第二条 system 消息）——UI 消息流不被污染。
 *
 * 三块：
 *   1. `createCompactionStore`（真实现落 libsql 的 thread_compactions 表，与 Mastra 表同库）；
 *   2. `createCompactionService`：读消息 → 摘要（模型）→ 落记录 → 删旧消息；摘要调用的
 *      token 照 round 18 的口径记进 usage_runs（threadId 照记，用量页/上下文环都看得见）；
 *   3. `createCompactionProcessor`：agent 输入处理器，把摘要加成系统消息。
 *
 * 口径与边界（写报告时要照抄的部分）：
 *   - 保留窗口（round 58 起自适应）：先按调用方 keep 夹到 2–40（缺省 10 条**存储消息**，
 *     ≈5 轮对话；一张工具调用+结果算两条）；消息总数 > 该值就按它保留，否则退到
 *     max(KEEP_MIN, 条数 - 2)——所以"条数少、体量大"的会话（几轮输入几十万 token）
 *     单独一按也能压：4 条 → 保留 2、压 2；3 条 → 保留 2、压 1；只剩 ≤2 条才是
 *     "没有可压缩的旧消息"（compacted=false）；12 条以上与旧口径完全一致（长会话策略不变）；
 *   - 重压携带旧摘要：被删消息的原文已不在库，所以压缩时先把现有摘要作为一段
 *     「【此前摘要】」素材拼在摘要素材最前面，让新摘要把它折叠进去（否则二次压缩会丢
 *     第一次摘要里的信息）；summarized / kept 只数本轮真实消息，不把旧摘要算进去；
 *   - "旧消息被裁" = `memory.deleteMessages` 物理删除（摘要已接管它们的信息）——
 *     压缩后 UI 回灌只出保留段 + 顶部「上下文已压缩」标记；
 *   - 先落记录、后删消息（中途失败宁可"摘要+旧消息都在"，也不丢历史）；摘要为空按失败抛；
 *   - 摘要调用失败抛人话错误（ProviderConfigError 原文透出；其余给一行通用文案），
 *     由调用方决定降级（自动触发 = 照常发送 + 一行警示，手动入口 = 给 notice）；
 *   - 注入时机 = `processInput`（每轮 run 开始、历史已载入、系统提示已装配之后；
 *     审批续跑 resume 不走输入处理器，用快照，不受影响）；
 *   - 摘要 run 的 finishReason 是 error/aborted 时 AI SDK 抛错，这里不记 usage；
 *     正常返回才记账（与 chat 一轮的记账口径一致）。
 */
import { randomUUID } from 'node:crypto'
import type { LibSQLStore, SqliteClient } from '@mastra/libsql'
import type { MastraMemory } from '@mastra/core/memory'
import type { InputProcessor } from '@mastra/core/processors'
import type { ThreadCompaction } from '../shared/threads'
import type { KyclawModel } from './model'
import type { ModelResolver } from './agents/kyclaw'
import { ProviderConfigError } from './model'
import { computeCost, pricingFor, type UsageStore } from './usage'

/** thread_compactions 表名（自建表，与 Mastra 的表同库） */
export const COMPACTION_TABLE = 'thread_compactions'

/** 输入处理器的 id（Mastra 处理器链里唯一标识；日志/测试用） */
export const COMPACTION_PROCESSOR_ID = 'kyclaw-compaction'

/** 注入前缀的固定开头（测试与 UI 标记的口径从这里来） */
export const COMPACTION_PREFIX_TAG = '【上下文已压缩】'

/** 摘要素材里"此前摘要"小节的开头（round 58：重压携带旧摘要） */
export const COMPACT_PREVIOUS_SUMMARY_TAG = '【此前摘要】'

/**
 * 缺省的保留窗口（≈5 轮对话）：消息总数超过它时保留最近这么多条。
 * round 58 起窗口自适应：条数不足这个数时收窄到 max(KEEP_MIN, 条数 - 2)，见 compact()
 */
export const DEFAULT_KEEP_MESSAGES = 10

/** keep 的可调范围（路由 schema 与这里同一口径） */
export const KEEP_MIN = 2
export const KEEP_MAX = 40

/** 摘要调用的输出上限（结构化摘要给足余量，同时防跑飞） */
export const COMPACT_MAX_OUTPUT_TOKENS = 2048

/** 摘要调用超时（慢模型也不无限挂） */
export const COMPACTION_TIMEOUT_MS = 60_000

/** 每条消息进摘要素材的文本上限（超长截断，控制素材体积） */
export const TRANSCRIPT_MESSAGE_MAX_CHARS = 2_000

/** 工具结果进摘要素材的上限（比正文更狠地截） */
export const TRANSCRIPT_TOOL_RESULT_MAX_CHARS = 400

/** 摘要素材总长上限（超出从**最旧**一端截掉：近期历史对后续对话更有用） */
export const TRANSCRIPT_MAX_CHARS = 48_000

/** 给模型的摘要素材指令：结构化四段（与 UI 标记展开里的摘要同构） */
export const COMPACT_INSTRUCTIONS = `你是会话压缩器。下面是 AI 助手与用户对话中「较早的部分」（这段原文将在压缩后删除，只有你的摘要会被保留）。
素材开头若有一段以「【此前摘要】」开头的内容，那是上一次压缩留下的摘要：请把它与后面的新素材合并成一份完整摘要，不要丢掉其中的要点。
请把其中有长期价值的信息整理成结构化摘要，只输出摘要正文，包含四个小节：
## 要点
## 决定
## 未完成事项
## 关键文件与结论

要求：用简洁的条目；保留具体的文件名/路径/命令/结论；不要编造原文没有的内容；不要输出与这四个小节无关的寒暄。`

/** libsql 客户端形状检查同 usage.ts（同一个字段、同一条升级复查纪律） */
export function compactionSqlClient(storage: LibSQLStore): SqliteClient {
  const client = (storage as unknown as { client?: SqliteClient }).client
  if (client === undefined || typeof client.execute !== 'function') {
    throw new Error(
      '拿不到 libsql 客户端（LibSQLStore.client 形状变了）：升级 @mastra/libsql 后要复查 compaction.ts'
    )
  }
  return client
}

/** 摘要记录之外我们要的最小记录面（真实现落 libsql） */
export interface CompactionStore {
  ensureTable(): Promise<void>
  /** upsert：同一会话只留最新一条（旧摘要已被折进新摘要，见 compact() 的"携带"口径） */
  save(record: ThreadCompaction): Promise<void>
  get(threadId: string): Promise<ThreadCompaction | null>
  /** 删线程时顺手清掉它的压缩记录（幂等） */
  clear(threadId: string): Promise<void>
}

export function createCompactionStore(client: SqliteClient): CompactionStore {
  let ready: Promise<void> | null = null

  const ensureTable = (): Promise<void> => {
    ready ??= (async () => {
      await client.execute(
        `CREATE TABLE IF NOT EXISTS "${COMPACTION_TABLE}" (
          "thread_id" TEXT PRIMARY KEY,
          "summary" TEXT NOT NULL,
          "summarized" INTEGER NOT NULL,
          "kept" INTEGER NOT NULL,
          "created_at" TEXT NOT NULL
        )`
      )
    })().catch((error: unknown) => {
      ready = null // 失败不缓存：下一次调用再试一遍（同 usage.ts）
      throw error
    })
    return ready
  }

  return {
    ensureTable,
    async save(record) {
      await ensureTable()
      await client.execute({
        sql: `INSERT OR REPLACE INTO "${COMPACTION_TABLE}"
          ("thread_id", "summary", "summarized", "kept", "created_at")
          VALUES (?, ?, ?, ?, ?)`,
        args: [record.threadId, record.summary, record.summarized, record.kept, record.createdAt]
      })
    },
    async get(threadId) {
      await ensureTable()
      const result = await client.execute({
        sql: `SELECT "thread_id", "summary", "summarized", "kept", "created_at"
          FROM "${COMPACTION_TABLE}" WHERE "thread_id" = ?`,
        args: [threadId]
      })
      const row = result.rows[0]
      if (row === undefined) return null
      return {
        threadId: String(row.thread_id),
        summary: String(row.summary),
        summarized: Number(row.summarized),
        kept: Number(row.kept),
        createdAt: String(row.created_at)
      }
    },
    async clear(threadId) {
      await ensureTable()
      await client.execute({
        sql: `DELETE FROM "${COMPACTION_TABLE}" WHERE "thread_id" = ?`,
        args: [threadId]
      })
    }
  }
}

/** 摘要注入的完整前缀文本（模型每轮看到的系统消息） */
export function compactionPrefix(summary: string): string {
  return `${COMPACTION_PREFIX_TAG}更早的对话（含工具调用）已被压缩为以下摘要，对应的原始消息已不再提供：\n${summary}`
}

/**
 * 输入处理器：把该会话的压缩摘要加成一条系统消息。
 *
 * 时序依据（读 @mastra/core 1.75.0 实现）：`requestContext.set('MastraMemory', ...)` 在
 * `runInputProcessors` 之前；配置的处理器排在 memory 自带处理器（历史载入）之后。
 * 返回 `args.messageList`（已 addSystem）——不改普通消息，摘要不会落存储/不进 UI 流。
 */
export function createCompactionProcessor(store: Pick<CompactionStore, 'get'>): InputProcessor {
  return {
    id: COMPACTION_PROCESSOR_ID,
    processInput: async (args) => {
      const threadId = threadIdOfRequestContext(args.requestContext)
      if (threadId === null) return args.messageList
      const record = await store.get(threadId)
      if (record === null) return args.messageList
      args.messageList.addSystem(compactionPrefix(record.summary))
      return args.messageList
    }
  }
}

/** 从请求上下文取当前线程 id（MastraMemory 由 agent 每轮写入；取不到 = 不注入） */
export function threadIdOfRequestContext(requestContext: unknown): string | null {
  if (typeof requestContext !== 'object' || requestContext === null) return null
  const get = (requestContext as { get?: unknown }).get
  if (typeof get !== 'function') return null
  const memory = (get as (key: string) => unknown).call(requestContext, 'MastraMemory') as
    { thread?: { id?: unknown } } | undefined
  const id = memory?.thread?.id
  if (typeof id === 'string' && id.trim() !== '') return id.trim()
  const direct = (get as (key: string) => unknown).call(requestContext, 'mastra__threadId')
  return typeof direct === 'string' && direct.trim() !== '' ? direct.trim() : null
}

/** 摘要调用（测试注入假件；默认走 ai 的 generateText——与 title.ts 同一条装配路径） */
export interface CompactGenerateResult {
  text: string
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
  }
}

export type CompactGenerate = (
  model: KyclawModel,
  options: {
    system: string
    prompt: string
    maxOutputTokens: number
    abortSignal: AbortSignal
    maxRetries: number
  }
) => Promise<CompactGenerateResult>

async function defaultGenerate(
  model: KyclawModel,
  options: Parameters<CompactGenerate>[1]
): Promise<CompactGenerateResult> {
  const { generateText } = await import('ai')
  const result = await generateText({ model, ...options })
  return {
    text: result.text,
    usage: {
      inputTokens: result.usage.inputTokens ?? undefined,
      outputTokens: result.usage.outputTokens ?? undefined,
      totalTokens: result.usage.totalTokens ?? undefined,
      // v7 的 detail 字段叫 cacheReadTokens（= provider 上报的命中缓存输入）
      cachedInputTokens: result.usage.inputTokenDetails?.cacheReadTokens ?? undefined
    }
  }
}

/** 压缩结果：compacted=false 表示没到可压的规模（只剩 ≤2 条消息；compaction 为现有记录或 null） */
export interface CompactOutcome {
  compacted: boolean
  compaction: ThreadCompaction | null
}

export interface CompactionService {
  /** 压缩一条会话（keep 缺省 = DEFAULT_KEEP_MESSAGES；保留窗口自适应，见头注） */
  compact(threadId: string, keep?: number): Promise<CompactOutcome>
  /** 现有压缩记录（顶部标记/GET 用） */
  current(threadId: string): Promise<ThreadCompaction | null>
  /** 会话没了：清掉它的压缩记录（尽力而为，见 service.ts 的删除钩子） */
  clear(threadId: string): Promise<void>
}

/** 收窄依赖：单测给假件（真件 = Mastra Memory） */
export type CompactionMemory = Pick<MastraMemory, 'recall' | 'deleteMessages'>

/** 存储消息里的 part（v2 形状：text / tool-invocation…；逐项防御，坏数据跳过） */
function partLine(part: unknown): string | null {
  if (typeof part !== 'object' || part === null) return null
  const { type } = part as { type?: unknown }
  if (type === 'text') {
    const text = (part as { text?: unknown }).text
    if (typeof text !== 'string' || text.trim() === '') return null
    return text.trim()
  }
  if (type === 'reasoning') {
    // 思考过程不进摘要素材（对后续对话没有长期价值）
    return null
  }
  if (type === 'tool-invocation') {
    const invocation = (part as { toolInvocation?: unknown }).toolInvocation
    if (typeof invocation !== 'object' || invocation === null) return null
    const toolName = (invocation as { toolName?: unknown }).toolName
    if (typeof toolName !== 'string' || toolName === '') return null
    const argsText = JSON.stringify((invocation as { args?: unknown }).args ?? null) ?? ''
    const rawResult = (invocation as { result?: unknown }).result
    const resultText =
      typeof rawResult === 'string'
        ? rawResult
        : rawResult === undefined
          ? '（没有结果记录）'
          : (JSON.stringify(rawResult) ?? '')
    return (
      `【工具调用 ${toolName}】参数：${argsText.slice(0, TRANSCRIPT_MESSAGE_MAX_CHARS)}` +
      `；结果：${resultText.slice(0, TRANSCRIPT_TOOL_RESULT_MAX_CHARS)}`
    )
  }
  return null
}

/** 一条存储消息 → 摘要素材的一行（角色 + 文本/工具轨迹） */
export function transcriptLine(message: { role?: unknown; content?: unknown }): string | null {
  const role = typeof message.role === 'string' ? message.role : 'unknown'
  const content = message.content
  const parts =
    typeof content === 'object' && content !== null
      ? (content as { parts?: unknown }).parts
      : undefined
  const lines = Array.isArray(parts)
    ? parts.flatMap((part) => {
        const line = partLine(part)
        return line === null ? [] : [line]
      })
    : []
  // 兜底：没有 parts 但有 content.content 字符串（简单文本消息）
  if (lines.length === 0 && typeof content === 'object' && content !== null) {
    const text = (content as { content?: unknown }).content
    if (typeof text === 'string' && text.trim() !== '') lines.push(text.trim())
  }
  if (lines.length === 0) return null
  return `${role}：${lines.join('\n').slice(0, TRANSCRIPT_MESSAGE_MAX_CHARS)}`
}

/**
 * 构造摘要素材：逐条渲染 + 总长封顶。
 * 超长时从**最旧**一端丢（近期历史对后续对话更有用）——如实写进报告。
 */
export function buildTranscript(
  messages: ReadonlyArray<{ role?: unknown; content?: unknown }>
): string {
  const lines = messages.flatMap((message) => {
    const line = transcriptLine(message)
    return line === null ? [] : [line]
  })
  const joined = lines.join('\n\n')
  if (joined.length <= TRANSCRIPT_MAX_CHARS) return joined
  let kept: string[] = []
  let size = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? ''
    if (size + line.length > TRANSCRIPT_MAX_CHARS && kept.length > 0) break
    kept = [line, ...kept]
    size += line.length
  }
  return kept.join('\n\n')
}

/** 摘要失败能给用户看的那一行文案（ProviderConfigError 原文就是人话；其余不暴露后端细节） */
export function compactionErrorText(error: unknown): string {
  if (error instanceof ProviderConfigError) return error.message
  return '压缩没能完成：模型这次没跑通，请稍后重试。'
}

export interface CreateCompactionServiceOptions {
  memory: CompactionMemory
  store: CompactionStore
  /** 默认 provider 的解析器（每轮现读设置与密钥——与对话/标题同一条） */
  resolveModel: ModelResolver
  /** 摘要调用的 token 记账（并入 round 18 口径；缺省 = 不记） */
  usage?: UsageStore
  /** 测试注入；缺省走 ai 的 generateText */
  generate?: CompactGenerate
  now?: () => Date
  /** 测试注入（缩短超时）；缺省 60s */
  timeoutMs?: number
}

export function createCompactionService(
  options: CreateCompactionServiceOptions
): CompactionService {
  const now = options.now ?? ((): Date => new Date())
  const generate = options.generate ?? defaultGenerate

  return {
    current: (threadId) => options.store.get(threadId),
    clear: (threadId) => options.store.clear(threadId),
    async compact(threadId, keep) {
      // requested：调用方想要保留的条数（夹到 2–40，缺省 10）
      const requested = Math.min(
        KEEP_MAX,
        Math.max(KEEP_MIN, Math.trunc(keep ?? DEFAULT_KEEP_MESSAGES))
      )
      // 已有摘要（重压要带上，见下）+ 一次读出来：无操作分支也要回它
      const previous = await options.store.get(threadId)
      const { messages } = await options.memory.recall({ threadId, perPage: false })
      // round 58 自适应：条数够就按 requested 保留；条数比 requested 还少（"条数少、体量大"
      // 的会话：几轮输入几十万 token）就收窄到 max(2, 条数 - 2)，也就是至少压掉 2 条、
      // 留最后 2 条兜底——只剩 ≤2 条时才真的没得压。
      const effective =
        messages.length > requested ? requested : Math.max(KEEP_MIN, messages.length - 2)
      if (messages.length <= effective) {
        return { compacted: false, compaction: previous }
      }

      const older = messages.slice(0, messages.length - effective)
      // 摘要只数本轮真实消息（summarized/kept 同口径）；空素材判定也只看新素材
      const material = buildTranscript(older)
      if (material === '') {
        throw new Error('压缩失败：这段历史没有可摘要的文本内容')
      }
      // 重压携带旧摘要：被删消息的原文早已不在库，不带上它二次压缩就会丢第一次摘要的信息
      const prompt =
        previous === null
          ? material
          : `${COMPACT_PREVIOUS_SUMMARY_TAG}\n${previous.summary}\n\n${material}`

      const model = await options.resolveModel()
      const result = await generate(model, {
        system: COMPACT_INSTRUCTIONS,
        prompt,
        maxOutputTokens: COMPACT_MAX_OUTPUT_TOKENS,
        abortSignal: AbortSignal.timeout(options.timeoutMs ?? COMPACTION_TIMEOUT_MS),
        maxRetries: 0
      })
      const summary = result.text.trim()
      if (summary === '') {
        throw new Error('压缩失败：模型没有返回摘要内容')
      }

      const record: ThreadCompaction = {
        threadId,
        summary,
        summarized: older.length,
        kept: messages.length - older.length,
        createdAt: now().toISOString()
      }
      // 先落记录、后删消息：中途失败宁可"摘要 + 旧消息都在"，也不丢历史
      await options.store.save(record)
      await options.memory.deleteMessages(older.map((message) => message.id))

      // 记账是旁路：写库失败只记日志，不影响压缩结果（与 usage.ts 的纪律一致）
      if (options.usage !== undefined && result.usage !== undefined) {
        try {
          const input = result.usage.inputTokens ?? 0
          const output = result.usage.outputTokens ?? 0
          if (input + output > 0) {
            const modelId = typeof model.modelId === 'string' ? model.modelId : 'unknown'
            const provider = typeof model.provider === 'string' ? model.provider : null
            const pricing = pricingFor(modelId)
            await options.usage.insert({
              id: randomUUID(),
              runId: null,
              threadId,
              model: modelId,
              provider,
              tokens: {
                input,
                output,
                total: result.usage.totalTokens ?? input + output
              },
              cachedInput: result.usage.cachedInputTokens ?? null,
              cost:
                pricing === null
                  ? null
                  : computeCost(pricing, {
                      input,
                      output,
                      cachedInput: result.usage.cachedInputTokens
                    }),
              createdAt: now().toISOString()
            })
          }
        } catch (error) {
          console.warn('[kyclaw] 压缩的用量记账失败（压缩结果不受影响）', error)
        }
      }

      return { compacted: true, compaction: record }
    }
  }
}
