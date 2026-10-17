/**
 * 交付卡（deliver_file 的工具结果）的**数据面**，纯逻辑；组件在 DeliverableCard.tsx
 * （单独成模块的理由与 tool-part.ts 相同：组件文件只导出组件）。
 *
 * 模型调 deliver_file 之后，工具的结构化结果经 AI SDK 的 tool part 到渲染端；历史回灌
 * （message-map 把存储里的 result 原样塞进 `output`）走的是同一个字段。这里做**防御式**解析：
 * 不是这个工具 / 还没结果 / 字段形状不对，一律回 null —— 调用方回落成普通工具行，
 * 一条脏数据不该把消息列带崩（与 message-map 的纪律一致）。
 *
 * 0.1.3 / 014：交付卡不再画在它自己的 part 位置（那会把卡嵌进中间思考 / 工具段，
 * 而且「deliver 恰好是最后一个工具调用」才落到末尾）。这里另给**整轮汇总**的取数：
 * 一轮 = 一段连续的助手消息（审批 / ask-user / 计划续跑会追加新的助手消息），
 * 交付物收在该轮**最后一条助手消息**的末尾统一渲染；同路径多次交付只留最后一份。
 */
import type { UIMessage } from 'ai'
import { isToolPart, toToolCardPart, type ToolCardPart } from './parts/tool-part'

/** 交付工具名（工具卡接管渲染的唯一判据） */
export const DELIVER_TOOL = 'deliver_file'

export interface Deliverable {
  /** 工作区相对路径（正斜杠）：预览标签的键，也是 workbench:reveal 的入参 */
  path: string
  /** 文件名（卡片主文案） */
  name: string
  /** 字节数（卡片副行；字段缺失按 0，不猜） */
  size: number
  /** 有就带（认得出扩展名时工具才给） */
  mimeType?: string
  /** 模型给的交付说明（有才显示） */
  note?: string
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 这个 part 是不是"已经交付完成的文件"；不是就回 null（调用方按普通工具行渲染） */
export function deliverableOf(tool: ToolCardPart): Deliverable | null {
  if (tool.toolName !== DELIVER_TOOL) return null
  if (tool.state !== 'output-available') return null
  if (typeof tool.output !== 'object' || tool.output === null) return null

  const record = tool.output as Record<string, unknown>
  const path = textOf(record.path)
  const name = textOf(record.name)
  if (path === null || name === null) return null

  const size = record.size
  const mimeType = textOf(record.mimeType)
  const note = textOf(record.note)
  return {
    path,
    name,
    size: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0,
    ...(mimeType === null ? {} : { mimeType }),
    ...(note === null ? {} : { note })
  }
}

/** 一条助手消息自己的交付物（独立渲染 Message 时用；轮次汇总见 deliverablesByTurnTail） */
export function deliverablesOfMessage(message: UIMessage): Deliverable[] {
  return collectDeliverables([message])
}

/**
 * 整轮汇总的交付物：返回值与 `messages` 逐项对齐，**只有每段连续助手消息的最后一条**拿到
 * 聚合结果，其余（含用户消息）都是空数组。
 *
 * 为什么按"连续助手消息"分轮：审批续跑 / ask-user 续跑 / 计划续跑都会在客户端追加一条新的
 * 助手消息（`sendMessage(undefined)`），它们与上一条之间没有用户消息 —— 视觉上仍是同一轮，
 * 交付物应该收在这一轮真正结束的地方。用户消息是轮次边界；历史回灌走同一份消息数组，
 * 所以回读后的聚合位置与实时流一致。
 *
 * 去重按**真实工具调用身份**（`toolCallId`），不按相对 path：
 *   - 同一个调用在流式里更新（输出字段变化）→ 同一张卡取最新；
 *   - 两个独立调用即使交付同一个相对路径（多工作区同名）→ **两张卡都保留**；
 *   - 没有 toolCallId 的脏数据回落到"消息 id + part 下标"，同样不误合并。
 * 这样不为去重去改后端协议，也不会在多工作区回退时把一次交付从 UI 上抹掉。
 */
export function deliverablesByTurnTail(messages: readonly UIMessage[]): Deliverable[][] {
  const result: Deliverable[][] = messages.map(() => [])
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index].role !== 'assistant') continue
    let end = index
    while (end + 1 < messages.length && messages[end + 1].role === 'assistant') end += 1
    result[end] = collectDeliverables(messages, index, end)
    index = end
  }
  return result
}

/** 工具 part 的真实调用 id（认不出回 null；不拿 path 当身份） */
function toolCallIdOf(part: UIMessage['parts'][number]): string | null {
  const value = (part as { toolCallId?: unknown }).toolCallId
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * 把 `[start, end]` 这几条消息里的交付物按 part 顺序收成一组。
 * 同一个 toolCallId 更新时原地取最新；不同调用（即使 path 相同）各占一张卡。
 */
function collectDeliverables(
  messages: readonly UIMessage[],
  start = 0,
  end = messages.length - 1
): Deliverable[] {
  const cards: Deliverable[] = []
  const indexByCall = new Map<string, number>()
  for (let cursor = start; cursor <= end; cursor += 1) {
    const parts = messages[cursor].parts
    for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
      const part = parts[partIndex]
      if (!isToolPart(part)) continue
      const tool = toToolCardPart(part)
      if (tool === null) continue
      const card = deliverableOf(tool)
      if (card === null) continue
      const callId = toolCallIdOf(part) ?? `${messages[cursor].id}:${partIndex}`
      const existing = indexByCall.get(callId)
      if (existing === undefined) {
        indexByCall.set(callId, cards.length)
        cards.push(card)
      } else {
        cards[existing] = card
      }
    }
  }
  return cards
}
