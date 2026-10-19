/**
 * PB-039「goal 模式」的共享契约（服务端 store / HTTP 路由 / 渲染端共读这一份）。
 *
 * 语义照抄 DSH `@deepseek-ai/dsh-goal`（0.2.1-rc.2；行号见
 * `.superpowers/dev-verify/20261019-0.1.6/design/dsh-goal-and-slash-commands-diff.md`）：
 *   - 每会话至多一个当前 goal；未完成时只能 edit/pause/resume/block/clear，complete 才可替换；
 *   - `revision` 单调（CAS：所有变更带 {id, revision}，陈旧即 `GOAL_STALE_REVISION`）；
 *   - **activation（armed/disarmed）不持久化**：进程本地，服务启动 / 会话加载一律 disarmed，
 *     只有 resume 才 armed（`dsh-goal/lib/index.js:94-99,594-596,777-806`）；
 *   - 默认轮上限 256（`:588`）。
 *
 * 与 DSH 的一处适配：DSH 把 goal 当会话事件溯源存在 agent 日志里；kyclaw 存在 libsql
 * （`session_goals` 单行 + revision），因为我们的续跑在客户端 compositor、服务端只做权威状态。
 */
import { z } from './zod'

/** 4 个持久 phase（DSH 同款；中文展示：进行中 / 已暂停 / 已阻塞 / 已完成） */
export const GOAL_PHASES = ['active', 'paused', 'blocked', 'complete'] as const
export const goalPhaseSchema = z.enum(GOAL_PHASES)
export type GoalPhase = z.infer<typeof goalPhaseSchema>

/** activation 不落库（进程本地），API 里只读 */
export const goalActivationSchema = z.enum(['armed', 'disarmed'])
export type GoalActivation = z.infer<typeof goalActivationSchema>

/** `roundsStarted` 上限的默认值（DSH `dsh-goal/lib/index.js:588`） */
export const DEFAULT_MAX_GOAL_ROUNDS = 256

/** 模型工具 block 的连续轮阈值（DSH `tool-goal/lib/index.js:115`） */
export const GOAL_BLOCK_AFTER_CONSECUTIVE_ROUNDS = 3

export const goalIdSchema = z.string().min(1).max(200)
export const goalRevisionSchema = z.number().int().positive()
export const goalThreadIdSchema = z.string().min(1).max(200)

/** CAS 引用：id + revision 必须同时匹配（DSH `dsh-goal/lib/index.js:759-765`） */
export const goalRefSchema = z.strictObject({
  id: goalIdSchema,
  revision: goalRevisionSchema
})
export type GoalRef = z.infer<typeof goalRefSchema>

export const goalBlockedReasonSchema = z.strictObject({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(2000)
})
export type GoalBlockedReason = z.infer<typeof goalBlockedReasonSchema>

/** 客户端视图（GET 回包里的 goal） */
export const goalViewSchema = z.strictObject({
  id: goalIdSchema,
  revision: goalRevisionSchema,
  objective: z.string().min(1).max(4000),
  phase: goalPhaseSchema,
  roundsStarted: z.number().int().nonnegative(),
  maxGoalRounds: z.number().int().positive(),
  blockedReason: goalBlockedReasonSchema.optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative()
})
export type GoalView = z.infer<typeof goalViewSchema>

/** GET `/api/goal` 的回包 */
export const goalStateSchema = z.strictObject({
  goal: goalViewSchema.nullable(),
  activation: goalActivationSchema
})
export type GoalState = z.infer<typeof goalStateSchema>

const scope = z.strictObject({ threadId: goalThreadIdSchema })

/**
 * POST `/api/goal` 的请求（判别联合，严格对象：多字段即 400）。
 * `disarm` 是 kyclaw 适配动作：只改 activation、不动 phase/revision（客户端 abort / 流错误时用）。
 */
export const goalRequestSchema = z.discriminatedUnion('action', [
  scope.extend({
    action: z.literal('create'),
    objective: z.string().min(1).max(4000),
    maxGoalRounds: z.number().int().positive().optional()
  }),
  scope.extend({
    action: z.literal('edit'),
    ref: goalRefSchema,
    objective: z.string().min(1).max(4000).optional(),
    maxGoalRounds: z.number().int().positive().optional()
  }),
  scope.extend({ action: z.literal('pause'), ref: goalRefSchema }),
  scope.extend({ action: z.literal('resume'), ref: goalRefSchema }),
  scope.extend({ action: z.literal('complete'), ref: goalRefSchema }),
  scope.extend({ action: z.literal('clear'), ref: goalRefSchema }),
  scope.extend({ action: z.literal('block'), ref: goalRefSchema, blocked: goalBlockedReasonSchema }),
  scope.extend({ action: z.literal('disarm') })
])
export type GoalRequest = z.infer<typeof goalRequestSchema>

/** 稳定错误码（前端按键判状态；`message` 同时给人话） */
export const GOAL_ERROR_CODES = [
  'GOAL_INVALID_ACTION',
  'GOAL_INVALID_EDIT',
  'GOAL_NOT_FOUND',
  'GOAL_ALREADY_EXISTS',
  'GOAL_STALE_REVISION',
  'GOAL_INVALID_TRANSITION',
  'GOAL_STORAGE_ERROR',
  /** 工具专用：blocked 轮数不到阈值 */
  'GOAL_TOOL_BLOCK_THRESHOLD',
  /** 工具专用：模型不能 resume paused（恢复路径归用户） */
  'GOAL_TOOL_RESUME_PAUSED'
] as const
export type GoalErrorCode = (typeof GOAL_ERROR_CODES)[number]

/** 错误码 → HTTP 状态（工具专用的两个不会出现在 HTTP 路由上） */
export const GOAL_ERROR_STATUS: Readonly<Record<GoalErrorCode, 400 | 404 | 409 | 500>> = {
  GOAL_INVALID_ACTION: 400,
  GOAL_INVALID_EDIT: 400,
  GOAL_NOT_FOUND: 404,
  GOAL_ALREADY_EXISTS: 409,
  GOAL_STALE_REVISION: 409,
  GOAL_INVALID_TRANSITION: 409,
  GOAL_STORAGE_ERROR: 500,
  GOAL_TOOL_BLOCK_THRESHOLD: 409,
  GOAL_TOOL_RESUME_PAUSED: 409
}

/** 错误码 → 用户可读中文（HTTP 回包与工具输出共用；不暴露内部 id/revision） */
export const GOAL_ERROR_TEXT: Readonly<Record<GoalErrorCode, string>> = {
  GOAL_INVALID_ACTION: '这个 goal 动作不认识（或请求字段不合法），请检查后重试。',
  GOAL_INVALID_EDIT: '编辑 goal 至少要给一个要改的字段（objective 或 maxGoalRounds）。',
  GOAL_NOT_FOUND: '当前会话还没有 goal；先用 /goal <目标> 建一个。',
  GOAL_ALREADY_EXISTS: '这个会话已有一个未完成的 goal；先完成或清除它，才能新建。',
  GOAL_STALE_REVISION: '这个 goal 在别处被改过（revision 不一致），请刷新后再试。',
  GOAL_INVALID_TRANSITION: '当前状态不允许这个操作（例如已激活又恢复、或暂停一个非进行中的 goal）。',
  GOAL_STORAGE_ERROR: 'goal 状态读写失败（存储异常），请重试；持续失败请重启应用。',
  GOAL_TOOL_BLOCK_THRESHOLD: `连续轮数还不够，暂时不能标记为阻塞（至少 ${GOAL_BLOCK_AFTER_CONSECUTIVE_ROUNDS} 轮）。`,
  GOAL_TOOL_RESUME_PAUSED: '模型不能恢复已暂停的 goal —— 恢复要由用户在界面上确认。'
}

/** 服务端动作（与 HTTP `action` 同名字，`disarm` 也在内） */
export type GoalAction =
  | 'create'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'clear'
  | 'block'
  | 'disarm'

/** `phase` → 中文（前端展示与 `/goal` 输出共用） */
export const GOAL_PHASE_LABEL: Readonly<Record<GoalPhase, string>> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  complete: '已完成'
}
