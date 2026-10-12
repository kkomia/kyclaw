/**
 * 交付卡（deliver_file 的工具结果）的**数据面**，纯逻辑；组件在 DeliverableCard.tsx
 * （单独成模块的理由与 tool-part.ts 相同：组件文件只导出组件）。
 *
 * 模型调 deliver_file 之后，工具的结构化结果经 AI SDK 的 tool part 到渲染端；历史回灌
 * （message-map 把存储里的 result 原样塞进 `output`）走的是同一个字段。这里做**防御式**解析：
 * 不是这个工具 / 还没结果 / 字段形状不对，一律回 null —— 调用方回落成普通工具行，
 * 一条脏数据不该把消息列带崩（与 message-map 的纪律一致）。
 */
import type { ToolCardPart } from './parts/tool-part'

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
