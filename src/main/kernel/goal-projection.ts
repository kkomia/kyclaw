/**
 * B3.3：goal 投影（**内核权威、我方只投影**）。
 *
 * 六行结构 = GoalDock / GoalCommandCard 需要的全部数据：
 *   Status / Blocker / Objective / Rounds / Activation / Commands
 *
 * Rounds 显示规则（Lead 明确要求）：内核上限是 256，但我们有 **16 轮安全阀**；
 * 不能只显示 256 让人误解 → 统一显示 `x/16（内核上限 256）`；若内核上限本身 ≤16，则显示 `x/<内核上限>`。
 *
 * ⚠️ 本模块**只读**：`admitRound` / `disarm` 等旧写入路径保持并存但不再由这里调用。
 */
import type { GoalProjection } from '../../shared/kernel-port/ports'

/** 内核 `session/page` 里的 goal 快照（字段照 rc.2） */
export interface KernelGoalState {
  goal: {
    id: string
    objective: string
    phase: 'active' | 'paused' | 'blocked' | 'complete'
    blockedReason?: { code: string; message: string }
    maxGoalRounds: number
    revision: number
  }
  roundsStarted: number
  createdAt: number
  updatedAt: number
}

export const GOAL_SAFE_ROUND_LIMIT = 16

export type GoalRowId = 'status' | 'blocker' | 'objective' | 'rounds' | 'activation' | 'commands'

export interface GoalRow {
  id: GoalRowId
  label: string
  value: string
  tone: 'normal' | 'warning' | 'muted'
}

export interface GoalDockProjection {
  visible: boolean
  goalId?: string
  phase?: KernelGoalState['goal']['phase']
  rows: GoalRow[]
  rounds?: {
    started: number
    /** 实际生效的安全阀（= min(16, 内核上限)） */
    limit: number
    kernelLimit: number
    /** UI 唯一该显示的形态：`x/16（内核上限 256）` 或 `x/16` */
    label: string
  }
  /** 有效下一步命令名（供 UI 渲染按钮；真正执行仍走内核命令平面） */
  commands: readonly string[]
}

const PHASE_LABEL: Readonly<Record<KernelGoalState['goal']['phase'], string>> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  complete: '已完成'
}

function commandsFor(phase: KernelGoalState['goal']['phase']): string[] {
  if (phase === 'active') return ['goal pause', 'goal edit', 'goal clear']
  if (phase === 'paused') return ['goal resume', 'goal edit', 'goal clear']
  if (phase === 'blocked') return ['goal resume', 'goal clear']
  return ['goal clear']
}

/** 内核 goal → 六行投影；`null` = 没有 goal（dock 隐藏） */
export function projectGoalDock(
  state: KernelGoalState | null,
  options: { activationEnabled?: boolean } = {}
): GoalDockProjection {
  if (state === null) return { visible: false, rows: [], commands: [] }
  const kernelLimit = state.goal.maxGoalRounds
  const limit = Math.min(GOAL_SAFE_ROUND_LIMIT, kernelLimit)
  const label =
    kernelLimit > GOAL_SAFE_ROUND_LIMIT
      ? `${String(state.roundsStarted)}/${String(limit)}（内核上限 ${String(kernelLimit)}）`
      : `${String(state.roundsStarted)}/${String(limit)}`
  const activationEnabled = options.activationEnabled ?? state.goal.phase === 'active'
  const atLimit = state.roundsStarted >= limit
  const rows: GoalRow[] = [
    {
      id: 'status',
      label: 'Status',
      value: PHASE_LABEL[state.goal.phase],
      tone: state.goal.phase === 'blocked' || state.goal.phase === 'complete' ? 'warning' : 'normal'
    },
    {
      id: 'blocker',
      label: 'Blocker',
      value: state.goal.blockedReason?.message ?? '—',
      tone: state.goal.blockedReason === undefined ? 'muted' : 'warning'
    },
    { id: 'objective', label: 'Objective', value: state.goal.objective, tone: 'normal' },
    {
      id: 'rounds',
      label: 'Rounds',
      value: atLimit ? `${label}（已达安全阀上限，不再自动续行）` : label,
      tone: atLimit ? 'warning' : 'normal'
    },
    {
      id: 'activation',
      label: 'Activation',
      value: atLimit ? '已停用（达到安全阀上限）' : activationEnabled ? '续行已启用' : '续行未启用',
      tone: activationEnabled && !atLimit ? 'normal' : 'muted'
    },
    {
      id: 'commands',
      label: 'Commands',
      value: atLimit
        ? '/goal resume（需人工确认） / /goal clear'
        : commandsFor(state.goal.phase)
            .map((command) => `/${command}`)
            .join(' · '),
      tone: 'muted'
    }
  ]
  return {
    visible: true,
    goalId: state.goal.id,
    phase: state.goal.phase,
    rows,
    rounds: { started: state.roundsStarted, limit, kernelLimit, label },
    commands: atLimit ? ['goal clear'] : commandsFor(state.goal.phase)
  }
}

/**
 * 兼容 `ports.GoalPort` 的投影入口（旧接口）：把内核 goal 映射成 B2 的 GoalProjection。
 * B3.3 的 UI 数据走 `GoalDockProjection`（六行）；这里只保持端口形状可用，不写任何状态。
 */
export function projectGoal(state: KernelGoalState | null): GoalProjection {
  const dock = projectGoalDock(state)
  if (!dock.visible) return { visible: false, actions: [] }
  return {
    visible: true,
    ...(dock.goalId === undefined ? {} : { goalId: dock.goalId }),
    ...(dock.phase === undefined ? {} : { phaseLabel: PHASE_LABEL[dock.phase] }),
    objective: dock.rows.find((row) => row.id === 'objective')?.value,
    roundsLabel: dock.rounds?.label,
    ...(state?.goal.blockedReason === undefined
      ? {}
      : { blockedMessage: state.goal.blockedReason.message }),
    actions: dock.commands.flatMap((command): Array<'pause' | 'resume' | 'edit' | 'clear'> => {
      const verb = command.split(' ')[1]
      return verb === 'pause' || verb === 'resume' || verb === 'edit' || verb === 'clear'
        ? [verb]
        : []
    })
  }
}
