import { z } from './zod'

export const taskStatusSchema = z.enum(['pending', 'in_progress', 'done', 'blocked'])
export const taskIdSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((id) => id.trim().length > 0)
export const taskThreadIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((id) => id.trim().length > 0)
export const taskRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const titleSchema = z.string().trim().min(1).max(200)
const noteSchema = z.string().max(1000)

export const taskInputItemSchema = z
  .strictObject({
    id: taskIdSchema.optional(),
    title: titleSchema,
    status: taskStatusSchema,
    note: noteSchema.optional()
  })
  .refine((item) => item.status !== 'blocked' || Boolean(item.note?.trim()), {
    message: 'blocked 任务必须填写非空 note'
  })

export const taskChangeSchema = z
  .strictObject({
    id: taskIdSchema,
    title: titleSchema.optional(),
    status: taskStatusSchema.optional(),
    note: noteSchema.nullable().optional()
  })
  .refine(
    (change) =>
      change.title !== undefined || change.status !== undefined || change.note !== undefined,
    {
      message: 'update 不允许空变更'
    }
  )

function uniqueIds(items: Array<{ id?: string }>): boolean {
  const ids = items.flatMap((item) => (item.id === undefined ? [] : [item.id]))
  return new Set(ids).size === ids.length
}

export const taskReplaceSchema = z
  .strictObject({
    action: z.literal('replace'),
    expectedRevision: taskRevisionSchema,
    items: z.array(taskInputItemSchema).max(50)
  })
  .refine((input) => uniqueIds(input.items), { message: '任务 id 不得重复' })
  .refine((input) => input.items.filter((item) => item.status === 'in_progress').length <= 1, {
    message: '最多一个任务可为 in_progress'
  })

export const taskUpdateSchema = z
  .strictObject({
    action: z.literal('update'),
    expectedRevision: taskRevisionSchema,
    changes: z.array(taskChangeSchema).min(1).max(50)
  })
  .refine((input) => uniqueIds(input.changes), { message: '任务 id 不得重复' })

export const taskWriteSchema = z.discriminatedUnion('action', [taskReplaceSchema, taskUpdateSchema])
/**
 * todo 是唯一"顶层判别联合"的工具入参：zod 导出的 JSON Schema 顶层只有 oneOf、没有 type。
 * DeepSeek / OpenAI 官方端点在 function-calling 校验阶段要求 parameters 顶层是 `type: "object"`，
 * 否则整轮请求直接 400（`got 'type: null'`，见 agent-comparison run/code-task-1.json），
 * 而 todo 恒注入，于是任何一轮都发不出去。
 *
 * `.meta()` 只追加 JSON Schema 的元数据，不参与 parse：运行时仍是下面的判别联合
 * （每 action 字段互斥/必填、strictObject 拒未知键、任务 CAS 与错误文案都不变），
 * 模型侧则是一份合法的 object schema——oneOf 的三个分支原样保留，互斥与必填照旧可读。
 * 只补顶层 type，不碰 anyOf/oneOf 的其它位置（分支内的 anyOf 仍是可空字段的本来形状）。
 *
 * round 84：再补顶层 `properties`。LM Studio（llama.cpp 系）的入参校验要求
 * `parameters.properties` **必须存在且是对象**——判别联合导出时没有这个键，于是整轮 400
 * （实测：`invalid_type ... path [.., "properties"], message "Required"`，2026-10-15 内网复现）。
 *
 * 而且**不能给空对象**：LM Studio 会把这个 schema 编译成语法，`properties: {}` 等于"一个键都不许
 * 出现"，模型只能发出 `{}`（实测：调用成功但参数为空，运行时必被 zod 拒）。所以这里列出三个分支
 * 用到的**全部字段**（形状从宽，嵌套只给 `{type: "object"}`）——真正的约束仍在 oneOf 分支与
 * zod 运行时。字段集若变化，这里要跟着改；`tool-schema-compat.spec.ts` 会盯着"分支里出现的
 * 字段名必须都在顶层 properties 里"。
 */
const TODO_WIRE_PROPERTIES = {
  action: { type: 'string' },
  expectedRevision: { type: 'integer' },
  items: { type: 'array', items: { type: 'object' } },
  changes: { type: 'array', items: { type: 'object' } }
} as const

export const todoInputSchema = z
  .discriminatedUnion('action', [
    z.strictObject({ action: z.literal('get') }),
    taskReplaceSchema,
    taskUpdateSchema
  ])
  .meta({ type: 'object', properties: TODO_WIRE_PROPERTIES })

export const taskItemSchema = z
  .strictObject({
    id: taskIdSchema,
    title: titleSchema,
    status: taskStatusSchema,
    note: noteSchema.optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime()
  })
  .refine((item) => item.status !== 'blocked' || Boolean(item.note?.trim()), {
    message: 'blocked 任务必须填写非空 note'
  })

export const taskSnapshotSchema = z
  .strictObject({
    revision: taskRevisionSchema,
    items: z.array(taskItemSchema).max(50),
    updatedAt: z.iso.datetime().nullable()
  })
  .refine((snapshot) => uniqueIds(snapshot.items), { message: '任务 id 不得重复' })
  .refine(
    (snapshot) => snapshot.items.filter((item) => item.status === 'in_progress').length <= 1,
    {
      message: '最多一个任务可为 in_progress'
    }
  )

export const todoOutputSchema = z.strictObject({
  status: z.enum(['ok', 'conflict']),
  snapshot: taskSnapshotSchema
})

export const taskHistorySchema = z.strictObject({
  revisions: z.array(
    z.strictObject({
      origin: z.enum(['tool', 'user']),
      revision: taskRevisionSchema,
      snapshot: taskSnapshotSchema,
      messageId: z.string().min(1).optional(),
      toolCallId: z.string().min(1).optional(),
      createdAt: z.iso.datetime()
    })
  )
})

export type TaskHistory = z.infer<typeof taskHistorySchema>
export type TaskStatus = z.infer<typeof taskStatusSchema>
export type TaskItem = z.infer<typeof taskItemSchema>
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>
export type TaskWrite = z.infer<typeof taskWriteSchema>
export type TodoInput = z.infer<typeof todoInputSchema>
export type TodoOutput = z.infer<typeof todoOutputSchema>
