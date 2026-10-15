/**
 * 请求快照（round 87 / 用户反馈 015）：把"这一轮**实际发给 provider 的每一次请求**"落库，
 * 让轨迹能回答"这轮到底带了什么"——系统指令、记忆 / 规矩注入、工具表、发给模型的消息清单
 * （含后续步里的工具调用与结果）。
 *
 * ## 原料（实测，见 `__tests__/_r87-live-request.spec.ts` / `_r87-request-body.spec.ts`）
 *
 * `onFinish` 事件的 `steps[k].request.body` 就是 provider 收到的请求体。本机 LM Studio 实测一轮
 * （真实端点、无密钥）：body = 3 条 system（主指令 11,808 字 + 记忆指令 2,013 字 + 规矩 571 字）
 * + 1 条用户消息 + 35 件工具（工具表 81,641 字节），共 96 KB。
 * **记忆与规矩这两块不在 `mastra_messages` 里**（Mastra 只存用户 / 助手消息）——只落聊天历史
 * 就永远看不到它们，这正是用户反馈 015 指的那一层。
 *
 * 一轮里每一次模型调用（step）各发一份请求体，形状是"前缀 + 追加"：后一步多出这一轮的工具
 * 调用与结果。所以按 **step 逐条**落账（用户反馈 015 要的"后续工具结果"就在后几条里）。
 *
 * 失败的那次调用 `onFinish` **不触发**（provider 400 实测：没有 step、没有 body）——能记的只有
 * "这一轮失败了"这件事本身（`status='error'`，正文未知），由 chat 路由那侧的
 * `createRequestFailureRecorder` 从 UI 消息流的 error part 落一行。
 *
 * ## 纪律、覆盖范围与有界策略（都是这一处说了算）
 *
 *   - **只落 provider 真发的**：`system` / `tools` / `messages` 三样原文，认不出的一律 null，
 *     不自己拼一份"像请求体"的东西；失败那次**没有请求体**，就只记"这一轮失败了"（正文空着）；
 *   - **不落 headers / API key**：我们只取请求体与 UI 消息流里那句错误人话，请求头从来没进过这里。
 *     **消息**里的媒体 base64（`data:` 与裸 base64）只留一行说明、二进制（Buffer/Uint8Array）
 *     只留字节数，结构化值里的密钥**键**值换成 `<已脱敏>`；**失败原因**另过一遍凭据串扫描
 *     （`sk-…` / Bearer / JWT / `apiKey=…` / 长十六进制）。系统指令与工具表是应用自己拼的，
 *     原样存（只受安全上限约束）；消息正文不做全文密钥扫描 —— 那是用户自己的话，不该被改写；
 *   - **正文按内容分块去重**：消息正文切 4 KiB 分块入 `request_blobs`（键 = 内容哈希），
 *     系统指令与工具表整段入池；同一段文本只存一份。日常长度的正文**原样完整**；
 *     只有单段/单条超过安全上限（系统 20 万字 / 工具表 51.2 万字节 / 单条消息 20 万字）、
 *     消息条数超 400、单次请求正文总量超 200 万字才截断或丢弃，且**都置 `truncated`**
 *     （界面照实说"已截断"，消息那栏还会说"前面 N 条未保留"）；
 *   - **不夸大存储保证**：**正文**按内容去重，但**每条请求仍带一份它自己的消息引用表**
 *     （每条消息一行 `{role, chunks, chars, truncated}`）—— 长会话下这块**元数据**是
 *     O(轮数²·每轮消息数) 的小对象（每个哈希 32 字符），**不是** O(会话) 的保证。
 *     要做到元数据也线性，得上 dsh 那种"与上一步的公共前缀 + 增量"（`RequestPromptChange` 口径），
 *     本轮没做；
 *   - **列表不带正文**（一条请求 ~96 KB，长会话整份下发没有意义）：`listByThread` 只回计数与状态，
 *     正文按 `detail(id)` 按需取；
 *   - **只覆盖对话入口**：chat 路由 / ask-user 续跑 / Plan 续跑（审批续跑也走 chat 路由）。
 *     压缩摘要那次 `generateText`、会话标题生成、连接测试**不在这里** —— 它们的失败各自在别处
 *     反馈，轨迹不假装有它们的请求行。
 *
 * 与用量记账（usage.ts）同范式：同库、自建表、append-only；**旁路**——写失败只记日志，
 * 绝不让对话跟着挂。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { SqliteClient } from '@mastra/libsql'

/** request_snapshots 的表名（自建表，与 Mastra 的表同库） */
export const REQUEST_SNAPSHOT_TABLE = 'request_snapshots'
/** 正文（系统指令 / 工具表 / 单条消息）的表名：键 = 内容哈希，同一段文本只存一份 */
export const REQUEST_BLOB_TABLE = 'request_blobs'

/**
 * 正文的**分块大小**：正文先按内容分块去重（同一段文本在库里只存一份），
 * 日常长度的正文因此原样完整 —— 上限只在"离谱的巨型块"上兜底，不当门槛用。
 */
export const REQUEST_CHUNK_CHARS = 4_096
/**
 * 单段正文的**安全上限**（兜底，不是给日常正文设的门槛）：超了才截断并**标记** `truncated`。
 * 量级参照（本机实测）：一份满编请求 ~96 KB = 系统 1.4 万字 + 工具表 8.1 万字节。
 */
export const REQUEST_SYSTEM_MAX_CHARS = 200_000
export const REQUEST_TOOLS_MAX_CHARS = 512_000
export const REQUEST_MESSAGE_MAX_CHARS = 200_000
/** 单次请求落库正文总量上限：超了从**最旧的几段**开始丢（最近的历史与工具结果最要紧），并标记 */
export const REQUEST_TOTAL_MAX_CHARS = 2_000_000
/** 单次请求最多落多少条消息（超了只留**最后**这么多条，并标记） */
export const REQUEST_MESSAGES_MAX_COUNT = 400

/** 一条请求里发给模型的一条消息（正文可能被截断，`chars` 是原文长度） */
export interface RequestMessage {
  role: string
  text: string
  /** 原文长度（截断时 > text.length；界面据此说"已截断"） */
  chars: number
  truncated: boolean
}

/** 这一次请求的结局：拿到了请求体 = complete；这一轮失败了（正文未知）= error */
export type RequestStatus = 'complete' | 'error'

/** 一行请求快照（写入与按 id 读回共用；列表读回用 RequestSnapshotSummary） */
export interface RequestSnapshot {
  id: string
  /** 该次 run 的 id（Mastra 的 runId；拿不到 = null） */
  runId: string | null
  /** 这一轮属于哪条会话（从 onFinish 事件的 dbMessages 取；取不到 = null） */
  threadId: string | null
  /** 这一次模型调用是这一轮的第几步（0 基）；认不出 = null */
  step: number | null
  status: RequestStatus
  /** `status='error'` 的原因人话（已脱敏）；成功 = null */
  error: string | null
  /** 运行时的模型 id 原文（未知也照记） */
  model: string
  provider: string | null
  /** 实际发出去的系统指令原文；请求里没有 system = null */
  system: string | null
  /** 实际发出去的工具表原文（pretty JSON）；没有工具 / 认不出 = null */
  tools: string | null
  /** 实际发出去的消息清单（**最后**至多 REQUEST_MESSAGES_MAX_COUNT 条） */
  messages: RequestMessage[]
  /** 这一次请求发出去的消息条数（含 system）；认不出 = null */
  messageCount: number | null
  /** 这一次请求带着几件工具；认不出 = null */
  toolCount: number | null
  /** 有正文被截断（系统指令 / 工具表 / 某条消息超上限） */
  truncated: boolean
  /** ISO 时间串（落账时刻 = run 收尾，落在该轮的时间窗内） */
  createdAt: string
}

/** 列表行：不带正文（正文按 id 取），只够界面写"系统指令 · 12,345 字 · 35 个工具" */
export interface RequestSnapshotSummary {
  id: string
  runId: string | null
  threadId: string | null
  step: number | null
  status: RequestStatus
  error: string | null
  model: string
  provider: string | null
  messageCount: number | null
  toolCount: number | null
  /** 系统指令原文长度；请求里没有 system = null */
  systemChars: number | null
  /** 工具表原文长度；没有工具 = null */
  toolsChars: number | null
  truncated: boolean
  createdAt: string
}

/** request_snapshots 的读写口（测试与生产共用；真实现落 libsql） */
export interface RequestSnapshotStore {
  /** 建表（幂等；内部缓存，重复调用只建一次） */
  ensureTable(): Promise<void>
  insert(snapshot: RequestSnapshot): Promise<void>
  /** 某条会话的快照摘要（**时间升序**：与轨迹的轮次顺序一致；step 在同一时刻内升序） */
  listByThread(threadId: string): Promise<RequestSnapshotSummary[]>
  /** 一行请求的完整形态（含正文）；没有 = null */
  detail(id: string): Promise<RequestSnapshot | null>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function countOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value)
  if (typeof value === 'string' && value !== '' && Number.isFinite(Number(value))) {
    const parsed = Number(value)
    return parsed >= 0 ? Math.trunc(parsed) : null
  }
  return null
}

/** 内容哈希（正文去重的键；sha256 前 32 位十六进制足够，且避免把长正文带进索引） */
export function hashOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 32)
}

/**
 * 截断：超过上限只留前 `max` 个字符（**不加省略号进正文**——"截断"这件事由 `truncated` 标记
 * 与界面文案说，正文保持原文前缀，便于比对与复制）。
 */
function clampText(value: string, max: number): { text: string; truncated: boolean } {
  return value.length <= max
    ? { text: value, truncated: false }
    : { text: value.slice(0, max), truncated: true }
}

/** 裸 base64 的候选串：≥512 个连续 base64 字符（`data:` 前缀那种另走一条规则） */
const BASE64_RUN = /(?<![\w+/=])[A-Za-z0-9+/]{512,}={0,2}(?![\w+/=])/g

/**
 * 裸 base64 的判定：长度够**并且字符类别够杂**（大小写 / 数字 / `+ = /` 里至少三类）。
 * 为什么加这一道：`[A-Za-z0-9+/]` 的长串不一定是 base64 —— 一段 20 万字的纯小写正文、
 * 一串长 id 都会命中。真图片/真字节流经 base64 之后几乎必然混着大小写与数字，
 * 而**用户自己写的长正文**会让类别的数量掉下来。宁可漏掉退化的裸 base64
 * （`data:` 那种最常见的形状照样抓得住），也不误砍用户正文。
 */
function looksLikeBase64(run: string): boolean {
  const classes =
    Number(/[a-z]/.test(run)) +
    Number(/[A-Z]/.test(run)) +
    Number(/[0-9]/.test(run)) +
    Number(/[+/=]/.test(run))
  return classes >= 3
}

/**
 * 媒体脱敏：base64 只留一行说明（类型 / 原长度），**其余正文一字不删**。认两种形状：
 *   - `data:<mime>;base64,…`（AI SDK 的 user 消息里图片就是这形状）；
 *   - **裸 base64**（≥512 字符、且大小写/数字/符号至少三类）—— 有些 provider 形状是
 *     `{ type: 'image', image: '<base64>' }`（没有 `data:` 前缀），漏掉它等于把图片整张存进库。
 * 只动这两类串：用户写的字、工具结果里的正文都不受影响。
 */
export function redactMediaInText(value: string): string {
  const withoutDataUrls = value.includes('data:')
    ? value.replace(
        /data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+)?;base64,[A-Za-z0-9+/=\s]+/g,
        (_match, mime: string | undefined) =>
          `<${typeof mime === 'string' && mime !== '' ? mime : '二进制'} 媒体已省略>`
      )
    : value
  return withoutDataUrls.replace(BASE64_RUN, (match) =>
    looksLikeBase64(match) ? `<base64 数据已省略（${match.length} 字符）>` : match
  )
}

/**
 * 失败原因里的凭据痕迹（**只在这条路上按全文扫**）：provider 常把请求头 / 请求体回显进错误里，
 * 而失败原因是要落库、要给用户看的那一行。只换"一眼是凭据"的串；**消息正文**不走这项扫描
 * —— 那是用户自己的话，不该被改写（消息那边另做媒体 / 二进制 / 密钥**键名**脱敏，见 messagesOf）。
 */
export function redactSecretsInText(value: string): string {
  let out = redactMediaInText(value)
  // 顺序有讲究：`Bearer sk-…` 这种要先按 Bearer 整段换掉，否则 sk- 规则先把 token 换掉之后
  // Bearer 后面就剩不到 12 个字符，`Bearer <已脱敏>` 那条断言（也是用户的直觉）就落不下来
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer <已脱敏>')
  out = out.replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, 'sk-<已脱敏>')
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '<JWT 已脱敏>')
  out = out.replace(
    /\b(api[_-]?key|apikey|x-api-key|authorization|secret|password|access[_-]?token)\b\s*["'=:\s]+\s*[A-Za-z0-9._~+/=-]{8,}/gi,
    '$1=<已脱敏>'
  )
  return out.replace(/\b[0-9a-f]{32,}\b/gi, '<十六进制串已脱敏>')
}

/** 认得出是"密钥一类"的键名（只在这几个键上动手，不做全文扫描——不碰用户的正文） */
const SECRET_KEY =
  /^(api[_-]?key|apikey|authorization|x-api-key|secret|password|access[_-]?token|bearer)$/i

/** 结构化值 → 脱敏后的 JSON 文本：只换三样（二进制、媒体 base64、密钥类键的值），其余原样 */
export function redactValue(value: unknown): string {
  const seen = new WeakSet<object>()
  const walk = (node: unknown): unknown => {
    // 二进制（Buffer / Uint8Array / ArrayBuffer / DataView）：JSON.stringify 会把它摊成
    // `{"0":137,"1":80,…}` 的怪物（等于把整张图存进库），这里只留字节数
    if (ArrayBuffer.isView(node) || node instanceof ArrayBuffer)
      return `<${node.byteLength} 字节二进制>`
    if (typeof node === 'string') return redactMediaInText(node)
    if (Array.isArray(node)) return node.map(walk)
    if (!isRecord(node)) return node
    if (seen.has(node)) return '<循环引用>'
    seen.add(node)
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(node)) {
      out[key] = SECRET_KEY.test(key) ? '<已脱敏>' : walk(entry)
    }
    return out
  }
  const redacted = walk(value)
  try {
    return JSON.stringify(redacted, null, 2)
  } catch {
    return '<无法序列化>'
  }
}

/** onFinish 事件里我们要的那几个字段（结构化取用，不把框架类型搬进来） */
export interface RequestFinishEvent {
  /** 这一轮的全部 step（每个都带自己那一次调用的 `request`） */
  steps?: unknown
  /** 整轮的 request（有的框架版本只给这个，steps 里没有） */
  request?: { body?: unknown } | null
  model?: { modelId?: string; provider?: string } | null
  response?: { modelId?: string; dbMessages?: ReadonlyArray<{ threadId?: unknown }> } | null
  runId?: string | null
}

/** 请求体可能是对象（兼容层直接给对象）也可能是 JSON 字符串；统一成对象 */
function asBodyObject(body: unknown): Record<string, unknown> | null {
  if (isRecord(body)) return body
  if (typeof body === 'string' && body.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(body)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/** 文本块数组（anthropic 的 system 是多段文本）→ 拼成一段；其余形状不认 */
function blocksToText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value
  if (!Array.isArray(value)) return null
  const texts = value.flatMap((part) =>
    isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
  )
  const joined = texts.join('\n\n').trim()
  return joined === '' ? null : joined
}

/**
 * 系统指令原文。两种 provider 形状都认：
 *   - chat-completions 系（openai-compatible / deepseek）：`body.messages[].role === 'system'`；
 *   - anthropic 系：`body.system`（字符串或文本块数组）。
 * 多条 system（实测一轮里有三条：主指令 / 记忆指令 / 规矩）按顺序拼在一起，中间空行分开。
 */
export function systemTextOf(body: Record<string, unknown> | null): string | null {
  if (body === null) return null
  const parts: string[] = []
  const own = blocksToText(body.system)
  if (own !== null) parts.push(own)
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'system') continue
    const content = blocksToText(message.content)
    if (content !== null) parts.push(content)
  }
  const joined = parts.join('\n\n').trim()
  return joined === '' ? null : joined
}

/** 工具表原文（pretty JSON）；空表 / 认不出 = null（"没带工具"与"没记上"分开） */
export function toolsTextOf(body: Record<string, unknown> | null): string | null {
  if (body === null) return null
  const tools = body.tools
  if (!Array.isArray(tools) || tools.length === 0) return null
  try {
    return JSON.stringify(tools, null, 2)
  } catch {
    return null
  }
}

/** 这一次请求发出去的消息条数（含 system）；没有 messages 数组 = null */
export function messageCountOf(body: Record<string, unknown> | null): number | null {
  if (body === null) return null
  return Array.isArray(body.messages) ? body.messages.length : null
}

/** 工具件数（认不出 = null：不把"没记上"说成 0 件） */
export function toolCountOf(body: Record<string, unknown> | null): number | null {
  if (body === null) return null
  return Array.isArray(body.tools) ? body.tools.length : null
}

/**
 * 消息清单（**发给模型的原文**，逐条角色 + 正文）。
 *
 * 正文口径：字符串 content 原样；结构化（多段 / 工具调用 / 工具结果 / 图片）走
 * `redactValue` 的 pretty JSON —— 与"能看见发出去了什么"一致，且媒体不会把库撑爆。
 * 逐条只做**安全上限**（`REQUEST_MESSAGE_MAX_CHARS`，兜底）；条数与总量的取舍见 `capMessages`。
 */
export function messagesOf(body: Record<string, unknown> | null): RequestMessage[] {
  if (body === null) return []
  const list = Array.isArray(body.messages) ? body.messages : []
  return list.flatMap((raw) => {
    if (!isRecord(raw)) return []
    const role = typeof raw.role === 'string' && raw.role.trim() !== '' ? raw.role : 'unknown'
    const text =
      typeof raw.content === 'string' ? redactMediaInText(raw.content) : redactValue(raw.content)
    const clamped = clampText(text, REQUEST_MESSAGE_MAX_CHARS)
    return [{ role, text: clamped.text, chars: text.length, truncated: clamped.truncated }]
  })
}

/**
 * 条数与总量上限（**命中都要标记**，别让"已截断"漏掉这两处）：
 *   - 条数超了留**最后** `REQUEST_MESSAGES_MAX_COUNT` 条（最近的历史与工具结果在这儿，
 *     真实条数仍记在 `messageCount` 里 → 界面说"前面 N 条未保留"）；
 *   - 总量超了从**最旧的**开始丢，直到落进 `REQUEST_TOTAL_MAX_CHARS`。
 */
function capMessages(messages: readonly RequestMessage[]): {
  messages: RequestMessage[]
  truncated: boolean
} {
  let kept = [...messages]
  let truncated = false
  if (kept.length > REQUEST_MESSAGES_MAX_COUNT) {
    kept = kept.slice(kept.length - REQUEST_MESSAGES_MAX_COUNT)
    truncated = true
  }
  let total = kept.reduce((sum, message) => sum + message.text.length, 0)
  let from = 0
  while (total > REQUEST_TOTAL_MAX_CHARS && from < kept.length - 1) {
    total -= kept[from]?.text.length ?? 0
    from += 1
  }
  if (from > 0) {
    kept = kept.slice(from)
    truncated = true
  }
  return { messages: kept, truncated }
}

/** 从 onFinish 事件的 dbMessages 里取会话 id（Mastra 的 DB 消息带 threadId；取不到 = null） */
function threadIdOf(event: RequestFinishEvent): string | null {
  for (const message of event.response?.dbMessages ?? []) {
    if (typeof message.threadId === 'string' && message.threadId.trim() !== '') {
      return message.threadId
    }
  }
  return null
}

function firstText(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/** 这一轮的每一步各自的请求体（step 0 起；那一步没有 request 就跳过，不编一个） */
function bodiesOf(event: RequestFinishEvent): Array<{ step: number; body: unknown }> {
  const steps = Array.isArray(event.steps) ? event.steps : []
  const found: Array<{ step: number; body: unknown }> = []
  steps.forEach((raw, index) => {
    if (!isRecord(raw)) return
    const request = raw.request
    if (isRecord(request) && request.body !== undefined)
      found.push({ step: index, body: request.body })
  })
  if (found.length > 0) return found
  const whole = event.request
  if (isRecord(whole) && whole.body !== undefined) return [{ step: 0, body: whole.body }]
  return []
}

/** 这一次请求的正文包（截断后的三样 + 标记），落库前算好 */
interface RequestBodyParts {
  system: string | null
  tools: string | null
  messages: RequestMessage[]
  messageCount: number | null
  toolCount: number | null
  truncated: boolean
}

/** 从请求体里抽三样正文（含各自的脱敏、分块前置的截断判定与标记） */
export function bodyPartsOf(body: Record<string, unknown> | null): RequestBodyParts {
  const rawSystem = systemTextOf(body)
  const rawTools = toolsTextOf(body)
  const system = rawSystem === null ? null : clampText(rawSystem, REQUEST_SYSTEM_MAX_CHARS)
  const tools = rawTools === null ? null : clampText(rawTools, REQUEST_TOOLS_MAX_CHARS)
  const capped = capMessages(messagesOf(body))
  return {
    system: system?.text ?? null,
    tools: tools?.text ?? null,
    messages: capped.messages,
    messageCount: messageCountOf(body),
    toolCount: toolCountOf(body),
    // 三样正文的安全上限 + 逐条上限 + **条数 / 总量的丢弃**，全都算作"已截断"：
    // 界面上说"已截断"就一定是真的丢了东西，一句不落的反方向（没丢就不标）也成立
    truncated:
      (system?.truncated ?? false) ||
      (tools?.truncated ?? false) ||
      capped.truncated ||
      capped.messages.some((message) => message.truncated)
  }
}

/** 这一份请求体有没有信息量（三样全空 = 不落噪声行） */
function isEmptyBody(parts: RequestBodyParts): boolean {
  return parts.system === null && parts.tools === null && parts.messages.length === 0
}

/** libsql 行 → 摘要（列名映射只写这一处） */
function summaryOfRow(row: Record<string, unknown>): RequestSnapshotSummary {
  return {
    id: String(row.id),
    runId: text(row.run_id),
    threadId: text(row.thread_id),
    step: countOrNull(row.step),
    status: row.status === 'error' ? 'error' : 'complete',
    error: text(row.error),
    model: String(row.model),
    provider: text(row.provider),
    messageCount: countOrNull(row.message_count),
    toolCount: countOrNull(row.tool_count),
    systemChars: countOrNull(row.system_chars),
    toolsChars: countOrNull(row.tools_chars),
    truncated: row.truncated === 1 || row.truncated === '1' || row.truncated === true,
    createdAt: String(row.created_at)
  }
}

const SUMMARY_COLUMNS = `"id", "run_id", "thread_id", "step", "status", "error", "model", "provider", "message_count", "tool_count", "system_chars", "tools_chars", "truncated", "created_at"`

/**
 * 消息引用（落库形态）：正文**分块**入池（内容去重），行里只留角色 / 分块哈希表 / 长度 / 截断。
 * `chunks` 的旧形状（单哈希 `hash`）也认 —— 早先那版落下的行照旧读得出来（见 parseRefs）。
 */
interface MessageRef {
  role: string
  chunks: string[]
  chars: number
  truncated: boolean
}

/** store 里写/读的列（建表后按这份清单**补列**：早先那版表少了哪列就补哪列） */
const SNAPSHOT_COLUMNS_SPEC: ReadonlyArray<readonly [string, string]> = [
  ['run_id', 'TEXT'],
  ['thread_id', 'TEXT'],
  ['step', 'INTEGER'],
  ['status', 'TEXT'],
  ['error', 'TEXT'],
  ['model', 'TEXT'],
  ['provider', 'TEXT'],
  ['system_hash', 'TEXT'],
  ['tools_hash', 'TEXT'],
  ['message_refs', 'TEXT'],
  ['message_count', 'INTEGER'],
  ['tool_count', 'INTEGER'],
  ['system_chars', 'INTEGER'],
  ['tools_chars', 'INTEGER'],
  ['truncated', 'INTEGER'],
  ['created_at', 'TEXT']
]

function parseRefs(value: unknown): MessageRef[] {
  if (typeof value !== 'string' || value.trim() === '') return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((raw) => {
      if (!isRecord(raw)) return []
      const role = typeof raw.role === 'string' ? raw.role : 'unknown'
      const chunks = Array.isArray(raw.chunks)
        ? raw.chunks.filter((chunk): chunk is string => typeof chunk === 'string' && chunk !== '')
        : typeof raw.hash === 'string' && raw.hash !== ''
          ? [raw.hash]
          : []
      if (chunks.length === 0) return []
      return [
        {
          role,
          chunks,
          chars: countOrNull(raw.chars) ?? 0,
          truncated: raw.truncated === true
        }
      ]
    })
  } catch {
    return []
  }
}

/**
 * 同库的 store：两张表随第一次使用建好（并按清单补列）。
 * 正文（blob）与快照行分开：同一段文本（系统指令 / 工具表 / 消息的某一段）在库中只存一份。
 */
export function createRequestSnapshotStore(client: SqliteClient): RequestSnapshotStore {
  let ready: Promise<void> | null = null

  const ensureTable = (): Promise<void> => {
    ready ??= (async () => {
      await client.execute(
        `CREATE TABLE IF NOT EXISTS "${REQUEST_SNAPSHOT_TABLE}" (
          "id" TEXT PRIMARY KEY,
          "run_id" TEXT,
          "thread_id" TEXT,
          "step" INTEGER,
          "status" TEXT NOT NULL,
          "error" TEXT,
          "model" TEXT NOT NULL,
          "provider" TEXT,
          "system_hash" TEXT,
          "tools_hash" TEXT,
          "message_refs" TEXT,
          "message_count" INTEGER,
          "tool_count" INTEGER,
          "system_chars" INTEGER,
          "tools_chars" INTEGER,
          "truncated" INTEGER NOT NULL DEFAULT 0,
          "created_at" TEXT NOT NULL
        )`
      )
      // 早先那版落下的表（列名不同 / 少列）：**查得到才不补**，其余异常照抛（同 usage.ts 口径）。
      // 没有这一段，老表上每一次 INSERT 都会因"没有这一列"失败 → 快照全线静默不记。
      const existing = await client.execute(`PRAGMA table_info("${REQUEST_SNAPSHOT_TABLE}")`)
      const columns = new Set(existing.rows.map((row) => String((row as { name?: unknown }).name)))
      for (const [name, type] of SNAPSHOT_COLUMNS_SPEC) {
        if (columns.has(name)) continue
        await client.execute(`ALTER TABLE "${REQUEST_SNAPSHOT_TABLE}" ADD COLUMN "${name}" ${type}`)
      }
      await client.execute(
        `CREATE TABLE IF NOT EXISTS "${REQUEST_BLOB_TABLE}" (
          "hash" TEXT PRIMARY KEY,
          "text" TEXT NOT NULL
        )`
      )
      await client.execute(
        `CREATE INDEX IF NOT EXISTS "${REQUEST_SNAPSHOT_TABLE}_thread_id" ON "${REQUEST_SNAPSHOT_TABLE}" ("thread_id")`
      )
    })().catch((error: unknown) => {
      ready = null // 失败不缓存：下一次调用再试一遍
      throw error
    })
    return ready
  }

  /** 一段文本的入池语句（同一段只写一次：INSERT OR IGNORE 让重复写入成为空操作） */
  const blobStatement = (body: string): { sql: string; args: string[] } => ({
    sql: `INSERT OR IGNORE INTO "${REQUEST_BLOB_TABLE}" ("hash", "text") VALUES (?, ?)`,
    args: [hashOf(body), body]
  })

  /**
   * 正文 → 分块哈希表（**内容分块去重**：同一段文本只入池一次）。
   * 为什么分块而不是整段哈希：一条几万字的工具结果与下一步那条只差结尾几个字时，整段哈希去重不了；
   * 分块后未变的部分照旧复用（同一轮内跨步、跨请求都算）。
   * 重建 = 按分块顺序拼回来，**逐字等值**（不动一个字符）。
   *
   * 语句只**攒**不立刻执行（调用方一次 `batch` 发出去）：一条请求可能有几百条消息、上千个分块，
   * 逐条 await 太啰嗦也慢。
   */
  const collectChunks = (
    body: string,
    statements: Array<{ sql: string; args: string[] }>
  ): string[] => {
    const hashes: string[] = []
    for (let at = 0; at < body.length; at += REQUEST_CHUNK_CHARS) {
      const chunk = body.slice(at, at + REQUEST_CHUNK_CHARS)
      statements.push(blobStatement(chunk))
      hashes.push(hashOf(chunk))
    }
    return hashes
  }

  const readBlobs = async (hashes: readonly string[]): Promise<Map<string, string>> => {
    const unique = [...new Set(hashes.filter((hash) => hash !== ''))]
    if (unique.length === 0) return new Map()
    const placeholders = unique.map(() => '?').join(', ')
    const result = await client.execute({
      sql: `SELECT "hash", "text" FROM "${REQUEST_BLOB_TABLE}" WHERE "hash" IN (${placeholders})`,
      args: unique
    })
    return new Map(
      result.rows.map((row) => {
        const entry = row as Record<string, unknown>
        return [String(entry.hash), String(entry.text)]
      })
    )
  }

  return {
    ensureTable,
    async insert(snapshot) {
      await ensureTable()
      const statements: Array<{ sql: string; args: string[] }> = []
      // 系统指令与工具表**整段**入池（同一份内容只存一行）；消息正文按 4 KiB 分块入池
      const systemHash = snapshot.system === null ? null : hashOf(snapshot.system)
      if (snapshot.system !== null) statements.push(blobStatement(snapshot.system))
      const toolsHash = snapshot.tools === null ? null : hashOf(snapshot.tools)
      if (snapshot.tools !== null) statements.push(blobStatement(snapshot.tools))
      const refs: MessageRef[] = snapshot.messages.map((message) => ({
        role: message.role,
        chunks: collectChunks(message.text, statements),
        chars: message.chars,
        truncated: message.truncated
      }))
      // 正文一次 batch 发出去（几百条消息上千个分块也不逐条 await）；
      // 形状兜底：`usageSqlClient` 只保证 `execute`，没有 `batch` 就退化成逐条写 —— 绝不静默丢账
      if (statements.length > 0) {
        if (typeof client.batch === 'function') await client.batch(statements, 'write')
        else for (const statement of statements) await client.execute(statement)
      }
      await client.execute({
        sql: `INSERT OR REPLACE INTO "${REQUEST_SNAPSHOT_TABLE}"
          ("id", "run_id", "thread_id", "step", "status", "error", "model", "provider", "system_hash", "tools_hash", "message_refs", "message_count", "tool_count", "system_chars", "tools_chars", "truncated", "created_at")
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          snapshot.id,
          snapshot.runId,
          snapshot.threadId,
          snapshot.step,
          snapshot.status,
          snapshot.error,
          snapshot.model,
          snapshot.provider,
          systemHash,
          toolsHash,
          JSON.stringify(refs),
          snapshot.messageCount,
          snapshot.toolCount,
          snapshot.system === null ? null : snapshot.system.length,
          snapshot.tools === null ? null : snapshot.tools.length,
          snapshot.truncated ? 1 : 0,
          snapshot.createdAt
        ]
      })
    },
    async listByThread(threadId) {
      await ensureTable()
      const result = await client.execute({
        sql: `SELECT ${SUMMARY_COLUMNS}
          FROM "${REQUEST_SNAPSHOT_TABLE}" WHERE "thread_id" = ?
          ORDER BY "created_at" ASC, "step" ASC`,
        args: [threadId]
      })
      return result.rows.map((row) => summaryOfRow(row as Record<string, unknown>))
    },
    async detail(id) {
      await ensureTable()
      const result = await client.execute({
        sql: `SELECT ${SUMMARY_COLUMNS}, "system_hash", "tools_hash", "message_refs"
          FROM "${REQUEST_SNAPSHOT_TABLE}" WHERE "id" = ?`,
        args: [id]
      })
      const row = result.rows[0] as Record<string, unknown> | undefined
      if (row === undefined) return null
      const base = summaryOfRow(row)
      const refs = parseRefs(row.message_refs)
      const blobs = await readBlobs([
        text(row.system_hash) ?? '',
        text(row.tools_hash) ?? '',
        ...refs.flatMap((ref) => ref.chunks)
      ])
      return {
        ...base,
        system: base.systemChars === null ? null : (blobs.get(text(row.system_hash) ?? '') ?? null),
        tools: base.toolsChars === null ? null : (blobs.get(text(row.tools_hash) ?? '') ?? null),
        messages: refs.map((ref) => {
          const parts = ref.chunks.map((chunk) => blobs.get(chunk))
          // 分块缺了一段（正常情况下不会：同一处写入；库被外部动过才会）→ **如实标截断**，
          // 不假装这条消息是完整的
          const complete = parts.every((part) => part !== undefined)
          return {
            role: ref.role,
            text: parts.map((part) => part ?? '').join(''),
            chars: ref.chars,
            truncated: ref.truncated || !complete
          }
        })
      }
    }
  }
}

/**
 * 快照钩子（接在 chatOptions.onFinish 里，与用量记账并排）：
 * 每轮 run 收尾**逐步**落一行（一步 = 一次模型请求）；认不出请求体就不落
 * （宁可不记，也不写一行"什么都没有"的空账）。
 *
 * 旁路：写库失败只记日志（`onError` 可注入，测试用），绝不让对话跟着挂。
 */
export function createRequestSnapshotRecorder(options: {
  store: RequestSnapshotStore
  now?: () => Date
  onError?: (error: unknown) => void
}): (event: RequestFinishEvent) => Promise<void> {
  const now = options.now ?? (() => new Date())

  return async (event) => {
    try {
      const bodies = bodiesOf(event)
      if (bodies.length === 0) return
      const runId = event.runId ?? null
      const threadId = threadIdOf(event)
      const model = firstText(event.model?.modelId, event.response?.modelId) ?? 'unknown'
      const provider = firstText(event.model?.provider) ?? null
      for (const entry of bodies) {
        const parts = bodyPartsOf(asBodyObject(entry.body))
        if (isEmptyBody(parts)) continue
        await options.store.insert({
          id: randomUUID(),
          runId,
          threadId,
          step: entry.step,
          status: 'complete',
          error: null,
          model,
          provider,
          system: parts.system,
          tools: parts.tools,
          messages: parts.messages,
          messageCount: parts.messageCount,
          toolCount: parts.toolCount,
          truncated: parts.truncated,
          createdAt: now().toISOString()
        })
      }
    } catch (error) {
      if (options.onError !== undefined) options.onError(error)
      else console.warn('[kyclaw] 请求快照记账失败（对话不受影响）', error)
    }
  }
}

/**
 * 失败原因的人话：provider / SDK 常把整个错误对象 JSON 塞进 errorText（本机 LM Studio 实测：
 * `{"message":"Engine protocol predict request returned 400: …","name":"Error"}`）。
 * 认得出就取里面的 `message`（**原文解析，不是改写**），认不出原样留着。
 */
export function errorTextOf(raw: string): string {
  const text = raw.trim()
  if (!text.startsWith('{')) return text
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed) && typeof parsed.message === 'string' && parsed.message.trim() !== '') {
      return parsed.message.trim()
    }
  } catch {
    // 不是 JSON：原样
  }
  return text
}

/**
 * 失败请求的记录（用户反馈 015 的"每次模型请求可查"要覆盖失败的那次）：
 * 实测 provider 报错时 `onFinish` **不触发**（没有 step、没有请求体），能落的只有这件事本身 ——
 * 一行 `status='error'` 的账（会话 / run / 原因人话；正文如实留空，不编一份"本该发出去的东西"）。
 *
 * 接线：三个模型调用入口（chat / 审批续跑 / Plan 续跑）各自把自己那条 UI 消息流交给
 * `tapStreamFailures`（流里出错时 `@mastra/ai-sdk` 会补 `{ type: 'error', errorText }`），
 * 并把**这一轮真实的** threadId / runId 一起传进来。
 *
 * 脱敏：错误文本常回显请求头 / 请求体 → 落库前过 `redactSecretsInText`（`sk-…` / Bearer /
 * JWT / `apiKey=…` / 媒体 base64 / 长十六进制），再截断到单段上限。**headers 从不落库**
 * （我们只取 UI 消息流里的这一句人话）。
 */
export function createRequestFailureRecorder(options: {
  store: RequestSnapshotStore
  now?: () => Date
  onError?: (error: unknown) => void
}): (input: {
  threadId: string | null
  runId?: string | null
  model?: string | null
  provider?: string | null
  error: string
}) => Promise<void> {
  const now = options.now ?? (() => new Date())

  return async (input) => {
    try {
      const given = errorTextOf(input.error)
      const message = given === '' ? '请求失败（原因未报）' : given
      const safe = clampText(redactSecretsInText(message), REQUEST_MESSAGE_MAX_CHARS)
      await options.store.insert({
        id: randomUUID(),
        runId: input.runId ?? null,
        threadId: input.threadId,
        step: null,
        status: 'error',
        error: safe.text,
        model: firstText(input.model) ?? 'unknown',
        provider: firstText(input.provider) ?? null,
        system: null,
        tools: null,
        messages: [],
        messageCount: null,
        toolCount: null,
        // 原因本身被截断也照实说（不假装那句人话是完整的）
        truncated: safe.truncated,
        createdAt: now().toISOString()
      })
    } catch (error) {
      if (options.onError !== undefined) options.onError(error)
      else console.warn('[kyclaw] 失败请求记账失败（对话不受影响）', error)
    }
  }
}

/**
 * UI 消息流的失败观察者（用户反馈 015）：provider 报错时 `onFinish` **不触发**（实测：400 那次
 * 没有 step、没有请求体），能同时拿到"这一轮挂了"的地方只有这条流 —— `@mastra/ai-sdk` 出错时
 * 往流里补 `{ type: 'error', errorText }`。
 *
 * **三个模型调用入口共用它**（chat 路由 / ask-user 续跑 / Plan 续跑）：只观察、原样放行，
 * 观察者自身抛错一律吞掉（记账是旁路，不能影响对话）。
 */
export function tapStreamFailures<T extends { type?: unknown; errorText?: unknown }>(
  stream: ReadableStream<T>,
  note: (errorText: string) => void
): ReadableStream<T> {
  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        try {
          if (chunk !== null && typeof chunk === 'object' && chunk.type === 'error') {
            const raw = chunk.errorText
            const message =
              typeof raw === 'string'
                ? raw
                : typeof raw === 'object' &&
                    raw !== null &&
                    typeof (raw as { message?: unknown }).message === 'string'
                  ? String((raw as { message: string }).message)
                  : ''
            note(message.trim() === '' ? '请求失败（原因未报）' : message)
          }
        } catch {
          // 观察者不影响这条流
        }
        controller.enqueue(chunk)
      }
    })
  )
}
