/**
 * 消息展示上下文（0.1.3 / 006 + 008）：**发送时挂进用户消息 metadata 的一份旁注**，
 * 以及气泡照它来决定"藏哪一段、画哪几个图标项、显示什么时间"。
 *
 * ## 要解决什么
 *
 * 用户通过「选文件 / 摘选 / ＋ 上传 / 拖拽」加过上下文之后，发送出去的正文里被塞进了
 * `【附件】…` / `【引用】文件：…` 这一类追加段（模型读的就是这份原文，口径见 composer-attachments）。
 * 气泡把整份原文原样画出来，用户看到的就是一大段机器口味的块。006 的口径是：
 *   - 追加段从气泡正文里**藏起来**，文件 / 摘选改用**图标项**排在气泡**下方**；
 *   - **只改展示**：发给模型的正文与 file part 一个字节都不动（metadata 只是随消息带的一份旁注）。
 *
 * ## 口径（每一条都对应一处实现）
 *
 * 1. **metadata 有版本、严格校验**：`kyclawContext: { v: 1, entries: [...] }`。形状 schema 在
 *    `@shared/message-context`（写侧 / 读侧共用一份）；未知字段、缺字段、版本不认识、超长字符串、
 *    整份超体量预算 = 整块不采信，坏数据只可能退化成"按原文显示"，不会吃掉用户内容。
 * 2. **不复制大段正文**：每个追加段只记 `length` + 头尾各 ≤48 字的**摘录**（`head` / `tail`，
 *    同步一阶的门槛）+ SHA-256（`sha256`）。摘录最多 48 字/段 —— **≤48 字的短段等于整段原样留档**
 *    （它本来就只有这么长）；大段内容（PDF 抽取文本上限 6.4 万字符/份、文本内联 16KB）不会被整段复制。
 * 3. **验过才藏（138 裁决）**：隐藏的充分必要条件是**异步 SHA-256 复核通过**。
 *    - 渲染的那一刻是**pending**：一律按原文显示（不接受"先藏后验"）；
 *    - effect 里算完摘要、全部对得上才切到"藏"；
 *    - reject / 抛错 / 超时 / 平台没有 `crypto.subtle` → 保持原文（`verifySegmentDigests` 回 false）。
 *    同步一阶（段长 + 头尾摘录 + 分隔符）只是"值不值得去算摘要"的粗筛，**不单独授权隐藏**。
 * 4. **身份按内容、不按 message.id**：一次核验的身份是**那批材料本身**（段 + 摘要，见
 *    `sameVerificationMaterial` 的逐字比对）。同一条消息被编辑成别的文字（id 不变）、或旧材料的
 *    异步结果晚回来，都比不上 —— 状态回到 pending、结果不写进新材料（`Message.tsx` 的 alive 守卫）。
 *    已通过的材料进一份小缓存（`verifiedVerdictOf` / `rememberVerifiedSeal`）：检索键是定长指纹
 *    （摘要 + 长度，**不含正文**），命中后仍逐字比对正文，**只缓存通过**、且**内存有界**
 *    （单条 >64K 字符不缓存；总量 >256K 字符 / 超过 32 条按插入顺序逐出）。
 * 5. **不误吃手写标记**：没有这份 metadata（用户自己手打 `【附件】…`、旧消息、历史脏数据）一律
 *    原样显示；metadata 存在但任一段对不上（编辑过、截断过、存储被动过）同样整条回退原文。
 * 6. **时间（008）**：`kyclawSentAt`（**自有键**，见 `@shared/message-context` 的说明）写发送时刻，
 *    `createdAt` 只是惯例槽 + 历史记录时间的兜底；`readSentAt` 回 `{ at, exact }`，
 *    `sentAtLabel` 对"记录时间"那份加一句限定（不宣称精确发送）。
 *
 * 摘录、摘要这套"精确核验"的取舍写在 `walkAppends`：全有或全无（一条不符 = 整条消息按原文显示），
 * 免得出现"一半藏一半露"的自相矛盾画面。
 */
import {
  appendSegmentOf,
  BLOCK_JOIN,
  formatSentAt,
  MESSAGE_CONTEXT_VERSION,
  messageContextFits,
  readMessageContext,
  SEGMENT_EXCERPT_CHARS,
  type ContextEntry,
  type MessageContext,
  type SentAtSource
} from '@shared/message-context'

export {
  appendSegmentOf,
  CONTEXT_NAME_MAX_CHARS,
  CONTEXT_SOURCE_MAX_CHARS,
  formatSentAt,
  MESSAGE_CONTEXT_KEY,
  MESSAGE_CONTEXT_MAX_BYTES,
  MESSAGE_CONTEXT_VERSION,
  messageContextFits,
  readMessageContext,
  readSentAt,
  SENT_AT_KEY
} from '@shared/message-context'
export type {
  AppendSegment,
  ContextEntry,
  MessageContext,
  SentAtSource
} from '@shared/message-context'

/** 供测试与展示侧引用（口径写在 shared 那一份） */
export { SEGMENT_EXCERPT_CHARS, BLOCK_JOIN }

/** 摘要复核的默认超时：到点按"没通过"处理（保留原文）。几十 MB 的抽取文本也够用 */
export const DIGEST_VERIFY_TIMEOUT_MS = 8_000

/**
 * 平台能力的 SHA-256（hex）：`crypto.subtle.digest`（Chromium file:// / localhost 与 Node ≥ 18
 * 都把它当可信上下文，渲染端与测试环境都有）。**不自己造弱 hash** —— 平台没有、或算不出来
 * （接口抛错），一律回 null：调用方按"没有摘要"处理（不藏，显示原文），绝不因为摘要缺席而卡住发送。
 */
export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) return null
  try {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  } catch {
    return null
  }
}

/**
 * 发送前的**盖章**入口：按各段的边界从组装好的正文里切出追加段，算 SHA-256 填进 metadata
 * （异步，发送路径本来就是异步的）。切不出来（边界对不上 = 我们自己算错了）就保持 null ——
 * 展示侧不藏，绝不会误吃正文。平台没有 subtle 时同样是 null（这些段不藏）。
 */
export async function sealSegmentDigests(
  text: string,
  context: MessageContext
): Promise<MessageContext> {
  const entries: ContextEntry[] = []
  // 从尾往前切：追加段一定在正文末尾，顺序与 entries 一致（见 composer-attachments 的组装）
  let rest = text
  const digests = new Map<number, string | null>()
  for (let index = context.entries.length - 1; index >= 0; index -= 1) {
    const append = context.entries[index].append
    if (append === undefined) continue
    if (rest.length < append.length + append.join) return context
    const segment = rest.slice(rest.length - append.length)
    digests.set(index, await sha256Hex(segment))
    rest = rest.slice(0, rest.length - append.length)
    if (append.join === 0) {
      if (rest !== '') return context
    } else {
      if (!rest.endsWith(BLOCK_JOIN)) return context
      rest = rest.slice(0, -BLOCK_JOIN.length)
    }
  }
  for (const [index, entry] of context.entries.entries()) {
    if (entry.append === undefined) {
      entries.push(entry)
      continue
    }
    entries.push({ ...entry, append: { ...entry.append, sha256: digests.get(index) ?? null } })
  }
  return { v: MESSAGE_CONTEXT_VERSION, entries }
}

/** 发送时挂到用户消息上的一整份 metadata（时间 + 展示上下文） */
export interface UserMessageMetadata {
  /**
   * 惯例槽（AI SDK / Mastra 都认识这一格）。**刻意只当惯例与历史记录时间的兜底**：
   * Mastra 的 v5 UI 消息适配路径会把它从 content.metadata 里剔掉（带 file part 的消息正走那条路），
   * 精确发送时刻一律看下面的自有键。
   */
  createdAt: string
  /** **我们自己的发送时刻**（008 复核）：不参与任何适配器识别，原样落库、原样读回 */
  kyclawSentAt: string
  kyclawContext?: MessageContext
}

/**
 * 组一份要挂到用户消息上的 metadata：发送时刻（必给，两个键同值）+ 展示上下文
 * （有追加段才给，并且**先盖章**、再过体量预算；超预算就不挂 —— 一律按原文显示）。
 * **不改正文、不改 file part** —— 这只是随消息带走的一份旁注。
 */
export async function buildUserMessageMetadata(input: {
  at: number
  text: string
  context?: MessageContext | null
}): Promise<UserMessageMetadata> {
  const at = new Date(input.at).toISOString()
  const metadata: UserMessageMetadata = { createdAt: at, kyclawSentAt: at }
  const context = input.context
  if (context === undefined || context === null || context.entries.length === 0) return metadata
  const sealed = await sealSegmentDigests(input.text, context)
  if (!messageContextFits(sealed)) {
    console.warn('[kyclaw] 展示上下文超过体量上限，这条消息按原文显示')
    return metadata
  }
  metadata.kyclawContext = sealed
  return metadata
}

/** 气泡里那行发送时间文案：精确发送时刻就是本地时间；记录时间加一句限定（不冒充精确） */
export function sentAtLabel(source: SentAtSource): string {
  const label = formatSentAt(source.at)
  return source.exact ? label : `${label}（记录时间）`
}

/** 被同步一阶放行、待**异步复核**的那些段（Message.tsx 拿它去算摘要） */
export interface UserMessageDisplay {
  /** 同步一阶算出的**候选**正文（扣掉追加段）；只有复核通过才可以拿去显示 */
  text: string
  /** 同步一阶是否放行（false = 连候选都没有，直接按原文显示） */
  hidden: boolean
  /**
   * **被藏掉的**（= 真被追加进正文的）上下文条目，顺序 = 组装顺序。
   * 注意它不含图片条目（图片不在正文里、也不在气泡下方重复画）—— 气泡下方要画的图标项取它。
   */
  entries: ContextEntry[]
  /** 待复核的材料：段 + 摘要（身份就是这份材料本身，见 sameVerificationMaterial） */
  review: VerificationItem[]
}

/**
 * 按 metadata 把用户消息的展示面算出来（**同步一阶，只算候选**）。
 *
 * 从尾往前逐段核验（追加段一定排在最末，顺序与 entries 一致），每段要同时满足：
 *   - 段长与记录一致；
 *   - 段首 / 段尾与摘录逐字一致（≤48 字的段等于整段逐字比对）；
 *   - 它前面该有的分隔符（`join`）在；
 *   - 有 SHA-256（没有摘要的段不参与隐藏）。
 * 任一条不满足 → **整条消息按原文**（半藏半露比不藏更糟：用户会以为内容丢了）。
 *
 * 注意：**放行 ≠ 可以隐藏** —— 调用方必须再等 `verifySegmentDigests` 通过（138 裁决）。
 */
export function resolveUserDisplay(input: { text: string; metadata: unknown }): UserMessageDisplay {
  const raw: UserMessageDisplay = { text: input.text, hidden: false, entries: [], review: [] }
  const context = readMessageContext(input.metadata)
  if (context === null) return raw
  const walked = walkAppends(input.text, context)
  if (walked === null) return raw
  return {
    text: walked.text,
    hidden: true,
    entries: walked.hidden.map((item) => item.entry),
    review: walked.hidden.map((item) => ({
      segment: item.segment,
      sha256: item.entry.append?.sha256 ?? ''
    }))
  }
}

/** 一段追加段 + 它归属的条目 */
interface HiddenAppend {
  entry: ContextEntry
  segment: string
}

/**
 * 从正文尾部把追加段一段段核验并剥掉；任何一处对不上就回 null（调用方按原文处理）。
 * 「全有或全无」是刻意的：展示上不可能出现"藏了一半"的自相矛盾。
 */
function walkAppends(
  text: string,
  context: MessageContext
): { text: string; hidden: HiddenAppend[] } | null {
  let rest = text
  const hidden: HiddenAppend[] = []
  for (let index = context.entries.length - 1; index >= 0; index -= 1) {
    const entry = context.entries[index]
    const append = entry.append
    if (append === undefined) continue
    if (append.sha256 === null) return null
    if (rest.length < append.length + append.join) return null
    const segment = rest.slice(rest.length - append.length)
    if (!segment.startsWith(append.head) || !segment.endsWith(append.tail)) return null
    rest = rest.slice(0, rest.length - append.length)
    if (append.join === 0) {
      if (rest !== '') return null
    } else {
      if (!rest.endsWith(BLOCK_JOIN)) return null
      rest = rest.slice(0, -BLOCK_JOIN.length)
    }
    hidden.unshift({ entry, segment })
  }
  if (hidden.length === 0) return null
  return { text: rest, hidden }
}

/** 摘要复核的可调项（超时 / 摘要实现；后者只给测试注入，生产一律走平台 sha256Hex） */
export interface VerifySegmentOptions {
  /** 超时（毫秒）：到点按"没通过"处理（保留原文）。默认 `DIGEST_VERIFY_TIMEOUT_MS` */
  timeoutMs?: number
  /** 摘要实现（测试注入；缺省 = `sha256Hex`） */
  digest?: (text: string) => Promise<string | null>
}

/**
 * 异步复核（第二级、碰撞安全）：把同步一阶放行的每一段真拿 SHA-256 再算一遍。
 * 全对回 true；任何一段对不上、摘要算不出来（平台没有 subtle / 抛错）、或**超时**回 false ——
 * 调用方据此**保持原文**（138 裁决：验过才藏，不许先藏后验）。
 */
export function verifySegmentDigests(
  review: VerificationMaterial,
  options: VerifySegmentOptions = {}
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DIGEST_VERIFY_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
  })
  return Promise.race([verifyAll(review, options), timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

async function verifyAll(
  review: VerificationMaterial,
  options: VerifySegmentOptions
): Promise<boolean> {
  const digest = options.digest ?? sha256Hex
  for (const item of review) {
    let computed: string | null
    try {
      computed = await digest(item.segment)
    } catch {
      // 摘要接口抛错（平台抽风 / 注入的假件炸了）：按"没通过"处理 —— 保留原文
      return false
    }
    if (computed === null || computed !== item.sha256) return false
  }
  return true
}

/** 一份待核验材料：一段 + 它的摘要（顺序有意义） */
export interface VerificationItem {
  segment: string
  sha256: string
}

/** 一次核验的材料（`resolveUserDisplay` 的 review 就是这个形状） */
export type VerificationMaterial = readonly VerificationItem[]

/**
 * 材料的**检索指纹**（每段的 `sha256:长度` 按顺序拼；定长、**不含正文**）—— 只当 Map 的键用，
 * 不拿它当身份：真正判断"是不是同一批材料"的是 `sameVerificationMaterial` 的逐字比对。
 *
 * 为什么不把正文拼进键（138 复核）：键里带正文就是拿用户数据当长期缓存（PDF 抽取可达 6.4 万字符/
 * 段），内存不可控；指纹定长有界，而"指纹撞上但内容不同"的场合由逐字比对兜住 —— 命中不了就重新核验。
 */
export function sealKeyOf(review: VerificationMaterial): string {
  return review.map((item) => `${item.sha256}:${item.segment.length}`).join('|')
}

/** 两批材料是不是**同一批**（段与摘要逐字相同；同引用走快路径） */
export function sameVerificationMaterial(
  a: VerificationMaterial,
  b: VerificationMaterial
): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].segment !== b[index].segment || a[index].sha256 !== b[index].sha256) return false
  }
  return true
}

/**
 * 已验证过的材料（指纹 → 段正文）：只缓存**通过**的结论，避免重挂时重复闪一帧原文。
 *
 * **内存有界**（138 复核）：单条材料超过 `VERIFIED_SEAL_MAX_ENTRY_CHARS` 就不缓存；
 * 缓存总量超过 `VERIFIED_SEAL_MAX_TOTAL_CHARS` 或条数超过上限时，按插入顺序逐出最旧的。
 * 沿现有附件限额说明为什么必须自带上限：文本内联 / 摘选 ≤16KB，但 **PDF 抽取文本上限是
 * 64,000 字符/份**（`PDF_TEXT_MAX_CHARS`），一条消息挂多份就可能到几百 KB —— 不能无界缓存。
 */
const verifiedSeals = new Map<string, readonly string[]>()
const VERIFIED_SEAL_CACHE_MAX = 32
const VERIFIED_SEAL_MAX_ENTRY_CHARS = 64 * 1024
const VERIFIED_SEAL_MAX_TOTAL_CHARS = 256 * 1024
/** 缓存里那些段正文的总字符数（逐出时按它减） */
let verifiedSealChars = 0

/**
 * 这批材料是不是**已经复核通过过**：指纹找到候选后还要**逐字比对段正文**（同一条消息被编辑成
 * 别的文字时，指纹一样（摘要与长度没变）而段不同 —— 这一档绝不能命中，否则就是"没验就藏"）。
 * 命中回 true；没有/对不上回 null（调用方照常走 pending → 再验一遍）。
 */
export function verifiedVerdictOf(review: VerificationMaterial): boolean | null {
  if (review.length === 0) return null
  const cached = verifiedSeals.get(sealKeyOf(review))
  if (cached === undefined || cached.length !== review.length) return null
  for (let index = 0; index < review.length; index += 1) {
    if (cached[index] !== review[index].segment) return null
  }
  return true
}

/** 记下"这批材料复核通过"（只记通过、只记有界的：超限不缓存，重挂时再验一遍也不算错） */
export function rememberVerifiedSeal(review: VerificationMaterial): void {
  if (review.length === 0) return
  let chars = 0
  for (const item of review) chars += item.segment.length
  if (chars > VERIFIED_SEAL_MAX_ENTRY_CHARS) return
  const key = sealKeyOf(review)
  if (verifiedSeals.has(key)) return
  while (
    verifiedSeals.size >= VERIFIED_SEAL_CACHE_MAX ||
    verifiedSealChars + chars > VERIFIED_SEAL_MAX_TOTAL_CHARS
  ) {
    const oldestKey = verifiedSeals.keys().next().value
    if (oldestKey === undefined) break
    const evicted = verifiedSeals.get(oldestKey) ?? []
    let evictedChars = 0
    for (const segment of evicted) evictedChars += segment.length
    verifiedSealChars -= evictedChars
    verifiedSeals.delete(oldestKey)
  }
  verifiedSeals.set(
    key,
    review.map((item) => item.segment)
  )
  verifiedSealChars += chars
}

/** 清空已通过缓存（测试用；模块级状态不随 render 重置） */
export function forgetVerifiedSeals(): void {
  verifiedSeals.clear()
  verifiedSealChars = 0
}

/**
 * 编辑重发时的 metadata 沿用（006 的"编辑重发 metadata 一致"）：用户可能只改了自己的字，
 * 后面那几段附件原文一个字没动 —— 那就把它们**按摘要重新认领**（改过的段认领不上 = 不带 metadata，
 * 展示回退成原文，绝不把用户改过的内容当附件藏掉）。
 *
 * 与展示侧同一把尺：全有或全无（有一段认领不上就整份不带），并且重新盖章（摘录 / 长度重算，
 * 值与发送时一致，metadata 自洽）。
 */
export async function carryOverMessageContext(
  metadata: unknown,
  text: string
): Promise<MessageContext | null> {
  const context = readMessageContext(metadata)
  if (context === null) return null
  let rest = text
  const entries = context.entries.map((entry) => ({ ...entry }))
  let claimed = 0
  for (let index = context.entries.length - 1; index >= 0; index -= 1) {
    const append = context.entries[index].append
    if (append === undefined) continue
    claimed += 1
    if (append.sha256 === null) return null
    if (rest.length < append.length + append.join) return null
    const segment = rest.slice(rest.length - append.length)
    if ((await sha256Hex(segment)) !== append.sha256) return null
    rest = rest.slice(0, rest.length - append.length)
    if (append.join === 0) {
      if (rest !== '') return null
    } else {
      if (!rest.endsWith(BLOCK_JOIN)) return null
      rest = rest.slice(0, -BLOCK_JOIN.length)
    }
    entries[index] = {
      ...entries[index],
      append: { ...appendSegmentOf(segment, append.join), sha256: append.sha256 }
    }
  }
  if (claimed === 0) return null
  return { v: MESSAGE_CONTEXT_VERSION, entries }
}
