/**
 * PB-039 goal 自动续跑 driver（客户端骨架，默认关闭）。
 *
 * 四条准入**串行判定**（任一成立就不自动发下一轮）：
 *   1) 审批挂起；2) askUser 待答；3) Plan 待批；4) 压缩中。
 * 另加 goal 自身条件：`phase==='active'`、`activation==='armed'`、`roundsStarted < maxGoalRounds`；
 * **发送前复查 revision**：调用方传入刚 GET 到的 revision 与判定用的 goal 比对，不一致放弃本轮。
 *
 * 消息体照抄 DSH `driver/lib/index.js:11-18`；metadata 字段名严格 `{goalId, round, revision}`。
 * 轮尽不在这里 block（由调用方按契约发 `POST block {code:'round-limit'}`）。
 */
import type { GoalRequest, GoalState, GoalView } from '@shared/goal'

/** 默认关闭：等上层入口（轮上限 / blocked 阈值）接好再打开（Lead 口径） */
export const GOAL_DRIVER_ENABLED = false

export interface GoalRoundGateInput {
  /** 测试/上层显式开关；缺省用 GOAL_DRIVER_ENABLED（默认关） */
  enabled?: boolean
  /** 判定用的 goal 快照（调用方刚 GET 到） */
  goal: GoalView | null
  activation: 'armed' | 'disarmed'
  approvalPending: boolean
  askUserPending: boolean
  planPending: boolean
  compacting: boolean
  /** 发送前复查：调用方重新 GET 到的最新 revision；不传 = 不做复查 */
  latestRevision?: number
}

export type GoalRoundSkipReason =
  | 'disabled'
  | 'no-goal'
  | 'not-active'
  | 'not-armed'
  | 'rounds-exhausted'
  | 'approval-pending'
  | 'ask-user-pending'
  | 'plan-pending'
  | 'compacting'
  | 'revision-changed'

export type GoalRoundDecision =
  | { kind: 'skip'; reason: GoalRoundSkipReason }
  | {
      kind: 'send'
      text: string
      metadata: { goalRound: { goalId: string; round: number; revision: number } }
    }

/** 目标快照给模型看的 JSON（字段与契约 §3 一致，不夹带内部字段） */
function objectiveOf(goal: GoalView): string {
  return JSON.stringify({
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    roundsStarted: goal.roundsStarted,
    maxGoalRounds: goal.maxGoalRounds
  })
}

export function planGoalRound(input: GoalRoundGateInput): GoalRoundDecision {
  if (!(input.enabled ?? GOAL_DRIVER_ENABLED)) return { kind: 'skip', reason: 'disabled' }
  if (input.goal === null) return { kind: 'skip', reason: 'no-goal' }
  if (input.goal.phase !== 'active') return { kind: 'skip', reason: 'not-active' }
  if (input.activation !== 'armed') return { kind: 'skip', reason: 'not-armed' }
  if (input.goal.roundsStarted >= input.goal.maxGoalRounds) {
    return { kind: 'skip', reason: 'rounds-exhausted' }
  }
  if (input.approvalPending) return { kind: 'skip', reason: 'approval-pending' }
  if (input.askUserPending) return { kind: 'skip', reason: 'ask-user-pending' }
  if (input.planPending) return { kind: 'skip', reason: 'plan-pending' }
  if (input.compacting) return { kind: 'skip', reason: 'compacting' }
  if (
    input.latestRevision !== undefined &&
    input.latestRevision !== input.goal.revision
  ) {
    return { kind: 'skip', reason: 'revision-changed' }
  }

  const round = input.goal.roundsStarted + 1
  return {
    kind: 'send',
    text:
      `<goal_round>\nObjective: ${objectiveOf(input.goal)}\n` +
      `Round: ${round}/${input.goal.maxGoalRounds}\n\n` +
      'Continue working… （继续推进这个目标；需要用户决策时调用 ask_user；完成时调用 update_goal action=complete）\n</goal_round>',
    metadata: {
      goalRound: { goalId: input.goal.id, round, revision: input.goal.revision }
    }
  }
}

/** driver 需要的网络依赖（注入以便单测；生产用 goal-api 的函数） */
export interface GoalDriverDeps {
  fetchGoal: (threadId: string) => Promise<GoalState>
  postGoal: (request: GoalRequest) => Promise<GoalState>
  /** 只记日志/上报，绝不影响轮次本身 */
  log?: (message: string, error?: unknown) => void
}

/** 同一会话的在途集合：重复调用不重复发（幂等的本地第一道闸） */
const inFlight = new Set<string>()

/**
 * 轮数耗尽 → `POST block {code:'round-limit'}`（Bao 契约文案）。
 * 幂等：先 GET 复查（已非 active / 已不轮尽 / goal 变了 → 不发）；并发/重复调用由 inFlight 挡住。
 * 返回 true = 本次真的发了 block。
 */
export async function blockGoalRoundLimit(
  threadId: string,
  deps: GoalDriverDeps
): Promise<boolean> {
  if (inFlight.has(threadId)) return false
  inFlight.add(threadId)
  try {
    const state = await deps.fetchGoal(threadId)
    const goal = state.goal
    if (goal === null || goal.phase !== 'active') return false
    if (goal.roundsStarted < goal.maxGoalRounds) return false
    await deps.postGoal({
      threadId,
      action: 'block',
      ref: { id: goal.id, revision: goal.revision },
      blocked: {
        code: 'round-limit',
        message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`
      }
    })
    return true
  } catch (error) {
    deps.log?.('[goal-driver] block round-limit 失败（不影响本轮）', error)
    return false
  } finally {
    inFlight.delete(threadId)
  }
}

/**
 * 轮末 abort / 流错误 → `POST disarm`（只改 activation，不动 phase/revision）。
 * **永不抛**：失败只记日志；幂等由服务端（disarm 幂等）+ inFlight 双保险。
 */
export async function disarmGoalOnAbort(
  threadId: string,
  deps: GoalDriverDeps
): Promise<void> {
  if (inFlight.has(threadId)) return
  inFlight.add(threadId)
  try {
    await deps.postGoal({ threadId, action: 'disarm' } as GoalRequest)
  } catch (error) {
    deps.log?.('[goal-driver] disarm 失败（忽略）', error)
  } finally {
    inFlight.delete(threadId)
  }
}
