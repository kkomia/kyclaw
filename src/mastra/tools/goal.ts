/**
 * PB-039 模型侧 goal 工具三件套：`get_goal` / `create_goal` / `update_goal`。
 *
 * schema 字段名照抄 DSH `@deepseek-ai/dsh-tool-goal`（0.2.1-rc.2）：
 *   - `get_goal()`
 *   - `create_goal(objective, max_goal_rounds?)`
 *   - `update_goal(goal_id, revision, action, objective?, max_goal_rounds?, blocked_reason?)`
 *     action ∈ `edit | pause | resume | complete | blocked`
 *
 * 权限（G9 的 kyclaw 简化版；kyclaw 没有 subagent）：
 *   - `create/edit/pause/resume`：只允许**人类直发轮**（本轮 requestContext 里没有 goal round 标记）；
 *     goal round 里调用 → `GOAL_TOOL_HUMAN_ONLY`。
 *   - `complete/blocked`：人类轮与 goal round 都允许。
 *   - `resume` 一个 **paused** goal：模型不能做（`GOAL_TOOL_RESUME_PAUSED`，恢复归用户）。
 *   - `blocked` 阈值：**只在 goal round 来源强制**——`roundsStarted < 3` 直接拒
 *     （`GOAL_TOOL_BLOCK_THRESHOLD`，阈值常量在 `shared/goal.ts` 单点定义）。
 *   - 自主 `complete/blocked` 成功后，工具结果末尾注入 `<goal_complete>` / `<goal_blocked>`
 *     收尾指令（让模型在轮末向用户交代）；人类直发变更不注入（照抄 `tool-goal:91-98,365-372`）。
 *
 * 输出：紧凑 JSON 字符串（`{goal, activation}`）；领域拒绝回 `{error:{code,message}}` 文本而不是抛异常
 * ——让模型能读懂并调整，不把整轮打成失败。
 */
import { z } from '../../shared/zod'
import {
  DEFAULT_MAX_GOAL_ROUNDS,
  GOAL_BLOCK_AFTER_CONSECUTIVE_ROUNDS,
  GOAL_ERROR_TEXT,
  goalRoundOf,
  type GoalRoundMarker
} from '../../shared/goal'
import { SessionGoalError, type SessionGoalStore } from '../session-goal'

/** 工具执行上下文里我们用到的那几项（Mastra 传进来的是大对象，这里只取需要的） */
interface GoalToolContext {
  agent?: { threadId?: unknown }
  requestContext?: unknown
}

function threadIdOf(context: unknown): string {
  const agent = (context as GoalToolContext | undefined)?.agent
  const threadId = agent?.threadId
  if (typeof threadId !== 'string' || threadId === '')
    throw new Error('goal 工具缺少可信会话身份（agent.threadId），拒绝执行')
  return threadId
}

function roundOf(context: unknown): GoalRoundMarker | null {
  return goalRoundOf((context as GoalToolContext | undefined)?.requestContext)
}

/** 领域错误 → 给模型看的稳定文本（不抛，避免整轮失败） */
function rejection(error: unknown): string {
  if (error instanceof SessionGoalError) {
    return JSON.stringify({ error: { code: error.code, message: error.message } })
  }
  throw error
}

/** 自主收尾指令（只在 goal round 来源的 complete/blocked 后追加） */
function wrapup(kind: 'complete' | 'blocked', extra?: string): string {
  if (kind === 'complete') {
    return [
      '<goal_complete>',
      '目标已完成（goal 已标记 complete）。请在本轮回复末尾用一两句话向用户交代：完成了什么、还有哪些可选的后续；不要停下来等用户确认。',
      '</goal_complete>'
    ].join('\n')
  }
  return [
    '<goal_blocked>',
    `目标已标记为阻塞（goal 已标记 blocked）${extra ? `：${extra}` : ''}。请在本轮回复末尾如实告诉用户：卡在哪里、需要用户提供什么才能继续；不要假装还在推进。`,
    '</goal_blocked>'
  ].join('\n')
}

const getGoalInputSchema = z.strictObject({})

const createGoalInputSchema = z.strictObject({
  objective: z.string().min(1).max(4000),
  max_goal_rounds: z.number().int().positive().optional()
})

const updateGoalInputSchema = z.strictObject({
  goal_id: z.string().min(1).max(200),
  revision: z.number().int().positive(),
  action: z.enum(['edit', 'pause', 'resume', 'complete', 'blocked']),
  objective: z.string().min(1).max(4000).optional(),
  max_goal_rounds: z.number().int().positive().optional(),
  blocked_reason: z.string().min(1).max(2000).optional()
})

const goalToolOutputSchema = z.string()

export async function createGetGoalTool(store: SessionGoalStore) {
  const { createTool } = await import('@mastra/core/tools')
  return createTool({
    id: 'get_goal',
    description:
      'Read the current goal of this chat session (one goal per session). Returns compact JSON ' +
      '`{goal, activation}`; `goal` is null when no goal is set. `activation` (armed/disarmed) lives ' +
      'in the host process only — a resumed session starts disarmed until the user resumes it.',
    inputSchema: getGoalInputSchema,
    outputSchema: goalToolOutputSchema,
    execute: async (_input, context) => {
      const state = await store.state(threadIdOf(context))
      return JSON.stringify(state)
    }
  })
}

export async function createCreateGoalTool(store: SessionGoalStore) {
  const { createTool } = await import('@mastra/core/tools')
  return createTool({
    id: 'create_goal',
    description:
      'Create the goal for this session (one goal per session; only a completed goal can be replaced). ' +
      "Requires a human turn (not an automatic goal round). Default max rounds is " +
      `${String(DEFAULT_MAX_GOAL_ROUNDS)}. Returns compact JSON \`{goal, activation}\`.`,
    inputSchema: createGoalInputSchema,
    outputSchema: goalToolOutputSchema,
    execute: async (input, context) => {
      try {
        if (roundOf(context) !== null)
          return rejection(new SessionGoalError('GOAL_TOOL_HUMAN_ONLY'))
        const state = await store.create(
          threadIdOf(context),
          input.objective,
          input.max_goal_rounds ?? DEFAULT_MAX_GOAL_ROUNDS
        )
        return JSON.stringify(state)
      } catch (error) {
        return rejection(error)
      }
    }
  })
}

export async function createUpdateGoalTool(store: SessionGoalStore) {
  const { createTool } = await import('@mastra/core/tools')
  return createTool({
    id: 'update_goal',
    description:
      'Update the session goal. `action` is one of edit / pause / resume / complete / blocked. ' +
      'create/edit/pause/resume need a human turn; complete/blocked also work from an automatic goal round. ' +
      `A paused goal cannot be resumed by the model (the user owns that). blocked from a goal round is only ` +
      `allowed after ${String(GOAL_BLOCK_AFTER_CONSECUTIVE_ROUNDS)} rounds. ` +
      'Autonomous complete/blocked returns a `<goal_complete>` / `<goal_blocked>` wrap-up instruction.',
    inputSchema: updateGoalInputSchema,
    outputSchema: goalToolOutputSchema,
    execute: async (input, context) => {
      const threadId = threadIdOf(context)
      const source = roundOf(context)
      const ref = { id: input.goal_id, revision: input.revision }
      try {
        if (input.action === 'edit' || input.action === 'pause' || input.action === 'resume') {
          if (source !== null) return rejection(new SessionGoalError('GOAL_TOOL_HUMAN_ONLY'))
        }
        if (input.action === 'edit') {
          const state = await store.edit(threadId, ref, {
            objective: input.objective,
            maxGoalRounds: input.max_goal_rounds
          })
          return JSON.stringify(state)
        }
        if (input.action === 'pause') {
          return JSON.stringify(await store.pause(threadId, ref))
        }
        if (input.action === 'resume') {
          const current = await store.state(threadId)
          if (current.goal?.phase === 'paused')
            return rejection(new SessionGoalError('GOAL_TOOL_RESUME_PAUSED'))
          return JSON.stringify(await store.resume(threadId, ref))
        }
        if (input.action === 'complete') {
          const state = await store.complete(threadId, ref)
          return source === null
            ? JSON.stringify(state)
            : `${JSON.stringify(state)}\n\n${wrapup('complete')}`
        }
        // blocked
        if (input.blocked_reason === undefined || input.blocked_reason.trim() === '')
          return rejection(new SessionGoalError('GOAL_INVALID_ACTION'))
        if (source !== null) {
          const current = await store.state(threadId)
          if ((current.goal?.roundsStarted ?? 0) < GOAL_BLOCK_AFTER_CONSECUTIVE_ROUNDS)
            return rejection(new SessionGoalError('GOAL_TOOL_BLOCK_THRESHOLD'))
        }
        const state = await store.block(threadId, ref, {
          code: 'model-reported',
          message: input.blocked_reason.trim()
        })
        return source === null
          ? JSON.stringify(state)
          : `${JSON.stringify(state)}\n\n${wrapup('blocked', input.blocked_reason.trim())}`
      } catch (error) {
        return rejection(error)
      }
    }
  })
}

/** 注册进 agent 的那一份（字段名与 DSH 一致：get_goal / create_goal / update_goal） */
export async function createGoalTools(store: SessionGoalStore): Promise<{
  get_goal: Awaited<ReturnType<typeof createGetGoalTool>>
  create_goal: Awaited<ReturnType<typeof createCreateGoalTool>>
  update_goal: Awaited<ReturnType<typeof createUpdateGoalTool>>
}> {
  return {
    get_goal: await createGetGoalTool(store),
    create_goal: await createCreateGoalTool(store),
    update_goal: await createUpdateGoalTool(store)
  }
}

/** 供单测/其它工具复用：错误文案（避免两处硬编码） */
export const GOAL_TOOL_ERROR_TEXT = GOAL_ERROR_TEXT
