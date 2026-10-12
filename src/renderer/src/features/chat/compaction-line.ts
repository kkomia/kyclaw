/**
 * round 59 · 压缩分界线（对话流里的「上下文已压缩」那一条）的两件纯逻辑，单独一处：
 *
 * 1. `formatCompactTokens`：标签里的 token 数（数字格式的**单一出处**）。
 *    百万级不说人话，一律折成 k：≥100k 取整（527k）、<100k 保留 1 位小数并去尾 `.0`
 *    （53.7k / 8k）；不足 1k 的原样给个数（950）——"0.9k" 这种读法没有意义。
 *
 * 2. `compactionRowIndex`：分界线在消息列里的**位置**（= 对话流里的时间点）。
 *    它不再是"列顶一行"：落在**压缩时刻之后到达的第一条消息之前**（刚压完后面还没有新消息
 *    → 落在列表末尾，贴近输入框；之后新到达的消息排在它下面）；重开会话时按时间重算，
 *    位置不漂移。时间从哪来见下面 `messageCreatedAtOf`；位置规则见下面那个函数的头注。
 */
import type { UIMessage } from 'ai'
import type { ThreadCompaction } from '@shared/threads'

/** token 数的紧凑写法（分界线标签用） */
export function formatCompactTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value >= 100_000) return `${Math.round(value / 1000)}k`
  const kilo = (value / 1000).toFixed(1)
  return `${kilo.endsWith('.0') ? kilo.slice(0, -2) : kilo}k`
}

/**
 * 一条消息的时间（epoch ms）：回灌时挂在 `metadata.createdAt` 上（message-map 取该消息各 part
 * 的 `createdAt` 最大值）。本轮新发的消息不会有这个字段（客户端消息不落它）→ 未知 = null。
 */
export function messageCreatedAtOf(message: UIMessage): number | null {
  const metadata = message.metadata
  if (typeof metadata !== 'object' || metadata === null) return null
  const createdAt = (metadata as { createdAt?: unknown }).createdAt
  return typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : null
}

/**
 * 分界线插在**第几条消息之前**（返回值 ∈ [0, messages.length]；= 长度表示落在列表末尾）。
 * 没有压缩记录 = 不画（null）。
 *
 * 时间轴只有一种权威顺序（存储回灌在前、本轮新发在后），所以扫一遍就够：
 *   - 某条消息**已知时间且 ≥ 压缩时刻** → 它是"压缩之后到达的第一条"，分界线插它之前；
 *   - 某条消息**时间未知** → 同样插它之前：按"**不早于压缩**"处理。
 *
 * 为什么未知一律当"不早于压缩"（round 59 修正，之前写成"继承前一条已知时间"，方向是反的）：
 *   1. 会话重开后，**本轮新发的**消息天然没有时间戳，而回灌来的历史大多**早于**压缩时刻
 *      （压缩保留了它们）——继承前一条已知时间会把新消息判成"压缩前"，分界线一路漂到列表
 *      末尾、新消息永远排在分界线上面；
 *   2. 手动压缩时列表里已经有本轮新发的消息，它们确实存在于压缩之前（会被算进保留窗口）——
 *      这一段由渲染端在压缩完成那一刻**冻结锚点**处理（见 ChatPage 的 compactionAnchor），
 *      与这里的规则各管一段：锚点在手时按锚点定位，不在手时（重开会话）才走时间戳规则。
 *
 * 已知近似（登记在案）：极端数据里也可能出现"存储消息的 parts 一个都不带时间戳"——它和本轮
 * 新发的消息在数据上无法区分，同样按"不早于压缩"算（宁可把分界线放前面一点，也不让它漂到
 * 末尾把新消息全盖在上面）。
 *
 * 边界：
 *   - 记录时间解析不出来（脏数据）：不猜位置，落到末尾；
 *   - 全部消息都早于压缩时刻（刚压完那种）→ 末尾；
 *   - 记录早于全部已知消息 → 0（最前）。
 */
export function compactionRowIndex(
  messages: readonly UIMessage[],
  compaction: ThreadCompaction | null
): number | null {
  if (compaction === null) return null
  const at = Date.parse(compaction.createdAt)
  if (Number.isNaN(at)) return messages.length

  for (let index = 0; index < messages.length; index += 1) {
    const known = messageCreatedAtOf(messages[index])
    if (known === null || known >= at) return index
  }
  return messages.length
}
