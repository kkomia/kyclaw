// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  createKernelSessionOps,
  createKernelSessionOpsForAdapter,
  kernelSessionWireFromAdapter,
  type KernelSessionAdapter,
  type KernelSessionWire
} from '../../kernel/kernel-session-ops'

interface Call {
  method: string
  payload: Record<string, unknown>
}

function wireWith(
  handler: (method: string, payload: Record<string, unknown>) => unknown,
  calls: Call[] = []
): KernelSessionWire {
  return {
    async rpc<T>(method: string, payload: Record<string, unknown>): Promise<T> {
      calls.push({ method, payload })
      return (await handler(method, payload)) as T
    }
  }
}

const item = (
  sessionId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  sessionId,
  updatedAt: 1_700_000_000_000,
  running: false,
  blank: false,
  ...overrides
})

describe('kernel-session-ops：list-first create / page / archive / compact', () => {
  it('listSessions 映射 title 投影与 updatedAt', async () => {
    const ops = createKernelSessionOps(
      wireWith((method) => {
        expect(method).toBe('session/list')
        return {
          items: [
            item('a', { projections: { values: { title: '标题 A' } } }),
            item('b', { projections: { values: { title: null } } })
          ]
        }
      })
    )
    await expect(ops.listSessions()).resolves.toEqual([
      expect.objectContaining({ sessionId: 'a', title: '标题 A', updatedAt: 1_700_000_000_000 }),
      expect.objectContaining({ sessionId: 'b', title: null })
    ])
  })

  it('createSession 已存在：直接回现况，不再调用 session/create', async () => {
    const calls: Call[] = []
    const ops = createKernelSessionOps(
      wireWith(
        () => ({ items: [item('t1', { projections: { values: { title: '旧标题' } } })] }),
        calls
      )
    )
    const result = await ops.createSession({ threadId: 't1', cwd: '/workspace' })
    expect(result.created).toBe(false)
    expect(result.session).toMatchObject({ sessionId: 't1', title: '旧标题' })
    expect(calls.map((call) => call.method)).toEqual(['session/list'])
  })

  it('createSession 不存在：session/create 后按 title 调 rename，并重新 list', async () => {
    const calls: Call[] = []
    let listCount = 0
    const ops = createKernelSessionOps(
      wireWith((method, payload) => {
        if (method === 'session/list') {
          listCount += 1
          return {
            items:
              listCount === 1
                ? []
                : [item('t2', { projections: { values: { title: '草稿标题' } } })]
          }
        }
        if (method === 'session/create') {
          expect(payload).toMatchObject({ request: { sessionId: 't2', cwd: '/workspace' } })
          return { sessionId: 't2' }
        }
        if (method === 'session/rename') {
          expect(payload).toMatchObject({ request: { sessionId: 't2', title: '草稿标题' } })
          return { title: '草稿标题', seq: 1 }
        }
        throw new Error(`unexpected ${method}`)
      }, calls)
    )
    const result = await ops.createSession({
      threadId: 't2',
      cwd: '/workspace',
      title: '草稿标题'
    })
    expect(result.created).toBe(true)
    expect(result.session).toMatchObject({ sessionId: 't2', title: '草稿标题' })
    expect(calls.map((call) => call.method)).toEqual([
      'session/list',
      'session/create',
      'session/rename',
      'session/list'
    ])
  })

  it('createSession 返回不同 id：抛 session/conflict（不静默改 threadId）', async () => {
    const ops = createKernelSessionOps(
      wireWith((method) => {
        if (method === 'session/list') return { items: [] }
        if (method === 'session/create') return { sessionId: 'minted' }
        throw new Error(`unexpected ${method}`)
      })
    )
    await expect(
      ops.createSession({ threadId: 'wanted', cwd: '/workspace' })
    ).rejects.toMatchObject({
      code: 'session/conflict'
    })
  })

  it('readEvents：先 list 确认存在，再用 opening cursor 翻页（R1）', async () => {
    const calls: Call[] = []
    const ops = createKernelSessionOps(
      wireWith((method, payload) => {
        if (method === 'session/list') return { items: [item('t1')] }
        if (method === 'session/page') {
          const before = (payload.request as Record<string, unknown>).beforeSeq
          return before === undefined
            ? {
                records: [{ type: 'event', event: { type: 'assistant/message', seq: 4 } }],
                hasMore: true
              }
            : {
                records: [{ type: 'event', event: { type: 'user/message', seq: 1 } }],
                hasMore: false
              }
        }
        throw new Error(`unexpected ${method}`)
      }, calls),
      { openingOf: async () => ({ cursor: 4 }) }
    )
    const events = await ops.readEvents('t1')
    expect(events.map((event) => event.seq)).toEqual([1, 4])
    const pages = calls.filter((call) => call.method === 'session/page')
    expect(pages).toHaveLength(2)
    expect(pages[0]?.payload).toMatchObject({ request: { throughSeq: 4 } })
    expect(pages[1]?.payload).toMatchObject({ request: { beforeSeq: 4 } })
  })

  it('readEvents：不存在的 session 返回空，不触发 opening/create', async () => {
    const ops = createKernelSessionOps(
      wireWith((method) => {
        if (method === 'session/list') return { items: [] }
        throw new Error(`unexpected ${method}`)
      })
    )
    await expect(ops.readEvents('missing')).resolves.toEqual([])
  })

  it('archiveSession 走 workspace/archiveSession，stopActivity=true', async () => {
    const calls: Call[] = []
    const ops = createKernelSessionOps(wireWith(() => ({ archivedSessionIds: ['t1'] }), calls))
    await ops.archiveSession('t1')
    expect(calls[0]).toMatchObject({
      method: 'workspace/archiveSession',
      payload: { request: { sessionId: 't1', stopActivity: true } }
    })
  })

  it('compact 把 /compact 命令结果翻译成 compacted（No compactable → false）', async () => {
    const empty = createKernelSessionOps(
      wireWith(() => ({})),
      {
        executeCommand: async () => ({
          commandId: 'c1',
          result: { kind: 'success', text: 'No compactable history yet.' }
        })
      }
    )
    await expect(empty.compact('t1')).resolves.toMatchObject({ compacted: false })

    const done = createKernelSessionOps(
      wireWith(() => ({})),
      {
        executeCommand: async () => ({
          commandId: 'c2',
          result: { kind: 'success', text: 'Compacted 3 history items.' }
        })
      }
    )
    await expect(done.compact('t1')).resolves.toMatchObject({ compacted: true })
  })

  it('compact 无 executeCommand deps：走 raw commands/execute（不经过 adapter 的 cwd 物化）', async () => {
    const calls: Call[] = []
    const ops = createKernelSessionOps(
      wireWith((method, payload) => {
        expect(method).toBe('commands/execute')
        expect(payload).toMatchObject({
          agentId: 't1',
          line: '/compact',
          submittedAttachments: []
        })
        return {
          commandId: 'raw',
          result: { kind: 'success', text: 'No compactable history yet.' }
        }
      }, calls)
    )
    await expect(ops.compact('t1')).resolves.toMatchObject({ compacted: false })
    expect(calls.map((call) => call.method)).toEqual(['commands/execute'])
  })

  it('接线版：wire 透传 rpcCall，adapter helper 走 raw commands/execute', async () => {
    const calls: Array<{ method: string; payload: unknown }> = []
    const adapter: KernelSessionAdapter = {
      async rpcCall<T>(method: string, payload?: unknown): Promise<T> {
        calls.push({ method, payload })
        if (method === 'session/list') return { items: [item('t1')] } as T
        if (method === 'session/page') {
          return {
            records: [{ type: 'event', event: { type: 'user/message', seq: 0 } }],
            hasMore: false
          } as T
        }
        if (method === 'commands/execute') {
          return {
            commandId: 'c',
            result: { kind: 'success', text: 'Compacted' }
          } as T
        }
        return {} as T
      },
      async reattach() {
        return { cursor: 0 }
      }
    }
    const wire = kernelSessionWireFromAdapter(adapter)
    await expect(wire.rpc('session/list', { _request: {} })).resolves.toBeDefined()
    expect(calls[0]).toMatchObject({ method: 'session/list', payload: { _request: {} } })

    const ops = createKernelSessionOpsForAdapter(adapter)
    await expect(ops.readEvents('t1')).resolves.toHaveLength(1)
    await expect(ops.compact('t1')).resolves.toMatchObject({ compacted: true })
  })
})
