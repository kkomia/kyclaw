/**
 * PB-039 goal HTTP API（`/api/goal`）：GET 读状态，POST 做 create/edit/pause/resume/complete/
 * block/clear/disarm。
 *
 * 语义全部在 `session-goal.ts`（照抄 DSH `dsh-goal`）；这层只做三件事：
 *   1. 入参过 zod（`src/shared/goal.ts`，与渲染端同一个 schema）；
 *   2. 领域错误 → `{ error: 'GOAL_*', message: 中文 }` + 对应状态码；
 *   3. 未知存储异常 → 500 `GOAL_STORAGE_ERROR`（不把栈/内部 id 暴露给前端）。
 */
import type { ApiRoute } from '@mastra/core/server'
import { z } from '../../shared/zod'
import { goalRequestSchema, goalThreadIdSchema, type GoalRequest } from '../../shared/goal'
import { SessionGoalError, type SessionGoalStore } from '../session-goal'

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json({ error: code, message }, { status })
}

/** 把领域/入参/存储异常统一成契约里的错误形状 */
function failure(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return errorResponse('GOAL_INVALID_ACTION', '请求字段不合法（goal 动作或参数不对）。', 400)
  }
  if (error instanceof SessionGoalError) {
    return errorResponse(error.code, error.message, error.status)
  }
  console.error('[kyclaw] goal 请求失败（存储异常）', error)
  return errorResponse(
    'GOAL_STORAGE_ERROR',
    'goal 状态读写失败（存储异常），请重试；持续失败请重启应用。',
    500
  )
}

/** 把请求派发到 store（HTTP 与工具共用同一套动词语义） */
export async function applyGoalRequest(
  store: SessionGoalStore,
  input: GoalRequest
): Promise<{ goal: unknown; activation: unknown }> {
  switch (input.action) {
    case 'create':
      return store.create(input.threadId, input.objective, input.maxGoalRounds)
    case 'edit':
      return store.edit(input.threadId, input.ref, {
        objective: input.objective,
        maxGoalRounds: input.maxGoalRounds
      })
    case 'pause':
      return store.pause(input.threadId, input.ref)
    case 'resume':
      return store.resume(input.threadId, input.ref)
    case 'complete':
      return store.complete(input.threadId, input.ref)
    case 'clear':
      return store.clear(input.threadId, input.ref)
    case 'block':
      return store.block(input.threadId, input.ref, input.blocked)
    case 'disarm':
      return store.disarm(input.threadId)
  }
}

export async function createGoalRoutes(store: SessionGoalStore): Promise<ApiRoute[]> {
  const { registerApiRoute } = await import('@mastra/core/server')
  return [
    registerApiRoute('/goal', {
      method: 'GET',
      handler: async (context) => {
        try {
          const threadId = goalThreadIdSchema.parse(context.req.query('threadId'))
          return Response.json(await store.state(threadId))
        } catch (error) {
          return failure(error)
        }
      }
    }),
    registerApiRoute('/goal', {
      method: 'POST',
      handler: async (context) => {
        try {
          const body = goalRequestSchema.parse(await context.req.json().catch(() => null))
          return Response.json(await applyGoalRequest(store, body))
        } catch (error) {
          return failure(error)
        }
      }
    })
  ]
}
