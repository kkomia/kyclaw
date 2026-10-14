import { describe, expect, it } from 'vitest'
import { z } from '../zod'
import { todoInputSchema, taskSnapshotSchema } from '../tasks'

interface JsonSchemaNode {
  $schema?: unknown
  type?: unknown
  oneOf?: JsonSchemaNode[]
  required?: string[]
  properties?: Record<string, JsonSchemaNode>
  items?: JsonSchemaNode
}

describe('任务冻结契约', () => {
  it('支持 get、显式清空和 title trim', () => {
    expect(todoInputSchema.parse({ action: 'get' })).toEqual({ action: 'get' })
    expect(
      todoInputSchema.parse({ action: 'replace', expectedRevision: 0, items: [] })
    ).toMatchObject({ items: [] })
    const parsed = todoInputSchema.parse({
      action: 'replace',
      expectedRevision: 0,
      items: [{ title: '  一项  ', status: 'pending' }]
    })
    expect(parsed.action === 'replace' && parsed.items[0].title).toBe('一项')
  })

  it.each([
    { action: 'get', threadId: '模型伪造身份' },
    { action: 'replace', items: [] },
    { action: 'replace', expectedRevision: -1, items: [] },
    { action: 'replace', expectedRevision: 0.5, items: [] },
    { action: 'replace', expectedRevision: 0, items: [{ title: ' ', status: 'pending' }] },
    {
      action: 'replace',
      expectedRevision: 0,
      items: [{ title: 'x'.repeat(201), status: 'pending' }]
    },
    {
      action: 'replace',
      expectedRevision: 0,
      items: [{ title: 'x', status: 'blocked', note: ' ' }]
    },
    {
      action: 'replace',
      expectedRevision: 0,
      items: [{ title: 'x', status: 'pending', note: 'x'.repeat(1001) }]
    },
    {
      action: 'replace',
      expectedRevision: 0,
      items: [{ id: 'x'.repeat(101), title: 'x', status: 'pending' }]
    },
    {
      action: 'replace',
      expectedRevision: 0,
      items: Array.from({ length: 51 }, () => ({ title: 'x', status: 'pending' }))
    },
    {
      action: 'replace',
      expectedRevision: 0,
      items: [
        { id: 'a', title: 'x', status: 'pending' },
        { id: 'a', title: 'y', status: 'done' }
      ]
    },
    {
      action: 'replace',
      expectedRevision: 0,
      items: [
        { title: 'x', status: 'in_progress' },
        { title: 'y', status: 'in_progress' }
      ]
    },
    { action: 'update', expectedRevision: 0, changes: [] },
    { action: 'update', expectedRevision: 0, changes: [{ id: 'a' }] },
    {
      action: 'update',
      expectedRevision: 0,
      changes: [
        { id: 'a', title: 'x' },
        { id: 'a', status: 'done' }
      ]
    }
  ])('拒绝非法入参 %#', (input) => {
    expect(todoInputSchema.safeParse(input).success).toBe(false)
  })

  it.each([
    { action: 'get' },
    { action: 'replace', expectedRevision: 0, items: [] },
    { action: 'update', expectedRevision: 3, changes: [{ id: 'a', status: 'done' }] }
  ])('每个 action 分支接受自己的合法入参 %#', (input) => {
    expect(todoInputSchema.safeParse(input).success).toBe(true)
  })

  it.each([
    { action: 'get', expectedRevision: 0 },
    { action: 'get', items: [] },
    { action: 'get', changes: [{ id: 'a' }] },
    { action: 'replace', expectedRevision: 0 },
    { action: 'replace', items: [] },
    { action: 'replace', expectedRevision: 0, items: [], changes: [{ id: 'a' }] },
    { action: 'update', expectedRevision: 0 },
    { action: 'update', changes: [{ id: 'a' }] },
    { action: 'update', expectedRevision: 0, changes: [{ id: 'a' }], items: [] },
    { action: 'archive' },
    {}
  ])('仍拒绝跨 action 字段混用与非法入参 %#', (input) => {
    expect(todoInputSchema.safeParse(input).success).toBe(false)
  })

  it('导出给 provider 的 JSON Schema 顶层是 object，oneOf 分支原样保留', () => {
    const schema = z.toJSONSchema(todoInputSchema, {
      target: 'draft-7',
      io: 'input'
    }) as JsonSchemaNode

    // DeepSeek / OpenAI 官方端点要求 function 的 parameters 顶层 type 为 object，
    // 判别联合只导出 oneOf，缺的就是这一个 type（见 agent-comparison run/code-task-1.json）
    expect(schema.type).toBe('object')
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#')
    expect(Object.keys(schema).sort()).toEqual(['$schema', 'oneOf', 'type'])
    expect(schema.oneOf?.map((branch) => branch.required)).toEqual([
      ['action'],
      ['action', 'expectedRevision', 'items'],
      ['action', 'expectedRevision', 'changes']
    ])
    // 只补顶层 type：分支内可空字段的 anyOf 无 type 是本来形状，不许被泛化改写
    const updateBranch = schema.oneOf?.[2]
    expect(updateBranch?.properties?.changes?.items?.properties).toEqual({
      id: {
        type: 'string',
        minLength: 1,
        maxLength: 100
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 200
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'done', 'blocked']
      },
      note: {
        anyOf: [
          {
            type: 'string',
            maxLength: 1000
          },
          {
            type: 'null'
          }
        ]
      }
    })
  })

  it('快照强制完整服务端时间和阻塞理由', () => {
    expect(taskSnapshotSchema.safeParse({ revision: 0, items: [], updatedAt: null }).success).toBe(
      true
    )
    expect(
      taskSnapshotSchema.safeParse({
        revision: 1,
        items: [{ id: 'a', title: 'x', status: 'pending' }],
        updatedAt: null
      }).success
    ).toBe(false)
  })
})
