// @vitest-environment node
/**
 * PB-047（P0）：**重启后历史读不回**的宿主侧回归。
 *
 * 真因（Kai 读内核源码 + Nia 真机 RPC 双向确认）：
 *   - 内核 `session/page` 是 **cold-safe** 的（不激活 Agent，只要求持久化 header 有 cwd）；
 *   - `session/list` 同时收 attached 与 cold（cold 给 `agentAvailable:false`），且带
 *     `projections.asOfSeq`（可当 page 的 throughSeq）；
 *   - 旧 `reattach` 对冷会话走 `session/create` → 内核判"已存在且有 turn/start 不可复用"→
 *     **mint 新空会话**（cursor=2、无消息），宿主随后读的是这个新会话 → 历史"消失"。
 *
 * 本 spec 钉住宿主侧三条（不碰内核）：
 *   1. 无 live opening（拿不到 cursor）时，用 list 的 `projections.asOfSeq` 兜底读到历史；
 *      —— 修前这里是静默 `return []`（红态）。
 *   2. `asOfSeq` 是缓存水位：读完再取 list，水位前进要补读（不许停在旧值）；
 *   3. 会话存在但 live opening / asOfSeq 都没有 → **报错**（不许静默空）；会话不存在才回空。
 */
import { describe, expect, it } from 'vitest'
import {
  createKernelSessionOps,
  type KernelSessionEventLike,
  type KernelSessionSummary,
  type KernelSessionWire
} from '../../kernel/kernel-session-ops'

interface Call {
  method: string
  payload: Record<string, unknown>
}

function item(
  sessionId: string,
  options: { asOfSeq?: number; title?: string } = {}
): Record<string, unknown> {
  return {
    sessionId,
    blank: false,
    running: false,
    agentAvailable: false,
    formatStatus: 'current',
    ...(options.asOfSeq === undefined
      ? {}
      : { projections: { kind: 'cached', asOfSeq: options.asOfSeq } }),
    ...(options.title === undefined ? {} : { projections: { values: { title: options.title } } })
  }
}

function record(
  seq: number,
  type = 'user/message'
): { type: string; event: KernelSessionEventLike } {
  return { type: 'item', event: { type, seq, data: {} } }
}

function wireWith(
  handler: (method: string, payload: Record<string, unknown>) => unknown,
  calls: Call[] = []
): KernelSessionWire {
  return {
    rpc: async <T>(method: string, payload: Record<string, unknown>): Promise<T> => {
      calls.push({ method, payload })
      return handler(method, payload) as T
    }
  } as KernelSessionWire
}

describe('PB-047：冷会话（重启后）读历史', () => {
  it('无 live opening + list 有 asOfSeq → 用 asOfSeq 当 throughSeq 读到历史（修前静默空）', async () => {
    const calls: Call[] = []
    const ops = createKernelSessionOps(
      wireWith((method, payload) => {
        if (method === 'session/list') return { items: [item('cold-1', { asOfSeq: 21 })] }
        if (method === 'session/page') {
          return {
            records: [
              record(2, 'agent/inbox/spliced'),
              record(20, 'turn/start'),
              record(21, 'user/message')
            ],
            hasMore: false
          }
        }
        throw new Error(`unexpected ${method} ${JSON.stringify(payload)}`)
      }, calls),
      { openingOf: async () => ({}) } // 重启后没有 live follow：拿不到 cursor
    )

    const events = await ops.readEvents('cold-1')
    expect(events.map((event) => event.seq)).toEqual([2, 20, 21])
    const pages = calls.filter((call) => call.method === 'session/page')
    expect(pages[0]?.payload).toMatchObject({ request: { throughSeq: 21 } })
  })

  it('asOfSeq 是缓存水位：读完再取 list，水位前进就补读（防停在旧值）', async () => {
    let listCalls = 0
    const ops = createKernelSessionOps(
      wireWith((method, payload) => {
        if (method === 'session/list') {
          listCalls += 1
          return { items: [item('cold-2', { asOfSeq: listCalls === 1 ? 9 : 21 })] }
        }
        if (method === 'session/page') {
          const through = (payload.request as Record<string, unknown>).throughSeq as number
          const seqs = Array.from({ length: through - 1 }, (_v, index) => index + 2)
          return { records: seqs.map((seq) => record(seq)), hasMore: false }
        }
        throw new Error(`unexpected ${method}`)
      }),
      { openingOf: async () => ({}) }
    )

    const events = await ops.readEvents('cold-2')
    const seqs = events.map((event) => event.seq as number)
    // 首轮只到 9，补读后到 21；且按 seq 去重、有序
    expect(seqs.at(-1)).toBe(21)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
  })

  it('会话存在但 live opening / asOfSeq 都没有 → 报 session/history-unavailable（不许静默空）', async () => {
    const ops = createKernelSessionOps(
      wireWith((method) => {
        if (method === 'session/list') return { items: [item('cold-3')] } // 没有 projections.asOfSeq
        throw new Error(`unexpected ${method}`)
      }),
      { openingOf: async () => ({}) }
    )

    await expect(ops.readEvents('cold-3')).rejects.toMatchObject({
      code: 'session/history-unavailable'
    })
  })

  it('会话根本不存在（list 里没有）→ 回空，不报错、不建会话', async () => {
    const calls: Call[] = []
    const ops = createKernelSessionOps(
      wireWith((method) => {
        if (method === 'session/list') return { items: [] }
        throw new Error(`unexpected ${method}`)
      }, calls),
      {
        openingOf: async () => {
          throw new Error('should not be called for unknown thread')
        }
      }
    )

    await expect(ops.readEvents('nope')).resolves.toEqual([])
    // 没发过任何 create/page，也没问 opening
    expect(calls.map((call) => call.method)).toEqual(['session/list'])
  })

  it('list 的 asOfSeq 映射进 summary（类型契约）', async () => {
    const ops = createKernelSessionOps(
      wireWith((method) => {
        if (method === 'session/list') return { items: [item('a', { asOfSeq: 7 })] }
        throw new Error(`unexpected ${method}`)
      })
    )
    const list = (await ops.listSessions()) as KernelSessionSummary[]
    expect(list[0]?.asOfSeq).toBe(7)
  })
})
