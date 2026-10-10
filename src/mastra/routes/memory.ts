/**
 * 记忆 API（T14）：挂在 agent 服务（service.ts）上的 Hono 子路由，路径前缀 /api/memory。
 *
 * 三条：
 *   GET    /api/memory   当前 working memory（没写过 → content=null）
 *   PUT    /api/memory   整块替换（空串 = 清空；模板口径是 replace 语义，不做合并）
 *   DELETE /api/memory   清空（幂等）
 *
 * 记忆归 `LOCAL_USER_RESOURCE_ID`（MVP 单用户），作用域是 **resource**：跨会话共享的一份
 * 长期画像——所以这里不需要线程参数：任何会话里助手写下的记忆，记忆页看到的都是同一份。
 * 读写的原语是 Mastra Memory 的 `getWorkingMemory` / `updateWorkingMemory`（不自造存储），
 * 清空 = 写入空串（Mastra 读回时把空内容归一成 null）。
 */
import { Hono } from 'hono'
import type { MastraMemory } from '@mastra/core/memory'
import {
  clearMemoryResponseSchema,
  putWorkingMemoryRequestSchema,
  workingMemoryResponseSchema
} from '../../shared/memory'
import { LOCAL_USER_RESOURCE_ID } from '../../shared/threads'

export interface MemoryRouterOptions {
  memory: MastraMemory
  /** 记忆的归属（缺省 = local-user；测试可给别的 id 做隔离） */
  resourceId?: string
}

function badRequest(detail: string): { error: string } {
  return { error: `invalid-input: ${detail}` }
}

export function createMemoryRouter(options: MemoryRouterOptions): Hono {
  const router = new Hono()
  const resourceId = options.resourceId ?? LOCAL_USER_RESOURCE_ID
  /**
   * resource 作用域的读写只用得到 resourceId；threadId 是 Mastra 的入参占位
   * （实现里那条分支不读它）——传同一个 id，免得出现一个不存在的线程名。
   */
  const args = { threadId: resourceId, resourceId }

  router.get('/', async (context) => {
    const content = await options.memory.getWorkingMemory(args)
    return context.json(workingMemoryResponseSchema.parse({ content }))
  })

  router.put('/', async (context) => {
    const body = putWorkingMemoryRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json(badRequest('记忆内容'), 400)

    // 两端空白不算内容：全空白 = 清空（与 DELETE 同效），读回来就是 null
    const content = body.data.content.trim()
    await options.memory.updateWorkingMemory({ ...args, workingMemory: content })
    return context.json(
      workingMemoryResponseSchema.parse({ content: content === '' ? null : content })
    )
  })

  router.delete('/', async (context) => {
    await options.memory.updateWorkingMemory({ ...args, workingMemory: '' })
    return context.json(clearMemoryResponseSchema.parse({ ok: true }))
  })

  return router
}
