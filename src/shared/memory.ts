/**
 * 记忆契约（T14）：working memory 的查看 / 编辑 / 清空 —— agent 服务的 `/api/memory`
 * 路由与渲染端记忆页共用一处（边界纪律同线程/MCP：入参与回包都给 zod，两侧 parse）。
 *
 * 口径：应用只有一个用户（`LOCAL_USER_RESOURCE_ID`），working memory 走 **thread 作用域**
 * （round 58 从 resource 改过来，见 src/mastra/index.ts 的装配）：**一个会话一份** —— 每个接口
 * 都带 `threadId`（缺/空 400），看/写/清的都是那一个会话的画像。用户口径：开几个会话就是为了
 * 隔离上下文，跨会话共享不再做（库里旧的 resource 画像留在原处，改后不再被读）。
 * `content` 为 null = 还没写过（或已被清空）——清空就是把内容写成空串，读回来归一成 null。
 *
 * round 28 模块 3 起多一条 `recallStatusSchema`：**语义召回**（长期记忆的另一半）的
 * 本次运行状态。两份记忆不是一回事：画像是助手维护的结构化字段（每会话一份），语义召回是
 * 把本会话早先相关的**原始消息**找回来（同样 thread 作用域，见 mastra/embedding.ts）。
 */
import { z } from './zod'
import { SEMANTIC_RECALL_SOURCES } from './settings'

/** GET /api/memory?threadId=… 的回包：该会话的记忆原文（null = 没有） */
export const workingMemoryResponseSchema = z.strictObject({
  content: z.string().nullable()
})

export type WorkingMemoryResponse = z.infer<typeof workingMemoryResponseSchema>

/**
 * PUT /api/memory?threadId=… 的入参：整块替换（模板口径是 replace 语义，不做合并）。
 * 上限 20000 字符：挡住手滑贴进来的巨型文本；空串 = 清空（与 DELETE 同效）。
 */
export const putWorkingMemoryRequestSchema = z.strictObject({
  content: z.string().max(20000)
})

/** DELETE /api/memory?threadId=… 的回包（清空是幂等的：本来就是空的也回 ok） */
export const clearMemoryResponseSchema = z.strictObject({ ok: z.literal(true) })

/**
 * 语义召回（长期记忆）的**本次运行状态**（GET /api/memory/recall）：
 * 设置里的开关（`enabled`）与"这次启动真的挂上了没有"（`active`）是两件事——
 * 用户改了开关要重启才生效，状态行必须说清是哪一种，别编造当前会话没发生的事（同「追踪」栏口径）。
 *
 *   - `active`      = 本次运行开着（`detail` 里说来源）；
 *   - `off`         = 设置里关着；
 *   - `preparing`   = 本地引擎正在准备（模块 3B 会用；这一版不会出现）；
 *   - `ready`       = 本地引擎已就绪、等重启（同上，3B 的）；
 *   - `unavailable` = 起不来（`detail` 是人话原因：配置半截 / 服务不通 / 启动自检没过）。
 *
 * `detail` 是给人看的一句话，**不含密钥、不含堆栈**（堆栈只进主进程日志）。
 */
export const recallStatusSchema = z.strictObject({
  state: z.enum(['active', 'off', 'preparing', 'ready', 'unavailable']),
  /** 本次运行真的开了召回（Memory 挂上了 embedder + vector） */
  active: z.boolean(),
  /** 设置里的开关（开了但没起得来 = active:false） */
  enabled: z.boolean(),
  /** 嵌入来源（与设置的 `source` 同枚举；3B 加 `localEngine` 时两处一起加） */
  source: z.enum(SEMANTIC_RECALL_SOURCES),
  detail: z.string()
})

export type RecallStatus = z.infer<typeof recallStatusSchema>

/** GET /api/memory/recall 的回包 */
export const recallStatusResponseSchema = z.strictObject({ recall: recallStatusSchema })

export type RecallStatusResponse = z.infer<typeof recallStatusResponseSchema>

/**
 * 嵌入服务的 API Key 在 secrets.json 里的槽位 id：与 provider 密钥同一套 safeStorage 通道
 * （`setProviderKey` / `getProviderKey` 的 id 参数），但它不是任何 provider —— 值的语义是
 * "语义召回那一栏填的 key"（将来 3B 的本机引擎不需要 key，这条通道只服务 OpenAI 兼容服务）。
 * 写：`memory:set-embedding-key`（main/ipc/memory.ts）；读：只在主进程装配时解一次
 * （main/index.ts → mastra/embedding.ts），明文不回渲染端、不进日志。
 */
export const EMBEDDING_KEY_SECRET_ID = 'semantic-recall-embedding'
