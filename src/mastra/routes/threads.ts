/**
 * 线程 API（T9）：挂在 agent 服务（service.ts）上的 Hono 子路由，路径前缀 /api/threads。
 *
 * 六条：
 *   GET    /api/threads                 会话列表（只认 local-user 资源；id/标题/更新时间）
 *   GET    /api/threads/:id/messages    历史回灌的来源（存储消息 JSON，渲染端用 message-map 映射）
 *   PATCH  /api/threads/:id             重命名
 *   DELETE /api/threads/:id             删除（连消息一起；幂等）
 *   POST   /api/threads/:id/truncate    编辑重发的服务端半边（R2：从 messageId 起连它一起删）
 *   POST   /api/threads/:id/title       首轮后生成标题（失败降级截断首句；已有标题直接回）
 *
 * 三条纪律：
 *   1. **服务端是线程数据的权威**：列表/回灌/删除/截断都直接读写 Mastra Memory（libsql）；
 *      渲染端发来的 messages 只是"这一轮的输入"，历史以存储为准。
 *   2. 入参（路由参数 + JSON body）全部过 zod（shared/threads.ts），非法即 400；
 *      回包结构也定义在同一处，渲染端 parse。
 *   3. 缺失的线程：GET messages / truncate 走"空结果"（幂等），PATCH / title 走 404
 *      （改一个不存在的东西是错误，不是空操作）。
 */
import { Hono } from 'hono'
import type { MastraMemory } from '@mastra/core/memory'
import type { StorageThreadType } from '@mastra/core/memory'
import {
  LOCAL_USER_RESOURCE_ID,
  renameThreadRequestSchema,
  threadIdParamsSchema,
  truncateThreadRequestSchema
} from '../../shared/threads'
import type { ModelResolver } from '../agents/kyclaw'
import { generateThreadTitle } from '../title'

export interface ThreadsRouterOptions {
  memory: MastraMemory
  /** 标题生成用的模型解析器（生产 = 读设置与密钥那条；测试 = mock） */
  resolveModel: ModelResolver
  /**
   * 掐掉某线程正在跑的那一轮（DELETE 用）：取消会触发"把半截回复落库"，
   * 落库又会把线程行写回来——所以删之前必须先取消、等它落完再删，
   * 否则"删掉的会话"会带着半截回复复活（T9 实测）。
   * 生产 = `agent.abortThreadStream({threadId, resourceId})`；测试可不给（就不取消）。
   */
  abortThreadRun?: (threadId: string) => void
  /**
   * 线程真被删掉之后的钩子（T18：会话↔项目映射跟着清）。真删了才调，幂等路径（线程本就不存在）不调；
   * 是"顺带的旁路"，不该拖慢/弄坏删除本身——实现方自己吞错（见 main/agent/service.ts）。
   */
  onThreadDeleted?: (threadId: string) => void
}

/** 存储线程 → 列表项（title 空串归一成 null；时间转 ISO） */
function toSummary(thread: StorageThreadType): {
  id: string
  title: string | null
  updatedAt: string
} {
  const title = thread.title?.trim() ?? ''
  return {
    id: thread.id,
    title: title === '' ? null : title,
    updatedAt: new Date(thread.updatedAt).toISOString()
  }
}

/** 找本资源的线程（MVP 单用户：不是 local-user 的一律当不存在，不暴露别人的会话） */
async function findThread(memory: MastraMemory, id: string): Promise<StorageThreadType | null> {
  const thread = await memory.getThreadById({ threadId: id })
  if (!thread || thread.resourceId !== LOCAL_USER_RESOURCE_ID) return null
  return thread
}

/** 消息里的纯文本（标题素材用）：只取 text part，按序拼接 */
function messageText(message: { content?: unknown }): string {
  const content = message.content
  if (typeof content !== 'object' || content === null) return ''
  const parts = (content as { parts?: unknown }).parts
  if (!Array.isArray(parts)) return ''
  return parts
    .flatMap((part) =>
      typeof part === 'object' &&
      part !== null &&
      (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
        ? [(part as { text: string }).text]
        : []
    )
    .join('\n')
    .trim()
}

function badRequest(detail: string): { error: string } {
  return { error: `invalid-input: ${detail}` }
}

export function createThreadsRouter(options: ThreadsRouterOptions): Hono {
  const router = new Hono()
  const { memory } = options

  router.get('/', async (context) => {
    const result = await memory.listThreads({
      filter: { resourceId: LOCAL_USER_RESOURCE_ID },
      perPage: false,
      orderBy: { field: 'updatedAt', direction: 'DESC' }
    })
    return context.json({ threads: result.threads.map(toSummary) })
  })

  router.get('/:id/messages', async (context) => {
    const params = threadIdParamsSchema.safeParse(context.req.param())
    if (!params.success) return context.json(badRequest('线程 id'), 400)

    // 线程不存在时 recall 本身就是空结果（幂等），与"还没发过消息的草稿"同路
    const { messages } = await memory.recall({ threadId: params.data.id, perPage: false })
    return context.json({ messages })
  })

  router.patch('/:id', async (context) => {
    const params = threadIdParamsSchema.safeParse(context.req.param())
    if (!params.success) return context.json(badRequest('线程 id'), 400)
    const body = renameThreadRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json(badRequest('标题不合法'), 400)

    if ((await findThread(memory, params.data.id)) === null) {
      return context.json({ error: 'not-found' }, 404)
    }
    const updated = await memory.updateThread({ id: params.data.id, title: body.data.title })
    return context.json(toSummary(updated))
  })

  router.delete('/:id', async (context) => {
    const params = threadIdParamsSchema.safeParse(context.req.param())
    if (!params.success) return context.json(badRequest('线程 id'), 400)

    if ((await findThread(memory, params.data.id)) !== null) {
      // 顺序要紧：先掐掉在跑的那一轮，等它把"半截回复"落完，再删线程。
      // 反过来（先删后掐）取消引发的落库会把线程行写回来——删掉的会话会复活。
      options.abortThreadRun?.(params.data.id)
      try {
        await memory.settled()
      } catch {
        /* 后台活没等完也要删：这是尽力而为的排序，不是前置条件 */
      }
      // deleteThread 连消息与线程级工作记忆一起收（@mastra/memory 的行为）
      await memory.deleteThread(params.data.id)
      // 真删掉了才叫钩子（T18 的映射清理）；不存在的线程走的是幂等路径，不动映射
      options.onThreadDeleted?.(params.data.id)
    }
    // 不存在也回 ok：删除是幂等的，重试/双端点一次不该报错
    return context.json({ ok: true })
  })

  router.post('/:id/truncate', async (context) => {
    const params = threadIdParamsSchema.safeParse(context.req.param())
    if (!params.success) return context.json(badRequest('线程 id'), 400)
    const body = truncateThreadRequestSchema.safeParse(await context.req.json().catch(() => null))
    if (!body.success) return context.json(badRequest('messageId 不合法'), 400)

    if ((await findThread(memory, params.data.id)) === null) {
      return context.json({ deleted: 0 })
    }

    // hideSignals: false —— 截断要连信号/提醒类消息一起删，否则它们会留在可见历史之外
    const { messages } = await memory.recall({
      threadId: params.data.id,
      perPage: false,
      hideSignals: false
    })
    const index = messages.findIndex((message) => message.id === body.data.messageId)
    if (index === -1) return context.json({ deleted: 0 })

    const doomed = messages.slice(index).map((message) => message.id)
    await memory.deleteMessages(doomed)
    return context.json({ deleted: doomed.length })
  })

  router.post('/:id/title', async (context) => {
    const params = threadIdParamsSchema.safeParse(context.req.param())
    if (!params.success) return context.json(badRequest('线程 id'), 400)

    const thread = await findThread(memory, params.data.id)
    if (thread === null) return context.json({ error: 'not-found' }, 404)

    const existing = thread.title?.trim() ?? ''
    if (existing !== '') return context.json({ title: existing, generated: false })

    const { messages } = await memory.recall({ threadId: params.data.id, perPage: false })
    const firstUserText =
      messages
        .filter((message) => message.role === 'user')
        .map((message) => messageText(message))
        .find((text) => text !== '') ?? ''
    if (firstUserText === '') {
      // 没有可做素材的用户消息（例如只有系统消息）：不编造标题，也不标记 generated
      return context.json({ title: '', generated: false })
    }

    const { title } = await generateThreadTitle({
      memory,
      threadId: params.data.id,
      firstUserText,
      resolveModel: options.resolveModel
    })
    return context.json({ title, generated: true })
  })

  return router
}
