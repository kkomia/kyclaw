/**
 * 记忆 API（T14）：挂在 agent 服务（service.ts）上的 Hono 子路由，路径前缀 /api/memory。
 *
 * 四条：
 *   GET    /api/memory?threadId=…   该会话的 working memory（没写过 → content=null）
 *   PUT    /api/memory?threadId=…   整块替换（空串 = 清空；模板口径是 replace 语义，不做合并）
 *   DELETE /api/memory?threadId=…   清空（幂等）
 *   GET    /api/memory/recall       语义召回（长期记忆）的**本次运行状态**（round 28 模块 3）
 *
 * **记忆按会话隔离（round 58）**：working memory 的作用域是 **thread**（见 mastra/index.ts 的装配）
 * —— 一个会话一份，所以 threadId 是**必填**（缺 / 空 → 400，同 /api/usage/context 的口径）：
 * 记忆页看的是"当前会话的记忆"，助手在对话里更新的也只是当前会话那一份；跨会话共享不再做
 * （库里旧的 resource 画像留在原处，改后不再被读）。resourceId 仍取 `LOCAL_USER_RESOURCE_ID`
 * （MVP 单用户）随入参传给 Mastra；语义召回同为 thread 作用域（只召回本会话的消息）。
 * 读写的原语是 Mastra Memory 的 `getWorkingMemory` / `updateWorkingMemory`（不自造存储），
 * 清空 = 写入空串（Mastra 读回时把空内容归一成 null）。
 * 注意 thread 档的写入要求线程已存在（@mastra/memory 会先 getThreadById）——记忆页只对
 * 会话列表里的会话发请求，草稿不请求（见渲染端 MemoryPage）。
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

/** 会话 id 的取值口径（round 58 记忆按会话隔离）：缺 / 空 / 全空白 = 没有，调用方回 400 */
function queryThreadId(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const threadId = raw.trim()
  return threadId === '' ? null : threadId
}

export function createMemoryRouter(options: MemoryRouterOptions): Hono {
  const router = new Hono()
  const resourceId = options.resourceId ?? LOCAL_USER_RESOURCE_ID
  const recall = options.recall ?? defaultRecallRuntime()
  /** thread 档的读写都要这对入参：threadId 从查询串来（每条请求各自解析），resourceId 恒为本机用户 */
  const argsOf = (threadId: string): { threadId: string; resourceId: string } => ({
    threadId,
    resourceId
  })

  router.get('/', async (context) => {
    const threadId = queryThreadId(context.req.query('threadId'))
    if (threadId === null) return context.json(badRequest('threadId'), 400)

    const content = await options.memory.getWorkingMemory(argsOf(threadId))
    return context.json(workingMemoryResponseSchema.parse({ content }))
  })

  router.put('/', async (context) => {
    const threadId = queryThreadId(context.req.query('threadId'))
    if (threadId === null) return context.json(badRequest('threadId'), 400)

    const body = putWorkingMemoryRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json(badRequest('记忆内容'), 400)

    // 两端空白不算内容：全空白 = 清空（与 DELETE 同效），读回来就是 null
    const content = body.data.content.trim()
    await options.memory.updateWorkingMemory({ ...argsOf(threadId), workingMemory: content })
    return context.json(
      workingMemoryResponseSchema.parse({ content: content === '' ? null : content })
    )
  })

  router.delete('/', async (context) => {
    const threadId = queryThreadId(context.req.query('threadId'))
    if (threadId === null) return context.json(badRequest('threadId'), 400)

    await options.memory.updateWorkingMemory({ ...argsOf(threadId), workingMemory: '' })
    return context.json(clearMemoryResponseSchema.parse({ ok: true }))
  })

  // 语义召回（长期记忆）的本次运行状态：纯读，不碰设置、不碰密钥（round 28）
  router.get('/recall', (context) => {
    return context.json(recallStatusResponseSchema.parse({ recall: recall.status() }))
  })

  return router
}
