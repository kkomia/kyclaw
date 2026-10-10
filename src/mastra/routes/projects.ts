/**
 * 项目映射 API（T18）：挂在 agent 服务（service.ts）上的 Hono 子路由，路径前缀 /api/projects。
 *
 * 两条：
 *   GET /api/projects/mappings           会话↔项目映射（渲染端侧栏按项目分组用）
 *   PUT /api/projects/mappings           写一条（{ threadId, projectId }；projectId=null 摘出来）
 *
 * 为什么不并进 /api/threads：项目映射与线程存储是**同库不同表**（session_projects 是 T18 自建表，
 * 见 session-projects.ts），线程契约（T9）的形状不必跟着变；渲染端两处各取一份、join 在 UI 层做。
 *
 * 纪律同其它路由：入参过 zod（shared/projects.ts），失败 400；写失败 500（映射没记上要让 UI 看见，
 * 不能静默 —— 记不上意味着这个会话享受不到项目工作区）。
 * 挂载点在 token 闸门之后：与 chat / threads 同一条防线。
 */
import { Hono } from 'hono'
import { sessionProjectListSchema, sessionProjectRequestSchema } from '../../shared/projects'
import type { SessionProjectStore } from '../session-projects'

export interface ProjectsRouterOptions {
  store: SessionProjectStore
}

function badRequest(detail: string): { error: string } {
  return { error: `invalid-input: ${detail}` }
}

export function createProjectsRouter(options: ProjectsRouterOptions): Hono {
  const router = new Hono()
  const { store } = options

  router.get('/mappings', async (context) => {
    return context.json(sessionProjectListSchema.parse({ sessions: store.list() }))
  })

  router.put('/mappings', async (context) => {
    const body = sessionProjectRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json(badRequest('映射'), 400)

    try {
      if (body.data.projectId === null) await store.clear(body.data.threadId)
      else await store.set(body.data.threadId, body.data.projectId)
    } catch (error) {
      console.error('[kyclaw] 会话↔项目映射写入失败', error)
      return context.json({ error: 'mapping-write-failed' }, 500)
    }
    return context.json({ ok: true })
  })

  return router
}
