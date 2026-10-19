/**
 * 0.2.0 B3.3：renderer ↔ main「内核命令平面」的 UI 契约（renderer 不 import `@deepseek-ai/*`）。
 *
 * 边界（ADR-1）：adapter 在 main，内核 token/cookie 不下发 renderer；renderer 继续吃本地 HTTP/SSE。
 * 这里只描述**已经投影成我方展示形状**的数据：
 *   - `KernelGoalProjection` = GoalDock / GoalCommandCard 的六行（Status/Blocker/Objective/Rounds/
 *     Activation/Commands），值由 main 从内核 goal 快照只读投影，renderer 不解释内核对象；
 *   - `KernelCommandFrame` = 命令执行过程的 SSE 帧：`command/run` → `command/done`，命令**不进**
 *     消息流（DSH 语义：命令不产生模型消息）。
 *
 * 维护口径：与 `src/main/kernel/goal-projection.ts` 的 `GoalDockProjection` 逐字段同形；改一处必须
 * 同步另一处（main 侧单测 + renderer 侧单测各钉一遍，防止契约漂移）。
 */

export const KERNEL_GOAL_ROW_IDS = [
  'status',
  'blocker',
  'objective',
  'rounds',
  'activation',
  'commands'
] as const

export type KernelGoalRowId = (typeof KERNEL_GOAL_ROW_IDS)[number]

export interface KernelGoalRow {
  id: KernelGoalRowId
  label: string
  value: string
  tone: 'normal' | 'warning' | 'muted'
}

export interface KernelGoalRounds {
  started: number
  /** 实际生效的安全阀（= min(16, 内核上限)） */
  limit: number
  kernelLimit: number
  /** UI 唯一该显示的形态：`x/16（内核上限 256）` 或 `x/16` */
  label: string
}

/** 内核 goal 的只读六行投影；`visible:false` = 没有 goal（dock 隐藏） */
export interface KernelGoalProjection {
  visible: boolean
  goalId?: string
  phase?: 'active' | 'paused' | 'blocked' | 'complete'
  rows: KernelGoalRow[]
  rounds?: KernelGoalRounds
  /** 有效下一步命令（带命令名词，如 `goal pause`）；真正执行仍走内核命令平面 */
  commands: readonly string[]
}

/**
 * 内核 plan 投影。**两种合法形态**（Eve verdict R1）：
 *   - `{active:true, pending:false}` —— 空闲时 `/plan` 当场生效；
 *   - `{active:false, pending:true}` —— 有在途 turn 时"下一步生效"。
 * 二者都表示"在规划里"，调用方一律用 `kernelPlanActive()` 判定，禁止只钉一种。
 */
export interface KernelPlanProjection {
  active: boolean
  pending: boolean
}

/** `commands/list` 的一行（内核目录是唯一来源，renderer 不硬编码第二份清单） */
export interface KernelCommandSummary {
  name: string
  description?: string
}

export type KernelCommandResult =
  { kind: 'success'; text?: string } | { kind: 'error'; text: string }

export type KernelCommandFrame =
  | { type: 'command/run'; commandId: string; line: string }
  | {
      type: 'command/done'
      commandId: string
      line: string
      result: KernelCommandResult
      /** 命令执行后重新读到的 goal 六行投影（无 goal → null） */
      goal: KernelGoalProjection | null
      /** 命令执行后重新读到的 plan 投影（flag 关降级路径 → null） */
      plan: KernelPlanProjection | null
    }

/** `GET /api/kernel/projection` 的回包 */
export interface KernelProjectionSnapshot {
  goal: KernelGoalProjection | null
  plan: KernelPlanProjection | null
}
