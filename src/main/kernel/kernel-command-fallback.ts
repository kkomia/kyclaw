/**
 * PB-018（0.2.0 B3.3 renderer 半端）：**flag 关时的 `/goal` 降级实现**（临时模块）。
 *
 * 为什么存在：renderer 删掉了手写解析器与 goal driver（内核命令平面接管），但生产默认仍是
 * `KYCLAW_KERNEL_PORT` 关（PB-020 才把 kernel 变必启）。为了让 flag 关的用户不丢 `/goal`，
 * 由网关在这里用**旧 goal store**（`src/mastra/session-goal.ts`）复刻 0.1.6 语义：
 *   - 解析语法与旧 `goal-command.ts` 逐字一致（控制词必须占满整行；`/goal pause after` = 创建）；
 *   - 执行仍走 `applyGoalRequest`（与旧 `/api/goal` 路由同一条动词语义）；
 *   - 六行投影用**旧 UI 口径**（`x/256`、activation 原样、命令集合按旧按钮可用性）。
 *
 * 删除时机：**PB-020（Step 1b 切引用与 flag）必须删掉本文件**并把 renderer 网关改成 kernel-only。
 * 在那之前它是"flag 关零变化"的兜底，不是第二套真源（写操作仍只经过旧 store）。
 */
import type { GoalActivation, GoalState, GoalView } from '../../shared/goal'
import type {
  KernelCommandResult,
  KernelGoalProjection,
  KernelGoalRow,
  KernelPlanProjection
} from '../../shared/kernel-ui'
import { applyGoalRequest } from '../../mastra/routes/goal'
import { SessionGoalError, type SessionGoalStore } from '../../mastra/session-goal'

export type LegacyGoalCommandAction = 'status' | 'create' | 'edit' | 'pause' | 'resume' | 'clear'

export type LegacyGoalCommandParse =
  | { kind: 'not-goal' }
  | { kind: 'invalid'; message: string }
  | { kind: 'action'; action: LegacyGoalCommandAction; objective?: string }

const USAGE = '用法：/goal [<objective> | clear | edit <objective> | pause | resume]'

/** 是否以 `/goal` 命令名开头（命令名后必须是空白/行尾；`/goalkeeper` 不算） */
export function isLegacyGoalLine(text: string): boolean {
  return /^\/goal(?:\s|$)/.test(text.trimStart())
}

/** 逐字照抄旧 `src/renderer/src/features/chat/goal-command.ts`（PB-018 从 renderer 挪到 main） */
export function parseLegacyGoalCommand(text: string): LegacyGoalCommandParse {
  const trimmed = text.trim()
  if (!isLegacyGoalLine(trimmed)) return { kind: 'not-goal' }
  const rest = trimmed.slice('/goal'.length).trim()
  if (rest === '') return { kind: 'action', action: 'status' }
  if (rest === 'clear') return { kind: 'action', action: 'clear' }
  if (rest === 'pause') return { kind: 'action', action: 'pause' }
  if (rest === 'resume') return { kind: 'action', action: 'resume' }
  if (rest === 'edit') return { kind: 'invalid', message: `缺少新的目标内容。${USAGE}` }
  if (rest.startsWith('edit ')) {
    const objective = rest.slice('edit '.length).trim()
    if (objective === '') return { kind: 'invalid', message: `缺少新的目标内容。${USAGE}` }
    return { kind: 'action', action: 'edit', objective }
  }
  return { kind: 'action', action: 'create', objective: rest }
}

const PHASE_LABEL: Readonly<Record<GoalView['phase'], string>> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  complete: '已完成'
}

/**
 * 旧 GoalDock 的按钮可用性（`GoalDock.tsx` 的 canPause / canResume / edit / clear）：
 * 旧卡片 Commands 行与旧 dock 按钮略有出入（active+disarmed 时卡片还写着 pause），
 * 但按钮才是可点的真值 —— 这里取两者交集，保证投影驱动出来的按钮与旧 UI 一致。
 */
function legacyCommands(goal: GoalView, activation: GoalActivation): string[] {
  if (goal.phase === 'complete') return ['goal clear']
  if (goal.phase === 'active' && activation === 'armed')
    return ['goal pause', 'goal edit', 'goal clear']
  if (goal.phase === 'active') return ['goal resume', 'goal edit', 'goal clear']
  return ['goal resume', 'goal edit', 'goal clear']
}

/** 旧 goal 快照 → 六行投影（flag 关口径：`x/256`，不套 16 轮安全阀） */
export function projectLegacyGoalState(state: GoalState): KernelGoalProjection | null {
  const goal = state.goal
  if (goal === null) return null
  const rows: KernelGoalRow[] = [
    {
      id: 'status',
      label: 'Status',
      value: PHASE_LABEL[goal.phase],
      tone: goal.phase === 'blocked' || goal.phase === 'complete' ? 'warning' : 'normal'
    },
    {
      id: 'blocker',
      label: 'Blocker',
      value:
        goal.blockedReason === undefined
          ? '—'
          : `${goal.blockedReason.code}: ${goal.blockedReason.message}`,
      tone: goal.blockedReason === undefined ? 'muted' : 'warning'
    },
    { id: 'objective', label: 'Objective', value: goal.objective, tone: 'normal' },
    {
      id: 'rounds',
      label: 'Rounds',
      value: `${String(goal.roundsStarted)}/${String(goal.maxGoalRounds)}`,
      tone: 'normal'
    },
    {
      id: 'activation',
      label: 'Activation',
      value: state.activation,
      tone: 'muted'
    },
    {
      id: 'commands',
      label: 'Commands',
      value: legacyCommands(goal, state.activation)
        .map((command) => `/${command}`)
        .join(' · '),
      tone: 'muted'
    }
  ]
  return {
    visible: true,
    goalId: goal.id,
    phase: goal.phase,
    rows,
    commands: legacyCommands(goal, state.activation)
  }
}

const STORAGE_ERROR_TEXT = 'goal 状态读写失败（存储异常），请重试；持续失败请重启应用。'

function errorText(error: unknown): string {
  if (error instanceof SessionGoalError) return error.message
  return STORAGE_ERROR_TEXT
}

export interface LegacyCommandOutcome {
  result: KernelCommandResult
  goal: KernelGoalProjection | null
  plan: KernelPlanProjection | null
}

/**
 * flag 关执行一条 slash 命令。只认 `/goal ...`；其它命令在旧路径本来就不存在（renderer 只在
 * flag 关拦 `/goal`，其余行仍按普通消息发给模型），这里返回可诊断错误而不是静默 undefined。
 */
export async function runLegacySlashCommand(
  store: SessionGoalStore,
  threadId: string,
  line: string
): Promise<LegacyCommandOutcome> {
  const parsed = parseLegacyGoalCommand(line)
  if (parsed.kind === 'not-goal') {
    return {
      result: { kind: 'error', text: `未识别的命令：${line.trim()}` },
      goal: null,
      plan: null
    }
  }
  if (parsed.kind === 'invalid') {
    return { result: { kind: 'error', text: parsed.message }, goal: null, plan: null }
  }
  try {
    const current = await store.state(threadId)
    if (parsed.action === 'status') {
      return {
        result: { kind: 'success' },
        goal: projectLegacyGoalState(current),
        plan: null
      }
    }
    const goal = current.goal
    if (goal === null && parsed.action !== 'create') {
      return {
        result: {
          kind: 'error',
          text: 'No goal is currently set; /goal <action> requires one.'
        },
        goal: null,
        plan: null
      }
    }
    const ref = goal === null ? null : { id: goal.id, revision: goal.revision }
    const next =
      parsed.action === 'create'
        ? await applyGoalRequest(store, {
            threadId,
            action: 'create',
            objective: parsed.objective ?? ''
          })
        : parsed.action === 'edit'
          ? await applyGoalRequest(store, {
              threadId,
              action: 'edit',
              ref: ref!,
              objective: parsed.objective ?? ''
            })
          : await applyGoalRequest(store, {
              threadId,
              action: parsed.action,
              ref: ref!
            })
    return {
      result: { kind: 'success' },
      goal: projectLegacyGoalState(next as unknown as GoalState),
      plan: null
    }
  } catch (error) {
    return { result: { kind: 'error', text: errorText(error) }, goal: null, plan: null }
  }
}
