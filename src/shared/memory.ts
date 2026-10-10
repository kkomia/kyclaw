/**
 * 记忆契约（T14）：working memory 的查看 / 编辑 / 清空 —— agent 服务的 `/api/memory`
 * 路由与渲染端记忆页共用一处（边界纪律同线程/MCP：入参与回包都给 zod，两侧 parse）。
 *
 * 口径：应用只有一个用户（`LOCAL_USER_RESOURCE_ID`），working memory 走 **resource 作用域**
 * （Mastra 的缺省档，见 src/mastra/index.ts 的装配）：跨会话共享的一份长期画像。
 * `content` 为 null = 还没写过（或已被清空）——清空就是把内容写成空串，读回来归一成 null。
 */
import { z } from './zod'

/** GET /api/memory 的回包：当前记忆原文（null = 没有） */
export const workingMemoryResponseSchema = z.strictObject({
  content: z.string().nullable()
})

export type WorkingMemoryResponse = z.infer<typeof workingMemoryResponseSchema>

/**
 * PUT /api/memory 的入参：整块替换（模板口径是 replace 语义，不做合并）。
 * 上限 20000 字符：挡住手滑贴进来的巨型文本；空串 = 清空（与 DELETE 同效）。
 */
export const putWorkingMemoryRequestSchema = z.strictObject({
  content: z.string().max(20000)
})

/** DELETE /api/memory 的回包（清空是幂等的：本来就是空的也回 ok） */
export const clearMemoryResponseSchema = z.strictObject({ ok: z.literal(true) })
