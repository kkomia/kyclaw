/**
 * 记忆 API（T14）：挂在 agent 服务（service.ts）上的 Hono 子路由，路径前缀 /api/memory。
 *
 * 四条：
 *   GET    /api/memory         当前 working memory（没写过 → content=null）
 *   PUT    /api/memory         整块替换（空串 = 清空；模板口径是 replace 语义，不做合并）
 *   DELETE /api/memory         清空（幂等）
 *   GET    /api/memory/recall  语义召回（长期记忆）的**本次运行状态**（round 28 模块 3）
 *
 * 记忆归 `LOCAL_USER_RESOURCE_ID`（MVP 单用户），作用域是 **resource**：working memory 是
 * 跨会话共享的一份长期画像（所以这里不需要线程参数：任何会话里助手写下的记忆，记忆页看到的
 * 都是同一份）；语义召回同理走 resource 作用域（跨会话召回旧消息，见 mastra/embedding.ts）。
 * 读写的原语是 Mastra Memory 的 `getWorkingMemory` / `updateWorkingMemory`（不自造存储），
 * 清空 = 写入空串（Mastra 读回时把空内容归一成 null）。
 *
 * 状态路由只读不写：开关与来源在 settings.json（settings:update 写），密钥在 secrets.json
 * （memory:* 通道写）——装配在服务启动时做一次，所以状态要能说清"改了还没重启"这回事。
 */
import { Hono } from 'hono'
import type { MastraMemory } from '@mastra/core/memory'
import {
  clearMemoryResponseSchema,
  putWorkingMemoryRequestSchema,
  recallStatusResponseSchema,
  workingMemoryResponseSchema
} from '../../shared/memory'
import { LOCAL_USER_RESOURCE_ID } from '../../shared/threads'
import { DEFAULT_SEMANTIC_RECALL } from '../../shared/settings'
import type { RecallRuntime } from '../embedding'

export interface MemoryRouterOptions {
  memory: MastraMemory
  /** 记忆的归属（缺省 = local-user；测试可给别的 id 做隔离） */
  resourceId?: string
  /**
   * 语义召回的运行时状态（round 28）：缺省 = 一个"没开"的固定状态
   * ——本子路由不依赖装配细节，测试可以给别的实现。
   */
  recall?: Pick<RecallRuntime, 'status'>
}

/** 没注入状态时的口径：没开语义召回（本模块不假装知道自己不知道的事） */
function defaultRecallRuntime(): Pick<RecallRuntime, 'status'> {
  return {
    status: () => ({
      state: 'off',
      active: false,
      enabled: false,
      source: DEFAULT_SEMANTIC_RECALL.source,
      detail: '语义召回未开启'
    })
  }
}

function badRequest(detail: string): { error: string } {
  return { error: `invalid-input: ${detail}` }
}

export function createMemoryRouter(options: MemoryRouterOptions): Hono {
  const router = new Hono()
  const resourceId = options.resourceId ?? LOCAL_USER_RESOURCE_ID
  const recall = options.recall ?? defaultRecallRuntime()
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

  // 语义召回（长期记忆）的本次运行状态：纯读，不碰设置、不碰密钥（round 28）
  router.get('/recall', (context) => {
    return context.json(recallStatusResponseSchema.parse({ recall: recall.status() }))
  })

  return router
}
