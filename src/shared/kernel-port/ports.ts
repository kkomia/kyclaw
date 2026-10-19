/**
 * B2 适配层端口（KernelPort 四组 + InteractionPort / UsagePort / GoalPort）。
 *
 * 架构决策（Lead 已拍，照此实现）：
 *   - **D1**：真正的 adapter 在 **Electron main**（`src/main/kernel/`）；renderer 仍走我们现有的
 *     本地 HTTP/SSE 形状；**内核 token 不下发 renderer**。所以这里只定义 shared 契约，不含实现。
 *   - **D2**：`HostToolBridge` 用 main 内回环 HTTP + 每次启动随机 token（见 `src/main/kernel/host-tool-bridge.ts`）。
 *   - **D5**：迁移 = 一次性 import + 派生索引可重建，**不做双写真源**。
 *
 * 语义依据：`.superpowers/dev-verify/20261019-0.2.0/ada/b1-kernel-forensics.md`
 * 与 `.superpowers/dev-verify/20261019-0.2.0/bao/poc-kernel-boot.md`（真机事件流）。
 */
import type {
  CommandDescriptor,
  CommandResult,
  GoalMutation,
  InteractionRequest,
  InteractionResponse,
  KernelGoal,
  SessionEvent,
  SessionSeq,
  ToolDescriptor,
  UsageSnapshot
} from './types'

/** 事件组：订阅实时事件 + 从日志回放（回放用于重启后重建 UI/派生索引） */
export interface KernelEventPort {
  subscribe(listener: (event: SessionEvent) => void): () => void
  /** 从 `fromSeq`（含）开始回放；省略 = 全量 */
  replay(fromSeq?: SessionSeq): AsyncIterable<SessionEvent>
}

/** 命令组：命令由内核/插件拥有，直接对 agent 执行，**不产生模型消息** */
export interface KernelCommandPort {
  list(): readonly CommandDescriptor[]
  execute(name: string, input?: string): Promise<CommandResult>
}

/** 工具组：列出/调用内核注册工具（模型侧工具与插件注入的工具都在这里） */
export interface KernelToolPort {
  list(): readonly ToolDescriptor[]
  invoke(
    toolName: string,
    args: unknown
  ): Promise<{ ok: boolean; result?: unknown; message?: string }>
}

/** 会话句柄（只暴露给 main；renderer 拿不到内核 token/URL） */
export interface KernelSessionHandle {
  id: string
}

/** 会话组：建会话、投递一条用户消息、取消、关闭 */
export interface KernelSessionPort {
  createSession(input?: { title?: string; cwd?: string }): Promise<KernelSessionHandle>
  postUserMessage(sessionId: string, text: string): Promise<{ acceptedSeq: SessionSeq }>
  /** 协作式取消：内核语义下**已交付的文本会保留**（对应我们 PB-035 的 C 能力） */
  cancel(sessionId: string): Promise<void>
  close(sessionId: string): Promise<void>
}

/** KernelPort 四组（B2 只钉契约，不接真内核） */
export interface KernelPort {
  events: KernelEventPort
  commands: KernelCommandPort
  tools: KernelToolPort
  sessions: KernelSessionPort
}

/**
 * 交互端口：ask_user / approval。
 * 内核是一等公民的"会话内请求-应答"（不是我们现有的 1500ms 轮询）——B2 先把形状钉住。
 */
export interface InteractionPort {
  requests(sessionId: string): AsyncIterable<InteractionRequest>
  respond(response: InteractionResponse): Promise<void>
}

/**
 * 用量端口：给 UI 的读数必须带 `exactness`。
 * `heuristic` 明确会低估 CJK（内核 token-meter 固定 4 字符/token），`unknown` 时 UI 显示「—」。
 */
export interface UsagePort {
  read(sessionId: string): Promise<UsageSnapshot>
}

/**
 * Goal 端口：**内核权威**（创建/暂停/恢复/完成/阻塞/清除与 CAS 都在内核），
 * 我方只做投影（dock 条渲染与按钮状态）——见 `projectGoal`。
 */
export interface GoalPort {
  read(sessionId: string): Promise<KernelGoal | null>
  apply(sessionId: string, mutation: GoalMutation): Promise<KernelGoal | null>
}

/**
 * 我方 UI 的 goal 投影（不是内核状态）：把内核 goal 映射成 dock 条要的字段。
 * 与 `src/shared/goal.ts` 的现有 GoalView 形状**故意不同**——B2 不改现有行为，
 * 迁移时再由 adapter 决定是复用旧 store 还是直接喂投影。
 */
export interface GoalProjection {
  visible: boolean
  goalId?: string
  phaseLabel?: string
  objective?: string
  roundsLabel?: string
  blockedMessage?: string
  /** 允许展示的动作（内核校验前的 UI 提示；真正 CAS 由内核做） */
  actions: readonly ('pause' | 'resume' | 'edit' | 'clear')[]
}

const PHASE_LABEL: Readonly<Record<KernelGoal['phase'], string>> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  complete: '已完成'
}

/** 内核 goal → 我方投影（纯函数，UI 不接触内核对象） */
export function projectGoal(goal: KernelGoal | null): GoalProjection {
  if (goal === null) return { visible: false, actions: [] }
  const actions: GoalProjection['actions'] =
    goal.phase === 'active'
      ? ['pause', 'edit', 'clear']
      : goal.phase === 'paused'
        ? ['resume', 'edit', 'clear']
        : goal.phase === 'blocked'
          ? ['resume', 'clear']
          : ['clear']
  return {
    visible: true,
    goalId: goal.id,
    phaseLabel: PHASE_LABEL[goal.phase],
    objective: goal.objective,
    roundsLabel: `${String(goal.roundsStarted)}/${String(goal.maxGoalRounds)}`,
    ...(goal.blockedReason === undefined ? {} : { blockedMessage: goal.blockedReason.message }),
    actions
  }
}
