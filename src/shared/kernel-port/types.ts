/**
 * B2 内核适配层的**最小类型垫片**（DSH `0.2.1-rc.2`）。
 *
 * 背景（可复核）：
 *   - 内核包**没有 `.d.ts`**（Ada B1 取证：306 个 `@deepseek-ai/*` 全树 0 个 `.d.ts`、0 个 sourcemap）；
 *   - 因此这里只覆盖**我们确定会用到的契约**，字段名/语义以 B1.5 真机 POC 与内核 README 为依据，
 *     不假装完整镜像 rc.2；将来内核升级时以 `fixtures/` 的黄金事件做漂移闸门。
 *
 * 依据：
 *   - `.superpowers/dev-verify/20261019-0.2.0/ada/b1-kernel-forensics.md`（事件/session/工具/命令/usage）
 *   - `.superpowers/dev-verify/20261019-0.2.0/bao/poc-kernel-boot.md`（真机 NDJSON 事件流）
 *
 * ⚠️ 本目录**不得 import 任何 `@deepseek-ai/*`**（rc.2 无类型且会把内核实现细节拖进编译期）；
 * renderer 侧同样禁止（见 I1 闸门测试）。
 */

/** 会话事件序号（仅追加日志，单调递增；内核 `SessionSeq`） */
export type SessionSeq = number

/**
 * 表面事件的行内替换（内核 `surfaceOp`）：把 `[startSeq, endSeq]` 这一段（端点含边界）
 * 从"模型可见历史"里替换成当前事件。仅 `assistant/message` 这类可被取代的内容会带。
 */
export interface SurfaceReplace {
  op: 'replace'
  startSeq: SessionSeq
  endSeq: SessionSeq
}

export type SurfaceOp = SurfaceReplace

/** 文本片段（assistant 消息流里的 text 部分） */
export interface TextPart {
  type: 'text'
  text: string
}

/** 工具调用/结果对在消息里的呈现（与我们现有 UI 的 `tool-invocation` 形状同构） */
export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  args: unknown
}

export interface ToolResultPart {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  result: unknown
  /** 工具失败也是结果（内核语义：工具失败不中止轮次） */
  isError?: boolean
}

export type ContentPart = TextPart | ToolCallPart | ToolResultPart

/** 会话里的一条消息（事件里的内容形状；不是渲染端消息） */
export interface SessionMessage {
  id: string
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  parts: ContentPart[]
  createdAt?: number
}

/** 用量读数（内核 token-meter 投影；`exactness` 是本层加的诚实位） */
export type UsageExactness = 'provider' | 'heuristic' | 'unknown'

export interface UsageTokens {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface UsageSnapshot extends UsageTokens {
  /**
   * 精确性：
   *   - `provider`：提供方报了用量（内核 tokenUsage 的可选计量齐全）；
   *   - `heuristic`：内核启发式（固定 4 字符/token，明确会低估 CJK）；
   *   - `unknown`：没有可用读数（UI 显示「—」，不许估算）。
   */
  exactness: UsageExactness
  /** 该读数来自哪次模型尝试/整轮（内核 `deriveTurnTokenUsage` 口径） */
  turn?: number
}

/** 轮次结束原因（只取我们会分支处理的两类） */
export type TurnEndReason =
  | { kind: 'completed' }
  | { kind: 'cancelled'; cause?: string }
  | { kind: 'error'; error: { message: string; code?: string } }

interface EventBase {
  /** 仅追加日志里的序号（`SessionSeq`） */
  seq: SessionSeq
  /** 事件发生时刻（epoch ms；回放 fixture 可缺省） */
  at?: number
}

/** 各类会话事件（subset；字段名照内核 `SessionEvent` 语义） */
export type SessionEvent =
  | (EventBase & { type: 'session/created'; sessionId: string })
  | (EventBase & {
      type: 'user/message'
      message: SessionMessage
    })
  | (EventBase & {
      type: 'assistant/message'
      message: SessionMessage
      /** 流式过程中 / 结束时对本条消息的替换范围（模型可见历史） */
      surfaceOp?: SurfaceOp
    })
  | (EventBase & {
      type: 'tool/call'
      toolCallId: string
      toolName: string
      args: unknown
    })
  | (EventBase & {
      type: 'tool/result'
      toolCallId: string
      toolName: string
      result: unknown
      isError?: boolean
    })
  | (EventBase & {
      type: 'turn/end'
      turn: number
      reason: TurnEndReason
      usage?: UsageSnapshot
    })
  | (EventBase & {
      /** 仅日志、不进模型历史 */
      type: 'assistant/attempt'
      turn: number
      attempt: number
      outcome: 'succeeded' | 'failed' | 'retried' | 'cancelled'
      error?: { message: string; code?: string }
    })

export type SessionEventType = SessionEvent['type']

/** 工具描述（内核 `defineTool` 的可见部分） */
export interface ToolDescriptor {
  name: string
  title?: string
  description: string
}

/** 命令描述（内核 `dsh-commands`：命令由插件拥有、不产生模型消息） */
export interface CommandDescriptor {
  name: string
  aliases?: string[]
  title?: string
  description?: string
  /** 命令声明的附件输入能力（只有 create/edit 类才会声明） */
  acceptsAttachments?: boolean
}

export interface CommandResult {
  ok: boolean
  /**
   * 命令结算不进入模型历史；这里给 UI 呈现用的文本/结构化结果。
   * 失败时 `message` 必须是可读中文（内核侧也是人话）。
   */
  text?: string
  message?: string
}

/** 交互（ask_user / approval）请求与应答；内核里是会话内的请求-应答，不是轮询 */
export interface InteractionRequest {
  requestId: string
  sessionId: string
  kind: 'question' | 'approval'
  /** 工具名（如 ask_user_question / write） */
  toolName: string
  payload: unknown
}

export type InteractionResponse =
  | { requestId: string; kind: 'question'; answers: unknown }
  | { requestId: string; kind: 'approval'; decision: 'allow' | 'deny'; remember?: boolean }

/** goal（内核权威；`phase` 与 DSH 一致） */
export type KernelGoalPhase = 'active' | 'paused' | 'blocked' | 'complete'

export interface KernelGoal {
  id: string
  revision: number
  objective: string
  phase: KernelGoalPhase
  roundsStarted: number
  maxGoalRounds: number
  blockedReason?: { code: string; message: string }
}

export type GoalMutation =
  | { action: 'create'; objective: string; maxGoalRounds?: number }
  | {
      action: 'edit'
      ref: { id: string; revision: number }
      objective?: string
      maxGoalRounds?: number
    }
  | {
      action: 'pause' | 'resume' | 'complete' | 'clear'
      ref: { id: string; revision: number }
    }
  | {
      action: 'block'
      ref: { id: string; revision: number }
      blocked: { code: string; message: string }
    }
