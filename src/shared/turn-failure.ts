/**
 * PB-037：失败轮 metadata（`content.metadata.turnFailure`，PB-034 投影）的**共享解析**。
 *
 * 来源：`src/main/threads/thread-projection.ts` 只写这三个字段：
 *   `{ turn: number, kind: 'error'|'aborted'|'interrupted', code?: string, message?: string }`
 * renderer 只做防御式读取：kind 不在白名单 / turn 不是非负整数 → `null`（**不猜**、不渲染）。
 * 本文件是纯数据形状，不依赖 React/UI；`message-map` 与 renderer 都从这里读，避免两份校验漂移。
 */

export const TURN_FAILURE_KINDS = ['error', 'aborted', 'interrupted'] as const

export type TurnFailureKind = (typeof TURN_FAILURE_KINDS)[number]

export interface TurnFailure {
  turn: number
  kind: TurnFailureKind
  code?: string
  message?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 校验并收窄 `turnFailure` 对象；坏形状一律 null（缺失字段不渲染，不猜来源） */
export function parseTurnFailure(value: unknown): TurnFailure | null {
  if (!isRecord(value)) return null
  const kind = value.kind
  if (typeof kind !== 'string' || !(TURN_FAILURE_KINDS as readonly string[]).includes(kind)) {
    return null
  }
  const turn = value.turn
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) return null
  const code = stringOf(value.code)
  const message = stringOf(value.message)
  return {
    turn,
    kind: kind as TurnFailureKind,
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message })
  }
}

/** 从消息 metadata 读 `turnFailure`（UIMessage.metadata 与存储 content.metadata 同形） */
export function turnFailureFromMetadata(metadata: unknown): TurnFailure | null {
  if (!isRecord(metadata)) return null
  return parseTurnFailure(metadata.turnFailure)
}
