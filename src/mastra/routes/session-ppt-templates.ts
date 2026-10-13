/**
 * 会话↔PPT 模板映射 API（round 66）：挂在 agent 服务上的 Hono 子路由，路径前缀 /api/ppt。
 *
 * 两条：
 *   GET /api/ppt/templates           全部映射（渲染端启动时拉一遍，切会话当场就有）
 *   PUT /api/ppt/templates           写一条（{ threadId, template }；template 空串 = 清回自动）
 *
 * 为什么不并进 /api/threads：与项目映射同一分工（见 routes/projects.ts 头注）—— 映射与线程存储是
 * 同库不同表，线程契约（T9）的形状不必跟着变；渲染端两处各取一份、join 在 UI 层做。
 *
 * 纪律同其它路由：入参过 zod（shared/session-ppt-templates.ts），失败 400；写失败 500。
 * **模板名要过注册表**（lookupTemplate）：与项目映射的 projectId 不同，这里的取值直接决定
 * create_ppt 用哪套配色，落一个不存在的名字进去只会静默退成"自动挑"（用户以为固定了、其实没生效）。
 * 挂载点在 token 闸门之后：与 chat / threads / projects 同一条防线。
 */
import { Hono } from 'hono'
import { lookupTemplate } from '../../shared/ppt-templates'
import {
  sessionPptTemplateListSchema,
  sessionPptTemplateRequestSchema
} from '../../shared/session-ppt-templates'
import type { SessionPptTemplateStore } from '../session-ppt-templates'

export interface SessionPptTemplatesRouterOptions {
  store: SessionPptTemplateStore
}

function badRequest(detail: string): { error: string } {
  return { error: `invalid-input: ${detail}` }
}

export function createSessionPptTemplatesRouter(options: SessionPptTemplatesRouterOptions): Hono {
  const router = new Hono()
  const { store } = options

  router.get('/templates', async (context) => {
    return context.json(sessionPptTemplateListSchema.parse({ sessions: store.list() }))
  })

  router.put('/templates', async (context) => {
    const body = sessionPptTemplateRequestSchema.safeParse(
      await context.req.json().catch(() => null)
    )
    if (!body.success) return context.json(badRequest('模板映射'), 400)

    const { threadId, template } = body.data
    // 空串 = 清回自动（合法）；非空则必须是注册表里的那十套之一
    if (template !== '' && lookupTemplate(template) === undefined) {
      return context.json(badRequest(`未知模板：${template}`), 400)
    }

    try {
      if (template === '') await store.clear(threadId)
      else await store.set(threadId, template)
    } catch (error) {
      console.error('[kyclaw] 会话↔PPT 模板映射写入失败', error)
      return context.json({ error: 'mapping-write-failed' }, 500)
    }
    return context.json({ ok: true })
  })

  return router
}
