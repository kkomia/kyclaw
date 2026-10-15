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
 *   - 压缩分级（round 75，round 76 补第三档）：**付钱之前先做零成本档**。compact() 进模型之前
 *     先按顺序试三档机械手段，任一级"省够了"就停在那里、**一次模型调用都不发**，并把档位记进
 *     `thread_compaction.level`（见 shared/threads.ts 的 compactionLevels）：
 *       1. `snip`（裁剪）：把**较早的大工具结果**换成占位说明（工具名 + 参数摘要 + 开头 20 行 +
 *          "去哪找"）；用户原话与助手文字一字不动；
 *       2. `dedupe`（去重）：在裁剪之上，把与更早结果**完全重复**（或已被更早结果包含）的工具
 *          结果指向首次出现处——零信息损失；
 *       3. `fold`（折叠，round 76）：在前两档之上，把**较早那几段已经结束的对话**里助手的正文
 *          折成一行"这里折了 N 条消息、讲的是什么"（本地规则生成，**不调模型**）；用户的每条
 *          消息原样保留（原话永不折叠），工具结果归前两档管、这里一个字节都不碰；
 *       4. `summary`：前三档都不够时才走的老路（调模型摘要 + 删旧消息）。
 *     通过线：**从上次停的那一档之后算起、累加**到本档 ≥ MECHANICAL_MIN_FREED_TOKENS（2000）
 *     **估算** token 就停（只算"这档之后新启用的部分"——上次已经停在那里省过的量，不该再拿来
 *     当这次停下的理由）。
 *     为什么是"绝对量"而不是"占旧段比例"：这里防的是"多付一次摘要调用"，不是"省得漂亮"——
 *     宁可多停一档（零成本、不丢信息），也不要为了比例好看去付摘要那一笔；不够就往下走，
 *     下一档不够就照旧付钱。**同一档不重复停**（已经停在 snip 的会话下次从 dedupe 起算，
 *     否则会永远停在 snip、永远不摘要）：见 nextMechanicalLevel。
 *   - 机械档怎么生效（这条最容易看错）：**不动存储、不删消息**。snip/dedupe/fold 的改写发生在
 *     每轮装配 prompt 的输入处理器里（createCompactionProcessor）：处理器看到该会话的记录档位
 *     是某一机械档时，把「最近 PROCESSOR_KEEP_MESSAGES 条以外、且来自存储（source=memory）」
 *     的工具结果换成占位说明、助手长正文换成折叠说明，**只改这一轮发给模型的那一份**——
 *     存储与对话界面里的原文一字不动（用户翻回去照样看得到全文，模型需要时重新执行工具、
 *     或让助手重新读一次文件即可）。所以：
 *       · 记录是"这个会话现在走哪一档"的开关，真正的裁剪每轮按当前消息列现算；
 *       · tokensAfter 对机械档是 `实测 lastInput − 本档释放的估算 token`（比摘要档的
 *         基线折算准，因为减掉的正是刚省下的那部分）；
 *       · 机械档没有模型调用 → 不写 usage_runs（用量页上看不到"压缩"那一行，因为真没花）。
 *   - `fold` 档的边界（round 76，写在这里免得被"折了就恢复不了"的担心带偏）：
 *       · **折什么**：一段 = 旧段里**连续的一条条助手消息**（被用户消息、被任何非助手消息切断）。
 *         只把这一段里的**正文（text part）**折成一行说明；工具调用 part 原样留着（那是前两档
 *         的射程，也是这一段里的事实信息）。
 *       · **谁绝不会被折**：用户的每一条消息（原话是承诺面）、保留窗口（最近 PROCESSOR_KEEP_MESSAGES
 *         条 = 当前任务现场）、以及**还没收尾的工具调用所在的段**（等审批 / 半截 = 现场，折了
 *         会把活干坏）。
 *       · **怎么恢复**：只改这一轮发给模型的那一份——存储与对话界面里一字未动，用户往上翻就
 *         是原文；折叠说明里明写了"重新读哪条 / 怎么让它重新展开"，模型据此能拿回来。
 *       · **不调模型**：折叠说明由本地规则拼（首句 + 段内消息条数 + 用过的工具名），所以它跟
 *         snip/dedupe 一样是零成本档——这一档要是调模型，它就失去存在的意义（等于多付一次摘要）。
 *   - 机械档只算**看得见的那一段**：Mastra Memory 每轮喂给模型的历史有上限
 *     （index.ts 的 MEMORY_LAST_MESSAGES = VISIBLE_HISTORY_MESSAGES = 40 条），比这更老的
 *     消息本来就不进 prompt——裁剪它们省不下 token，所以机械档只统计与改写最近 40 条以内的
 *     旧段（摘要档照旧用全部 older：它要删的是整个旧段）。
 *   - 压缩前后 token（round 59）：记录带 tokensBefore / tokensAfter，给对话流里的
 *     「上下文已压缩（before → after tokens）」分界线用。
 *     tokensBefore = 压缩**之前**该会话最近一轮的实测输入 token（usage_runs 里那一行的 input，
 *     与 /api/usage/context 的 lastInput **同一口径**，共用 usage.ts 的 threadTokenReadout），
 *     必须在摘要用量落库之前读出来——摘要那一行也带 threadId，落库后再读就把摘要这轮当成了
 *     "最近一轮"（读数是压缩后的，分界线会说谎）；
 *     tokensAfter = **估算**：baselineInput（该会话首轮基线，取不到按 0）+ estimateTokens(
 *     摘要字符数 + 保留段字符数)。保留段按**与摘要素材同一套抽取口径**逐条算（transcriptLine），
 *     但**不套**素材的 48k 总长上限——它是要原样留在上下文里的那一段，不该被素材上限砍；
 *     usageOf 未注入 / 回 null / 抛错 → 两个字段都落 null（界面上如实不显示，不编造 0）；
 *     usageOf 成功但 lastInput 拿不到：before = null、after 照算。
 */
import { randomUUID } from 'node:crypto'
import type { LibSQLStore, SqliteClient } from '@mastra/libsql'
import type { MessageList } from '@mastra/core/agent'
import type { MastraMemory } from '@mastra/core/memory'
import type { InputProcessor } from '@mastra/core/processors'
import { compactionLevels, type CompactionLevel, type ThreadCompaction } from '../shared/threads'
import type { KyclawModel } from './model'
import type { ModelResolver } from './agents/kyclaw'
import { ProviderConfigError } from './model'
import { type UsageStore } from './usage'

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

/**
 * round 59：字符数 → token 的**估算**（中英混排约 3 字符/token 的经验折算）。
 *
 * 只用来给「压缩后上下文」一个量级（写进 thread_compactions.tokens_after）：压缩后的上下文
 * 还没真的跑过一轮，没有实测值可用；真实数字由 provider 的 usage 记账给出（见 usage.ts）。
 * 它是估算不是测量——别拿它当 token 精确值做判断。
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3)
}

/* ─────────────────────────── round 75：机械档（snip / dedupe） ─────────────────────────── */

/**
 * 每轮真正进 prompt 的历史消息条数上限（Mastra Memory 的 `lastMessages`）。
 * **与 index.ts 的 MEMORY_LAST_MESSAGES 同一口径**——那边改了这里要跟着改（两边都写死一个
 * 数字，是因为 compaction.ts 被 index.ts import，反过来 import 会成环）。
 * 用途只有一个：算"这次能省多少 token"时，比这更老的消息本来就不进 prompt，不计入收益。
 */
export const VISIBLE_HISTORY_MESSAGES = 40

/** 处理器裁剪时**不动**的最近消息条数（= 缺省保留窗口：最近几轮是当前任务现场，动了会把活干坏） */
export const PROCESSOR_KEEP_MESSAGES = DEFAULT_KEEP_MESSAGES

/** snip 只碰超过这个字符数的工具结果（更小的改写收益抵不上"模型看不到原文"的代价） */
export const SNIP_MIN_RESULT_CHARS = 1_000

/** 占位说明里保留结果开头的行数 / 字符上限（占位说明本身要小，否则不叫精简） */
export const SNIP_HEAD_LINES = 20
export const SNIP_HEAD_CHARS = 1_200

/** 参数摘要的字符上限（模型/用户认得出"这是哪次调用"就够） */
export const SNIP_ARG_CHARS = 200

/** snip 一次改写至少要净省这么多字符（占位说明比原文短出来的量；挡住"改完反而更长"） */
export const SNIP_MIN_GAIN_CHARS = 500

/** 去重只碰超过这个字符数的工具结果（比 snip 宽：去重是零损失，小的重复也值得指路） */
export const DEDUPE_MIN_RESULT_CHARS = 400

/** 去重一次改写至少要净省这么多字符 */
export const DEDUPE_MIN_GAIN_CHARS = 200

/** 折叠只碰**正文合计**超过这个字符数的段（一小段助手正文折了也是噪音，不如留着） */
export const FOLD_MIN_SEGMENT_CHARS = 600

/** 折叠一次改写至少要净省这么多字符（折叠说明 + 各条指路标记比原文短出来的量） */
export const FOLD_MIN_GAIN_CHARS = 300

/** 折叠说明里"讲的是什么"那句摘要的字符上限（一行，长了就不叫一行） */
export const FOLD_DIGEST_MAX_CHARS = 120

/** 折叠说明里点名"折了几条消息"的格式 */
export const FOLD_MARKER = '[已折叠]'

/** 同段里第二、三条之后被折掉正文、又不带别的 part 时留的那枚指路标记 */
export const FOLD_POINTER = '【已折叠】正文见本段开头的折叠说明。'

/**
 * 机械档的通过线（**估算** token）：本档至少释放这么多才停在这里、不去付摘要那一笔。
 * 2000 token ≈ 6k 字符——低于这个量级的分界线对用户也是噪音，不如继续往下走。
 */
export const MECHANICAL_MIN_FREED_TOKENS = 2_000

/**
 * 机械档的三档（不含 summary——那个要调模型，不在这一族里）。
 * **顺序就是力度顺序**：snip → dedupe → fold，见 nextMechanicalLevel / mechanicalDecision。
 */
export const mechanicalLevels = ['snip', 'dedupe', 'fold'] as const

export type MechanicalLevel = (typeof mechanicalLevels)[number]

/** 压缩只读/改写的最小消息面（存储消息形状；逐项防御，坏数据跳过） */
export interface CompactMessageLike {
  id?: unknown
  role?: unknown
  content?: unknown
}

/** 一段工具结果的文本（字符串原样；对象按 JSON 折算——模型看到的开销就是它） */
export function resultText(result: unknown): string | null {
  if (typeof result === 'string') return result
  if (result === undefined || result === null) return null
  const json = JSON.stringify(result)
  return typeof json === 'string' ? json : null
}

/** 参数摘要（一行、截断） */
export function argsSummaryOf(args: unknown): string {
  const json = JSON.stringify(args ?? null) ?? 'null'
  return json.length > SNIP_ARG_CHARS ? `${json.slice(0, SNIP_ARG_CHARS)}…` : json
}

/** 结果开头的若干行（占位说明要留的"这里曾经有什么"） */
export function resultHead(text: string): string {
  const head = text.split('\n').slice(0, SNIP_HEAD_LINES).join('\n')
  return head.length > SNIP_HEAD_CHARS ? `${head.slice(0, SNIP_HEAD_CHARS)}…` : head
}

/**
 * snip 档的占位说明（四件事都要有：工具名、参数摘要、结果开头、**去哪找原文**）。
 * 最后一行是给模型的"别以为这件事没做过"：它要说清原文既在用户的对话记录里完整保留，
 * 也能靠重新执行同一个工具拿回来（否则模型会重跑一遍同样的活）。
 */
export function snipPlaceholder(
  toolName: string,
  args: unknown,
  chars: number,
  text: string
): string {
  return [
    `[工具结果已精简] ${toolName}`,
    `参数：${argsSummaryOf(args)}`,
    `结果原文共 ${chars} 字符，这里只留开头 ${SNIP_HEAD_LINES} 行：`,
    resultHead(text),
    '（其余部分没有发给模型，需要原文时重新执行同一个工具即可拿回——例如再 read 一次同一个文件；' +
      '用户的对话记录里这段原文仍然完整。）'
  ].join('\n')
}

/** dedupe 档的占位说明（指向首次出现处；零信息损失，所以不需要"重新执行"兜底） */
export function dedupePlaceholder(
  toolName: string,
  args: unknown,
  chars: number,
  firstToolName: string
): string {
  return [
    `[工具结果已去重] ${toolName}`,
    `参数：${argsSummaryOf(args)}`,
    `（这段内容与更早的一次 ${firstToolName} 结果重复，原文共 ${chars} 字符，这里不再重复；` +
      '需要时重新执行同一个工具即可）'
  ].join('\n')
}

/** 机械档一趟的结果 */
export interface MechanicalStage<T> {
  /** 改写后的消息列（没改动的消息是**同一个对象**，逐条同一性保留） */
  messages: T[]
  /** 被改写的消息条数 */
  rewritten: number
  /** 释放的字符数（结果原文 − 占位说明） */
  freedChars: number
  /** 输入那一段的"活"体积（正文 + 工具结果字符数） */
  beforeChars: number
}

/* ───────────────────────── round 76：fold 档（折叠）的纯规则 ───────────────────────── */

/** 工具调用的终态（与 trajectory 的 pending 判定同一口径：不是这三个就还没收尾） */
const SETTLED_TOOL_STATES = new Set(['result', 'output-error', 'output-denied'])

/**
 * 这次工具调用收尾了吗（"不活跃"判定的唯一依据）。
 * 有 state 就认 state（终态才算收尾）；没有 state 的老数据退一步认"有没有结果"——
 * 有结果就是跑完了；两者都拿不到 = 没收尾（宁可这一轮不折，也别折掉正在等审批的那一段）。
 */
function toolSettled(part: unknown): boolean {
  const invocation = (part as { toolInvocation?: Record<string, unknown> })?.toolInvocation
  if (invocation === undefined) return true
  const state = invocation.state
  if (typeof state === 'string' && state !== '') return SETTLED_TOOL_STATES.has(state)
  return invocation.result !== undefined && invocation.result !== null
}

/** 一条消息里的正文（text part 的原文，按序） */
function textPartsOf(message: CompactMessageLike): string[] {
  const parts = partsOf(message)
  if (parts === null) return []
  return parts.flatMap((part) => {
    if (typeof part !== 'object' || part === null) return []
    if ((part as { type?: unknown }).type !== 'text') return []
    const text = (part as { text?: unknown }).text
    return typeof text === 'string' ? [text] : []
  })
}

/** 段内用到的工具名（去重、按首次出现序；说明里要给模型一个"这段干过什么"的抓手） */
function toolNamesOf(messages: readonly CompactMessageLike[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    const parts = partsOf(message)
    if (parts === null) continue
    for (const part of parts) {
      if (typeof part !== 'object' || part === null) continue
      if ((part as { type?: unknown }).type !== 'tool-invocation') continue
      const invocation = (part as { toolInvocation?: Record<string, unknown> }).toolInvocation
      const name = invocation?.toolName
      if (typeof name === 'string' && name !== '' && !names.includes(name)) names.push(name)
    }
  }
  return names
}

/** 段内提到的文件路径（从工具入参里认 path / file_path / filePath；"重新读哪条"就点名它） */
function fileHintsOf(messages: readonly CompactMessageLike[]): string[] {
  const hints: string[] = []
  const keys = ['path', 'file_path', 'filePath'] as const
  for (const message of messages) {
    const parts = partsOf(message)
    if (parts === null) continue
    for (const part of parts) {
      if (typeof part !== 'object' || part === null) continue
      if ((part as { type?: unknown }).type !== 'tool-invocation') continue
      const args = (part as { toolInvocation?: { args?: unknown } }).toolInvocation?.args
      if (typeof args !== 'object' || args === null) continue
      for (const key of keys) {
        const value = (args as Record<string, unknown>)[key]
        if (
          typeof value === 'string' &&
          value !== '' &&
          !hints.includes(value) &&
          hints.length < 3
        ) {
          hints.push(value)
        }
      }
    }
  }
  return hints
}

/**
 * 正文 → 一行"讲了什么"（**本地规则**，不调模型）。
 *
 * 规则：压成一行、取**第一句**（遇到换行或 。！？!? 就断），超过 FOLD_DIGEST_MAX_CHARS 截断加省略号。
 * 为什么是第一句：用户/助手写下的第一句通常就是"这段在干什么"（"我看了一下压缩实现，……"）；
 * 再深的内容要么在折叠说明的"怎么恢复"里给回路径，要么由模型按需重新展开——这一档的定位就是
 * "零成本地记住这里有过什么事"，不是"替模型读一遍"。
 */
export function foldDigest(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  const match = /^[\s\S]*?[。！？!?]/.exec(flat)
  const sentence = (match?.[0] ?? flat).trim()
  return sentence.length > FOLD_DIGEST_MAX_CHARS
    ? `${sentence.slice(0, FOLD_DIGEST_MAX_CHARS)}…`
    : sentence
}

/**
 * fold 档的折叠说明：**三件事都要有**——折了几条消息、这一段讲的是什么、**怎么恢复**。
 * 与 snip/dedupe 的占位说明同一条口径：原文没删、只是没发给模型，说清"去哪拿回来"。
 */
export function foldPlaceholder(input: {
  /** 这一段被折掉正文的消息条数 */
  count: number
  /** 这一段原有的助手正文合计字符数 */
  textChars: number
  digest: string
  /** 段内用到的工具名（可能为空） */
  toolNames: readonly string[]
  /** 段内提到的文件（可能为空；"重新读哪条"点名用） */
  fileHints: readonly string[]
}): string {
  const tools =
    input.toolNames.length === 0
      ? ''
      : `，其中 ${input.toolNames.join('、')} 等工具的调用与结果仍然完整保留`
  const recover =
    input.fileHints.length === 0
      ? '需要这一段的内容时让它重新展开：直接问它"刚才那一段讲了什么"，或让它重新做一遍当时那件事。'
      : `需要这一段的内容时让它重新展开：让它重新读 ${input.fileHints.join('、')}，或直接问它"刚才那一段讲了什么"。`
  return [
    `${FOLD_MARKER} 这里折了 ${input.count} 条消息：这一段已经结束，讲的是「${input.digest}」`,
    `（原有助手正文 ${input.textChars} 字${tools}；用户的每条消息原样保留、一条消息都没有删除，`,
    `原文仍完整保存在用户的对话记录里。${recover}）`
  ].join('\n')
}

/** 机械档一趟的结果 */

/** 一条消息里 parts 数组（v2 形状；读不出数组 = null） */
function partsOf(message: CompactMessageLike): unknown[] | null {
  const content = message.content
  if (typeof content !== 'object' || content === null) return null
  const parts = (content as { parts?: unknown }).parts
  return Array.isArray(parts) ? parts : null
}

/** 一个 part 的"活"字符数（只算正文与工具结果——思考过程不进模型这一轮的裁剪射程） */
function partChars(part: unknown): number {
  if (typeof part !== 'object' || part === null) return 0
  const { type } = part as { type?: unknown }
  if (type === 'text') {
    const text = (part as { text?: unknown }).text
    return typeof text === 'string' ? text.length : 0
  }
  if (type === 'tool-invocation') {
    const invocation = (part as { toolInvocation?: { result?: unknown } }).toolInvocation
    return invocation === undefined ? 0 : (resultText(invocation.result)?.length ?? 0)
  }
  return 0
}

/** 一段消息列的"活"字符数（正文 + 工具结果） */
export function liveCharsOf(messages: readonly CompactMessageLike[]): number {
  let total = 0
  for (const message of messages) {
    const parts = partsOf(message)
    if (parts === null) continue
    for (const part of parts) total += partChars(part)
  }
  return total
}

/**
 * 机械档的一趟改写（纯函数，不改输入）：`snip` 只做大工具结果，`dedupe` 只做重复结果，
 * `fold` 只做助手正文（见 foldStage）——三档分开算，调用方按 `snip → dedupe → fold` 串起来
 * （后一档看的是前一档改写之后的文本，那才是模型真会看到的那份）。
 *
 * snip / dedupe 的改写方向只有一处：**只动 tool-invocation 的 result**。用户消息、助手正文、
 * 工具参数、消息条数一律不碰——"用户原话原样保留"是这条路径的硬口径。
 */
export function mechanicalStage<T extends CompactMessageLike>(
  messages: readonly T[],
  level: MechanicalLevel
): MechanicalStage<T> {
  if (level === 'fold') return foldStage(messages)
  /** 已出现过的结果文本 → 工具名（首次出现的那条，去重指的就是它） */
  const seen = new Map<string, string>()
  /** 更早的结果（去重的"包含"判定用；只留比候选更长的） */
  const earlier: { text: string; toolName: string }[] = []
  let rewritten = 0
  let freedChars = 0
  let beforeChars = 0

  const nextMessages = messages.map((message) => {
    const parts = partsOf(message)
    if (parts === null) return message
    let changed = false
    const nextParts = parts.map((part) => {
      if (typeof part !== 'object' || part === null) return part
      if ((part as { type?: unknown }).type !== 'tool-invocation') {
        beforeChars += partChars(part)
        return part
      }
      const invocation = (part as { toolInvocation?: Record<string, unknown> }).toolInvocation
      const text = invocation === undefined ? null : resultText(invocation.result)
      if (invocation === undefined || text === null) return part
      beforeChars += text.length
      const toolName =
        typeof invocation.toolName === 'string' && invocation.toolName !== ''
          ? invocation.toolName
          : 'unknown'
      const args = invocation.args

      if (level === 'snip') {
        if (text.length < SNIP_MIN_RESULT_CHARS) return part
        const placeholder = snipPlaceholder(toolName, args, text.length, text)
        const gain = text.length - placeholder.length
        if (gain < SNIP_MIN_GAIN_CHARS) return part
        changed = true
        rewritten += 1
        freedChars += gain
        return { ...part, toolInvocation: { ...invocation, result: placeholder } }
      }

      // dedupe：完全重复，或已被更早的同类结果包含（两者都是零信息损失）
      const exact = seen.get(text)
      const firstToolName =
        exact ??
        earlier.find(
          (entry) =>
            entry.toolName === toolName &&
            entry.text.length > text.length &&
            entry.text.includes(text)
        )?.toolName
      if (firstToolName === undefined) {
        if (text.length >= DEDUPE_MIN_RESULT_CHARS) {
          seen.set(text, toolName)
          earlier.push({ text, toolName })
        }
        return part
      }
      const placeholder = dedupePlaceholder(toolName, args, text.length, firstToolName)
      const gain = text.length - placeholder.length
      if (gain < DEDUPE_MIN_GAIN_CHARS) return part
      changed = true
      rewritten += 1
      freedChars += gain
      return { ...part, toolInvocation: { ...invocation, result: placeholder } }
    })
    if (!changed) return message
    return {
      ...message,
      content: { ...(message.content as Record<string, unknown>), parts: nextParts }
    }
  })

  return { messages: nextMessages as T[], rewritten, freedChars, beforeChars }
}

/**
 * fold 档的一趟改写（纯函数，不改输入，**不调模型**）：把旧段里"连续的一段助手消息"折成一行说明。
 *
 * ## 段是怎么切的
 *
 * 段 = 消息列里**连续的一条条助手消息**（`role === 'assistant'`）。任何非助手消息（用户的每条
 * 原话、以及其他任何角色）都是段的边界，**永不被折、也永不被改**——"用户原话原样保留"是这条
 * 路径的硬口径，折叠这一档最容易碰到它，所以段切分就把用户消息当墙。
 * 段里**没有正文**的消息（纯工具调用那几条）既不折也不动：它们一个字节都不在折叠射程里。
 *
 * ## 一个段要被折，得同时满足
 *
 *   1. 段内助手**正文合计** ≥ FOLD_MIN_SEGMENT_CHARS（几百字的段折了也是噪音）；
 *   2. 段内**没有未收尾的工具调用**——等审批 / 半截的调用意味着活还没干完（"不活跃"不成立），
 *      折了会把现场弄丢；
 *   3. 折完要**净省** ≥ FOLD_MIN_GAIN_CHARS（折叠说明 + 指路标记比原文短出来的量）。
 *
 * ## 折成什么样（**消息一条不删、顺序不变、别的消息一个字节不改**）
 *
 *   - 段里**第一条有正文的**消息：它的正文 part 合并成**一个**折叠说明 part（位置落在原来第一个
 *     正文 part 处，其余正文 part 去掉）；工具调用 part 原样往后排；
 *   - 段里其余**有正文的**消息：正文 part 去掉（工具调用 part 原样留）；去掉之后一条 part 都不剩
 *     的消息补一枚 FOLD_POINTER（**不能留一条空消息进 prompt**——有的 provider 不收空 content）；
 *   - 被折掉正文的消息 `rewritten += 1`（= 折叠说明里那个 N），释放量 = 段内正文合计 − 折叠说明
 *     − 补的指路标记。
 *
 * 只改"这一轮发给模型的那一份"：不改输入对象（没被折的消息保持同一性）、不删消息——
 * 存储与对话界面里的原文一字未动（见头注的 `fold` 档边界）。
 */
export function foldStage<T extends CompactMessageLike>(
  messages: readonly T[]
): MechanicalStage<T> {
  /** 段：连续助手消息的下标 */
  const segments: number[][] = []
  let current: number[] = []
  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      current.push(index)
      return
    }
    if (current.length > 0) segments.push(current)
    current = []
  })
  if (current.length > 0) segments.push(current)

  /** 消息下标 → 折叠说明（该段第一条有正文的）或 null（该段其余有正文的：正文折掉） */
  const plan = new Map<number, string | null>()
  let rewritten = 0
  let freedChars = 0

  for (const indexes of segments) {
    const segment = indexes.map((index) => messages[index] as CompactMessageLike)
    // 只对"有正文的那几条"动手；纯工具调用的消息既不折也不改
    const foldable = indexes.filter(
      (index) => textPartsOf(messages[index] as CompactMessageLike).length > 0
    )
    if (foldable.length === 0) continue
    const texts = foldable.flatMap((index) => textPartsOf(messages[index] as CompactMessageLike))
    const textChars = texts.reduce((sum, text) => sum + text.length, 0)
    // 未收尾的工具调用 = 这段还在干活（等审批 / 半截）：整段放过
    const unsettled = segment.some((message) =>
      (partsOf(message) ?? []).some(
        (part) =>
          typeof part === 'object' &&
          part !== null &&
          (part as { type?: unknown }).type === 'tool-invocation' &&
          !toolSettled(part)
      )
    )
    if (unsettled) continue
    if (textChars < FOLD_MIN_SEGMENT_CHARS) continue

    const target = foldable[0] as number
    const placeholder = foldPlaceholder({
      count: foldable.length,
      textChars,
      digest: foldDigest(texts[0] ?? '') || '（这一段没有文字，只有工具调用）',
      toolNames: toolNamesOf(segment),
      fileHints: fileHintsOf(segment)
    })
    // 其余消息去掉正文后可能一条 part 不剩：那要补一枚指路标记（不让空消息进 prompt）
    const pointers = foldable.filter(
      (index) => index !== target && partsOnlyText(messages[index] as CompactMessageLike)
    ).length
    const gain = textChars - placeholder.length - pointers * FOLD_POINTER.length
    if (gain < FOLD_MIN_GAIN_CHARS) continue

    for (const index of foldable) plan.set(index, index === target ? placeholder : null)
    rewritten += foldable.length
    freedChars += gain
  }

  // beforeChars 与 snip/dedupe 同一口径：输入那一段的"活"体积（正文 + 工具结果），与折没折无关
  const beforeChars = liveCharsOf(messages)
  if (rewritten === 0) {
    return { messages: messages as T[], rewritten: 0, freedChars: 0, beforeChars }
  }

  const nextMessages = messages.map((message, index) => {
    if (!plan.has(index)) return message
    const placeholder = plan.get(index) ?? null
    const parts = partsOf(message)
    if (parts === null) return message
    let placed = false
    const nextParts = parts.flatMap((part) => {
      if (!isTextPart(part)) return [part]
      if (placeholder === null) return [] // 段内其余消息：正文折掉了
      if (placed) return [] // 同一条消息里的其余正文 part 也折掉（说明只留一份）
      placed = true
      return [{ ...(part as Record<string, unknown>), text: placeholder }]
    })
    const settled = nextParts.length > 0 ? nextParts : [{ type: 'text', text: FOLD_POINTER }]
    return {
      ...message,
      content: { ...(message.content as Record<string, unknown>), parts: settled }
    }
  })

  return { messages: nextMessages as T[], rewritten, freedChars, beforeChars }
}

/** 一个 part 是不是正文（text） */
function isTextPart(part: unknown): boolean {
  return typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
}

/** 一条消息的 parts 是否**全**是正文（折完就一条 part 都不剩 → 要补 FOLD_POINTER） */
function partsOnlyText(message: CompactMessageLike): boolean {
  const parts = partsOf(message)
  return parts !== null && parts.every((part) => isTextPart(part))
}

/**
 * 下一轮该从哪一档起算（"同一档不重复停"）：
 * 没有记录 / 上一次是摘要 → 从 `snip` 起；上一次停在某机械档 → 从它的**下一档**起
 * （snip → dedupe → fold）；已经停在最后一档（fold）→ null（三档都在生效，只能去付摘要）。
 */
export function nextMechanicalLevel(previous: ThreadCompaction | null): MechanicalLevel | null {
  const level = recordLevelOf(previous)
  if (level === 'summary') return 'snip'
  return mechanicalLevels[mechanicalLevels.indexOf(level) + 1] ?? null
}

/**
 * 记录档位（读侧宽容，与 store 的 `compactionLevelOf` 同一口径）：
 * 没有 / 认不出来的档位一律按 `summary`——round 75 之前只有那一条路，这么说才是真话。
 */
export function recordLevelOf(record: ThreadCompaction | null): CompactionLevel {
  return record === null ? 'summary' : compactionLevelOf(record.level)
}

/** 机械档决策：这一轮停在哪一档（null = 三档都不够，去走摘要） */
export interface MechanicalDecision {
  level: MechanicalLevel
  /** 本次**新启用**的改写条数（记录里 summarized 用它） */
  rewritten: number
  /** 本次新启用部分释放的字符数（估 tokensAfter 用它） */
  freedChars: number
}

/**
 * 在旧段上算一遍机械档：按 `snip → dedupe → fold` 逐档算（每一档都在上一档改写之后的文本上算，
 * 那才是模型真会看到的一份）。任一级达到通过线就停（返回该档），三档都不到 = null。
 *
 * 通过线看的是**从上次停的档之后累加**到本档的省量——上次已经停在那里省过的量不再重复计入
 * （见 nextMechanicalLevel 与 MECHANICAL_MIN_FREED_TOKENS 的口径）。
 */
export function mechanicalDecision(
  older: readonly CompactMessageLike[],
  previous: ThreadCompaction | null
): MechanicalDecision | null {
  const from = nextMechanicalLevel(previous)
  if (from === null) return null
  const start = mechanicalLevels.indexOf(from)
  let current: readonly CompactMessageLike[] = older
  let freedChars = 0
  let rewritten = 0
  for (const [index, level] of mechanicalLevels.entries()) {
    const stage = mechanicalStage(current, level)
    current = stage.messages
    // 上次已经停在这一档之前：这一档的改写早就开着，不算"本次新启用"的量
    if (index < start) continue
    freedChars += stage.freedChars
    rewritten += stage.rewritten
    if (estimateTokens(freedChars) >= MECHANICAL_MIN_FREED_TOKENS) {
      return { level, rewritten, freedChars }
    }
  }
  return null
}

/** 机械档记录里那段人话（分界线展开后给用户看的；说清"这次是怎么省的"） */
export function mechanicalSummaryText(decision: MechanicalDecision): string {
  const freed = estimateTokens(decision.freedChars)
  if (decision.level === 'snip') {
    return [
      `这次没有调用模型：把较早的 ${decision.rewritten} 条工具结果换成了占位说明（每条只留工具名、参数与开头 ${SNIP_HEAD_LINES} 行），`,
      `省下约 ${freed} tokens。用户的每条消息和助手写下的文字一字未动，也没有删除任何消息；`,
      '需要被省掉的原文时，让助手重新执行对应的工具（比如再读一次同一个文件）就能拿回来。'
    ].join('\n')
  }
  if (decision.level === 'dedupe') {
    return [
      `这次没有调用模型：除了精简大工具结果，又把 ${decision.rewritten} 条与更早结果重复的工具结果指向了首次出现处`,
      `（内容一条没丢），共省下约 ${freed} tokens。用户的每条消息和助手写下的文字一字未动，也没有删除任何消息。`
    ].join('\n')
  }
  return [
    `这次没有调用模型：除了精简大工具结果、把重复结果指向首次出现处，还把较早那几段已经结束的对话里`,
    `助手的较长正文折成了折叠说明（共 ${decision.rewritten} 条消息；说明里写了这一段讲的是什么、怎么让它重新展开），`,
    `共省下约 ${freed} tokens。用户的每条消息原样保留、一条消息都没有删除，被折掉的正文也仍在用户的对话记录里——`,
    '需要那段内容时，让助手重新读相关文件、或直接问它"刚才那一段讲了什么"就能拿回来。'
  ].join('\n')
}

/** 机械档要注入的那一行（真正的交代在各条占位/折叠说明里，这里只说清"历史被精简过"） */
export function mechanicalPrefix(level: MechanicalLevel): string {
  const what =
    level === 'snip'
      ? '较早的若干条工具结果'
      : level === 'dedupe'
        ? '较早的若干条工具结果（含重复项）'
        : '较早的若干条工具结果与若干段已结束话题的助手正文'
  return `【上下文已精简】${what}已替换为占位/折叠说明（原文仍在用户的对话记录里；需要时重新执行对应工具、或让它重新展开那一段即可）。`
}

/* ─────────────────────────────── round 59：token 读数与记录 ─────────────────────────────── */

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

/** libsql 列值 → number|null（NULL / 读不出数字 = null；round 59 的两个 token 列用） */
function nullableInt(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = typeof value === 'bigint' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return null
  return Math.trunc(parsed)
}

/**
 * 列值 → 档位（round 75）。NULL（round 71 及更早的记录）与认不出来的脏值都归一到 `summary`：
 * 那时只有摘要这一条路，按 summary 读出来才是真话（编一个 snip 会让分界线说"没调模型"）。
 */
export function compactionLevelOf(value: unknown): CompactionLevel {
  return typeof value === 'string' && (compactionLevels as readonly string[]).includes(value)
    ? (value as CompactionLevel)
    : 'summary'
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
          "created_at" TEXT NOT NULL,
          "tokens_before" INTEGER,
          "tokens_after" INTEGER,
          "level" TEXT
        )`
      )
      // round 59 列迁移：round 58 及更早建的库里没有这两列，读/写都会炸——先查现状再补。
      // 不用"ALTER 失败就当列已存在"的 catch 兜底：那会把真正的失败也吞掉（列查得到才不补）
      // round 75：level 同款迁移（更老的库同样没有这一列）。
      const columns = await client.execute(`PRAGMA table_info("${COMPACTION_TABLE}")`)
      const existing = new Set(columns.rows.map((row) => String(row.name)))
      for (const column of ['tokens_before', 'tokens_after', 'level']) {
        if (!existing.has(column)) {
          await client.execute(
            `ALTER TABLE "${COMPACTION_TABLE}" ADD COLUMN "${column}" ${
              column === 'level' ? 'TEXT' : 'INTEGER'
            }`
          )
        }
      }
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
          ("thread_id", "summary", "summarized", "kept", "created_at", "tokens_before", "tokens_after", "level")
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          record.threadId,
          record.summary,
          record.summarized,
          record.kept,
          record.createdAt,
          record.tokensBefore,
          record.tokensAfter,
          // 档位落库时**一定**是具体值（契约里它可选是读侧宽容；没写的按 summary 存，
          // 与读侧归一同一口径，别把 undefined 塞进 NOT NULL 语义的列）
          recordLevelOf(record)
        ]
      })
    },
    async get(threadId) {
      await ensureTable()
      const result = await client.execute({
        sql: `SELECT "thread_id", "summary", "summarized", "kept", "created_at", "tokens_before", "tokens_after", "level"
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
        createdAt: String(row.created_at),
        // 旧行这两列是 NULL → null（round 59 之前的记录没有 token 读数，不编造 0）
        tokensBefore: nullableInt(row.tokens_before),
        tokensAfter: nullableInt(row.tokens_after),
        // round 75：旧行（round 71 及更早）没有 level 列值 → 归一成 summary（那时只有摘要这一条路）；
        // 值认不出来（脏数据）同样按 summary 算，绝不编出一个没走过的档位
        level: compactionLevelOf(row.level)
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
 * 输入处理器：把该会话的压缩记录落到这一轮的 prompt 上。
 *
 *   - `summary` 档（round 19 起的老路）：加一条系统前缀（摘要），普通消息不动。
 *   - `snip` / `dedupe` / `fold` 档（round 75 / 76）：加一行说明 + 把**较早的工具结果**换成占位
 *     说明、**较早那几段已结束话题的助手正文**换成折叠说明（见 trimLoadedHistory）——只改这一轮
 *     发给模型的那一份，存储与对话界面里的原文一字不动。
 *
 * 时序依据（读 @mastra/core 1.75.0 实现）：`requestContext.set('MastraMemory', ...)` 在
 * `runInputProcessors` 之前；配置的处理器排在 memory 自带处理器（历史载入）之后。
 * 返回 `args.messageList`（已就地改过）——摘要不落存储/不进 UI 流。
 */
export function createCompactionProcessor(store: Pick<CompactionStore, 'get'>): InputProcessor {
  return {
    id: COMPACTION_PROCESSOR_ID,
    processInput: async (args) => {
      const threadId = threadIdOfRequestContext(args.requestContext)
      if (threadId === null) return args.messageList
      const record = await store.get(threadId)
      if (record === null) return args.messageList
      // 档位读侧归一（缺省 = summary）：下面按它分支，机械档才去改这一轮的消息列
      const level = recordLevelOf(record)
      if (level === 'summary') {
        args.messageList.addSystem(compactionPrefix(record.summary))
        return args.messageList
      }
      args.messageList.addSystem(mechanicalPrefix(level))
      // 裁剪窗口 = 这条记录当时认定的保留窗口（服务端算省量的口径），两边同一个窗口
      trimLoadedHistory(args.messageList, level, record.kept)
      return args.messageList
    }
  }
}

/**
 * 按机械档改写这一轮**载入的历史**（round 75，round 76 加 fold）：只动「最近 `keep` 条以外」
 * 且「来自存储（source = memory）」的工具结果（snip/dedupe）与助手正文（fold）；本轮新产生的
 * 消息（source = input / response）一律不碰——那一段是正在干的活，而且改了会污染轮末的落库。
 *
 * `keep` 由调用方给（处理器传记录里的 `kept`）：**裁剪窗口要与压缩时认定的一致**——服务端算
 * "这次能省多少"用的就是"最近 kept 条以外的旧段"，处理器按同一个窗口动手，两边才对得上账。
 * 缺省 PROCESSOR_KEEP_MESSAGES（= 缺省保留窗口 10 条）。
 *
 * 档位是**累计开关**：记录停在 `fold` = 三档全开，所以按 `snip → dedupe → fold` 逐档叠上去，
 * 到记录那一档为止（见 mechanicalLevels 的顺序）。
 *
 * 改写手法（**这里的细节有实测依据，改之前先看**）：`messageList.add(改过的消息, 'memory',
 * { merge: false })` 对"同 id"的消息会被判等并**直接返回**——@mastra/core 1.75.0 的
 * `messagesAreEqual` 对 DB 消息比对 `CacheKeyGenerator.fromDBParts`，而 tool-invocation 的 key
 * 只看 `toolCallId + state`，**不看 result**（见其 fromAIV4Part）。所以先 `removeByIds` 再 `add`：
 * 走 append + `sortMessages()`（按 createdAt 重排）那条路，消息仍回到原位、顺序不变。
 *
 * 返回被改写的条数（各档累计；0 = 这一轮没什么可省）。
 */
export function trimLoadedHistory(
  messageList: MessageList,
  level: MechanicalLevel,
  keep: number = PROCESSOR_KEEP_MESSAGES
): number {
  const upto = mechanicalLevels.indexOf(level)
  if (upto < 0) return 0
  const source = messageList.makeMessageSourceChecker()
  const all = messageList.get.all.db()
  // 至少兜住最后 KEEP_MIN 条：记录里的 kept 理论上可能被写成 0（脏数据），那种窗口会把
  // "正在干的那一轮"也裁掉，宁可少裁
  const end = all.length - Math.max(KEEP_MIN, keep)
  if (end <= 0) return 0
  const start = Math.max(0, all.length - VISIBLE_HISTORY_MESSAGES)
  const history = all.slice(start, end).filter((message) => source.getSource(message) === 'memory')
  if (history.length === 0) return 0

  let staged: readonly {
    id?: unknown
    role?: unknown
    content?: unknown
  }[] = history
  let rewritten = 0
  for (const [index, step] of mechanicalLevels.entries()) {
    if (index > upto) break
    const stage = mechanicalStage(staged, step)
    staged = stage.messages
    rewritten += stage.rewritten
  }
  if (rewritten === 0) return 0

  for (let index = 0; index < history.length; index += 1) {
    const message = history[index]
    const next = staged[index]
    if (message === undefined || next === undefined || next === message) continue
    const id = String(message.id ?? '')
    if (id === '') continue
    messageList.removeByIds([id])
    messageList.add(next as Parameters<MessageList['add']>[0], 'memory', { merge: false })
  }
  return rewritten
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
  const lines = transcriptLines(messages)
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

/** 逐条渲染成素材行（坏数据 / 思考过程跳过）——buildTranscript 与 transcriptChars 共用这一套口径 */
function transcriptLines(messages: ReadonlyArray<{ role?: unknown; content?: unknown }>): string[] {
  return messages.flatMap((message) => {
    const line = transcriptLine(message)
    return line === null ? [] : [line]
  })
}

/**
 * round 59：保留下来的那段消息按**与摘要素材同一套抽取口径**拼起来的字符数（估 tokensAfter 用）。
 * 与 buildTranscript 的唯一差别：**不套** TRANSCRIPT_MAX_CHARS 上限——保留段是要原样留在
 * 上下文里的那一段，估上下文体积时不该被素材上限砍掉。
 */
function transcriptChars(messages: ReadonlyArray<{ role?: unknown; content?: unknown }>): number {
  const lines = transcriptLines(messages)
  return lines.length === 0 ? 0 : lines.join('\n\n').length
}

/** 摘要失败能给用户看的那一行文案（ProviderConfigError 原文就是人话；其余不暴露后端细节） */
export function compactionErrorText(error: unknown): string {
  if (error instanceof ProviderConfigError) return error.message
  return '压缩没能完成：模型这次没跑通，请稍后重试。'
}

/**
 * round 59：压缩记录要的 token 读数（压缩**之前**取一次）。
 * 形状对齐 usage.ts 的 threadTokenReadout / /api/usage/context 的同一口径。
 */
export interface CompactionTokenReadout {
  /** 该会话最近一轮的实测输入 token（拿不到 = null） */
  lastInput: number | null
  /** 该会话首轮输入的基线（拿不到 = null） */
  baselineInput: number | null
}

export interface CreateCompactionServiceOptions {
  memory: CompactionMemory
  store: CompactionStore
  /** 默认 provider 的解析器（每轮现读设置与密钥——与对话/标题同一条） */
  resolveModel: ModelResolver
  /** 摘要调用的 token 记账（并入 round 18 口径；缺省 = 不记） */
  usage?: UsageStore
  /**
   * round 59：压缩前的 token 读数（生产 = usage.ts 的 threadTokenReadout；缺省 = 记录里留 null）。
   * 调用时机在摘要用量落库**之前**，理由见头注。
   */
  usageOf?: (threadId: string) => Promise<CompactionTokenReadout | null>
  /** 测试注入；缺省走 ai 的 generateText */
  generate?: CompactGenerate
  now?: () => Date
  /** 测试注入（缩短超时）；缺省 60s */
  timeoutMs?: number
}

/** round 59：取一次读数；没注入 / 查库失败都算"拿不到"（两个字段留 null，不编造） */
async function readTokenReadout(
  usageOf: CreateCompactionServiceOptions['usageOf'],
  threadId: string
): Promise<CompactionTokenReadout | null> {
  if (usageOf === undefined) return null
  try {
    return await usageOf(threadId)
  } catch (error) {
    // 旁路纪律同用量记账：读数读不到只让分界线少两个数字，绝不拖累压缩本身
    console.warn('[kyclaw] 压缩前读会话 token 读数失败（记录里这两个字段留空）', error)
    return null
  }
}

export function createCompactionService(
  options: CreateCompactionServiceOptions
): CompactionService {
  const now = options.now ?? ((): Date => new Date())
  const generate = options.generate ?? defaultGenerate
  /**
   * round 62：**同会话压缩的 single-flight**（`threadId → 在跑的那一个 Promise`）。
   *
   * 为什么非有不可：`compact()` 是"读快照（recall / store.get）→ 调模型 → 落记录 → 按快照删消息"
   * 一长串，中途没有任何互斥。两次并发（用户双击手动入口、自动预压与手动入口撞上、或两个窗口
   * 同时触发）会各自按同一份旧快照跑：两次 save 覆盖同一行、两次 deleteMessages 删同一批 id
   * （后一次的摘要把前一次挤掉，等于白跑一轮、还可能丢掉前一次摘要里的信息）。
   *
   * 口径：同会话的并发调用**合并到同一个 Promise**（第二次拿到的是第一次的结果，连 keep 都不看
   * ——它要的是"压缩这件事完成"）；跑完/失败都在 finally 里清账，下一次调用重新开始；
   * 跨会话各跑各的（互不串行）。取舍参照同仓 `tools/guard.ts` 的 runExclusive，但那边是**串行排队**
   * （每个调用都要跑），这里要的是**去重合并**（同一件事不做第二遍）。
   */
  const inFlight = new Map<string, Promise<CompactOutcome>>()

  return {
    current: (threadId) => options.store.get(threadId),
    clear: (threadId) => options.store.clear(threadId),
    /**
     * round 62：入口先过 single-flight —— 同会话已有压缩在跑就直接把它那一个 Promise 交回去
     * （第二次调用拿到的是同一份结果，连 keep 都不再看：它要的是"这件事完成"）；
     * 跑完（成败都算）在 finally 里清账，下一次调用重新开始（不是永久缓存）。跨会话各跑各的。
     */
    compact(threadId, keep) {
      const running = inFlight.get(threadId)
      if (running !== undefined) return running
      const started = compactOnce(threadId, keep).finally(() => {
        inFlight.delete(threadId)
      })
      inFlight.set(threadId, started)
      return started
    }
  }

  /** 真正干活的这一轮（single-flight 的实体：同一会话同时最多跑一个） */
  async function compactOnce(threadId: string, keep?: number): Promise<CompactOutcome> {
    // requested：调用方想要保留的条数（夹到 2–40，缺省 10）
    const requested = Math.min(
      KEEP_MAX,
      Math.max(KEEP_MIN, Math.trunc(keep ?? DEFAULT_KEEP_MESSAGES))
    )
    // 已有摘要（重压要带上，见下）+ 一次读出来：无操作分支也要回它
    const previous = await options.store.get(threadId)
    // round 59：压缩前的 token 读数与 previous **一起在开头读**——摘要用量也是往 usage_runs
    // 写一行（threadId 照记），落库之后再读就把摘要那一轮当成了"最近一轮"，tokensBefore 会
    // 记成压缩后的数（分界线说反话）。这里读到的才是"压缩前最近一轮的实测输入"。
    const readout = await readTokenReadout(options.usageOf, threadId)
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
    // 保留段 = older 之外的后半段（tokensAfter 里按字符折算计入）
    const keptMessages = messages.slice(older.length)

    /**
     * round 75 / 76：**付钱之前先试零成本档**（snip → dedupe → fold）。够省就停在这里：
     * 不调模型、不删消息、不记账，只落一条记录（档位 + 这次精简/折叠了什么 + token 读数）。
     * 只算"看得见的那一段"（最近 VISIBLE_HISTORY_MESSAGES 条以内的旧段）——更老的消息本来
     * 就不进 prompt（见 VISIBLE_HISTORY_MESSAGES 注释）。
     */
    const visibleFrom = Math.max(0, messages.length - VISIBLE_HISTORY_MESSAGES)
    const visibleOlder = messages.slice(visibleFrom, older.length)
    const mechanical = mechanicalDecision(visibleOlder, previous)
    if (mechanical !== null) {
      const freed = estimateTokens(mechanical.freedChars)
      const record: ThreadCompaction = {
        threadId,
        summary: mechanicalSummaryText(mechanical),
        summarized: mechanical.rewritten,
        kept: messages.length - older.length,
        level: mechanical.level,
        createdAt: now().toISOString(),
        tokensBefore: readout?.lastInput ?? null,
        /**
         * 机械档的 after：**实测 lastInput − 本档释放的估算 token**（减掉的正是刚省下的那部分，
         * 比摘要档那套"基线 + 字符折算"准）。lastInput 拿不到时退回同族公式：基线 +
         * 裁剪后的可见旧段与保留段的字符折算（都是估算，界面上那个 `~` 就是标它的）。
         * 读数整个拿不到（没注入 / 查库失败）＝ null，不编造。
         */
        tokensAfter:
          readout === null
            ? null
            : readout.lastInput === null
              ? (readout.baselineInput ?? 0) +
                estimateTokens(
                  Math.max(0, liveCharsOf(visibleOlder) - mechanical.freedChars) +
                    liveCharsOf(keptMessages)
                )
              : Math.max(0, readout.lastInput - freed)
      }
      // 机械档不动消息、不调模型：只有这一条记录要落库（落库失败照抛，调用方降级）
      await options.store.save(record)
      return { compacted: true, compaction: record }
    }

    // 摘要只数本轮真实消息（summarized/kept 同口径）；空素材判定也只看新素材
    const material = buildTranscript(older)
    if (material === '') {
      throw new Error('压缩失败：这段历史没有可摘要的文本内容')
    }
    // 重压携带旧摘要：被删消息的原文早已不在库，不带上它二次压缩就会丢第一次摘要的信息。
    // round 75：只带**摘要档**留下的那段文本——机械档的 summary 是"这次精简了什么"的说明，
    // 不是被删历史的替身（那时消息都还在），拼进素材只会给摘要模型添噪音。
    const prompt =
      previous === null || recordLevelOf(previous) !== 'summary'
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
      level: 'summary',
      createdAt: now().toISOString(),
      // round 59：读数读不到（没注入 / 查库失败）两个字段都 null；只有 lastInput 缺时 after 照算
      tokensBefore: readout?.lastInput ?? null,
      tokensAfter:
        readout === null
          ? null
          : (readout.baselineInput ?? 0) +
            estimateTokens(summary.length + transcriptChars(keptMessages))
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
            // round 67：摘要调用是**单次**模型调用（generateText，没有多 step）——整轮合计就是
            // 那一次调用，所以上下文口径 = 同一个数；不把它记成 null（那会退回整轮合计，结果一样，
            // 但留 null 会让"这行有没有实测上下文"这件事说谎）
            contextInput: input,
            contextCachedInput: result.usage.cachedInputTokens ?? null,
            stepCount: 1,
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
