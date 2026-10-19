/**
 * PB-035（B′）· 失败轮的「保留内容再试」标记。
 *
 * 背景（取证见 `.superpowers/dev-verify/20261019-0.1.6/research/pb035-retry-semantics.md`）：
 * 原来的「重试」= 服务端 `truncate`（删掉失败那条助手消息及其之后）+ AI SDK `regenerate()`
 * （客户端丢掉最后一条助手回复）——用户看到「之前的东西都没了」。
 *
 * B′ 的做法：**不清空、不 truncate、不 regenerate**，改为**新起一轮**：
 * 发一条带本标记的 user 消息（对用户隐藏），让新回复作为**新消息追加**在旧内容之后。
 *
 * 两个约束：
 *   1. 这条 user 消息**不带** `metadata.goalRound` —— 否则 goal 准入会拿已消费的 revision
 *      再准入一次，直接 409（`mastra/index.ts` 的 admitRound CAS）。
 *   2. 它必须在 UI 上隐藏，否则用户会看到凭空多出来的一句「继续」气泡
 *      （渲染端过滤见 `MessageList.tsx`）。
 */

/** 标记键：放在 user 消息的 `metadata` 上（我们自己写的键，不复用宿主字段） */
export const RETRY_KEEP_METADATA_KEY = 'kyclawRetryKeep'

/**
 * 新起一轮时发给模型的那句话（用户看不见）。
 * 措辞刻意说清"从中断处继续、别重复已完成步骤"，避免模型把整件事再做一遍。
 */
export const RETRY_KEEP_PROMPT =
  '上一次执行中断了。请从中断的地方继续完成这个任务；已经完成的步骤不要重做，' +
  '需要的话先看一遍上文已有的进展，再接着往下做。'

/** 消息形状：只取判定需要的那几个字段（UIMessage 与测试夹具都能传） */
interface MessageLike {
  role?: unknown
  metadata?: unknown
  /** UIMessage.parts；测试夹具也可以直接给（判定只看 type/text，不关心具体 part 类型） */
  parts?: unknown
}

/** 这条 user 消息是不是「保留内容再试」发出去的隐藏标记消息 */
export function isRetryKeepMessage(message: MessageLike): boolean {
  if (message.role !== 'user') return false
  const metadata = message.metadata
  if (typeof metadata !== 'object' || metadata === null) return false
  return (metadata as Record<string, unknown>)[RETRY_KEEP_METADATA_KEY] === true
}

/** 一条 part 是否算「用户能看见的产出」 */
function isVisiblePart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return false
  const record = part as Record<string, unknown>
  const type = record.type
  if (typeof type !== 'string') return false
  if (type === 'text') {
    const text = record.text
    return typeof text === 'string' && text.trim() !== ''
  }
  // 工具调用/结果（ai-sdk 的 tool-* part）：只要出现过就算产出一条记录
  return type.startsWith('tool-')
}

/**
 * 失败轮里「已产生、用户看得见」的记录数：
 * 非空正文 part + 工具调用 part 各算一条。0 = 什么都没产出来（此时不该给分叉按钮）。
 */
export function preservedRecordsOf(message: MessageLike | undefined): number {
  if (message === undefined) return 0
  const parts = (message as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return 0
  let count = 0
  for (const part of parts) {
    if (isVisiblePart(part)) count += 1
  }
  return count
}
