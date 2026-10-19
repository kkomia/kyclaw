// @vitest-environment node
/**
 * PB-034：**失败轮 reload 后消失**的投影修复（红→绿）。
 *
 * 现象（Nia `5e3f032`）：失败轮刷新/重开后消息列里一条都不剩（`messageCount=0`），成功轮正常。
 * 根因（Ada 取证）：失败发生在 DSH 的 `user/message` append **之前**，所以持久化 log 里没有
 * `user/message`；但那一轮的输入仍以 `agent/inbox/spliced.inserted` 落盘，失败原因在
 * `turn/end.reason`（`kind ∈ error|aborted|interrupted`）。宿主 `thread-projection` 目前只投影
 * surface（user/assistant/tool），把这两类事件丢掉了。
 *
 * 本 spec 用**合成事件**（不碰真内核、不读磁盘）钉住三件事：
 *   1. 失败轮且**没有** `user/message` → 从 inbox inserted 投影出 1 条 user 正文 + 失败元数据；
 *   2. 成功轮 / 已有 `user/message` 的轮 → **不重复**投影（去重）；
 *   3. `aborted` / `interrupted` 与 `error` 同待遇；`completed` 不算失败。
 */
import { describe, expect, it } from 'vitest'
import { projectThreadMessages } from '../thread-projection'
import type { KernelSessionEventLike } from '../../kernel/kernel-session-ops'

type Event = KernelSessionEventLike

const T0 = 1_792_400_000_000

function turnStart(turn: number, seq: number): Event {
  return { type: 'turn/start', seq, time: T0 + seq, data: { turn } }
}

function userText(text: string, id: string): Record<string, unknown> {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' }
  }
}

/** 内核 `agent/inbox/spliced`：inserted 是**完整 message 对象**数组（Ada 取证 §2.1） */
function inboxSplice(
  seq: number,
  inserted: Array<Record<string, unknown>>,
  target = 'next-turn'
): Event {
  return {
    type: 'agent/inbox/spliced',
    seq,
    time: T0 + seq,
    data: { target, inserted, removedCount: 0, outcome: 'applied' }
  }
}

function turnEnd(
  turn: number,
  seq: number,
  reason: Record<string, unknown> = { kind: 'completed' }
): Event {
  return { type: 'turn/end', seq, time: T0 + seq, data: { turn, reason } }
}

describe('PB-034 失败轮投影', () => {
  it('失败轮（无 user/message）→ 从 inbox inserted 恢复 1 条 user 正文 + 失败元数据', () => {
    const events: Event[] = [
      turnStart(1, 1),
      inboxSplice(2, [userText('帮我写个报告', 'u-failed-1')]),
      turnEnd(1, 3, { kind: 'error', error: { code: 'provider/unauthorized', message: '401 未授权' } })
    ]

    const messages = projectThreadMessages(events)

    expect(messages).toHaveLength(1)
    const [user] = messages
    expect(user?.id).toBe('u-failed-1')
    expect(user?.role).toBe('user')
    const content = user?.content as { parts?: Array<{ type: string; text?: string }> }
    expect(content.parts?.map((part) => part.text)).toEqual(['帮我写个报告'])
    // 失败元数据：来自 turn/end 的 reason，不伪造 kept/tokens 之类
    const metadata = (user?.content as { metadata?: Record<string, unknown> }).metadata
    expect(metadata?.['turnFailure']).toEqual({
      turn: 1,
      kind: 'error',
      code: 'provider/unauthorized',
      message: '401 未授权'
    })
  })

  it('aborted / interrupted 与 error 同待遇', () => {
    for (const kind of ['aborted', 'interrupted'] as const) {
      const events: Event[] = [
        turnStart(1, 1),
        inboxSplice(2, [userText(`内容-${kind}`, `u-${kind}`)]),
        turnEnd(1, 3, { kind })
      ]
      const messages = projectThreadMessages(events)
      expect(messages.map((message) => message.id)).toEqual([`u-${kind}`])
      const metadata = (messages[0]?.content as { metadata?: Record<string, unknown> }).metadata
      expect((metadata?.['turnFailure'] as { kind?: string } | undefined)?.kind).toBe(kind)
    }
  })

  it('已有可见 user/message 的轮：不重复投影正文，但**要**把 turnFailure 挂到该消息上', () => {
    const events: Event[] = [
      turnStart(1, 1),
      inboxSplice(2, [userText('已经落过 user/message 的那条', 'u-real')]),
      {
        type: 'user/message',
        seq: 3,
        time: T0 + 3,
        data: {
          id: 'u-real',
          role: 'user',
          content: [{ type: 'text', text: '已经落过 user/message 的那条' }],
          source: { kind: 'user' }
        },
        surfaceOp: 'append'
      },
      turnEnd(1, 4, { kind: 'error', error: { code: 'x', message: 'y' } })
    ]

    const messages = projectThreadMessages(events)
    // 正文不重复：仍然只有这一条
    expect(messages).toHaveLength(1)
    expect(messages[0]?.id).toBe('u-real')
    /**
     * PB-034 扩展（Nia 真机）：真内核的失败轮**总有**可见 user/message（重启后也读得到），
     * 若只在"没有 user/message"时才挂元数据，`TurnFailureCard` 在真机上永远不会出现。
     * 成功轮的 user 消息不带这个键（见下一条用例）。
     */
    expect((messages[0]?.content as { metadata?: { turnFailure?: unknown } }).metadata?.turnFailure)
      .toEqual({ turn: 1, kind: 'error', code: 'x', message: 'y' })
  })

  it('已有可见 user/message 的成功轮：不挂 turnFailure（completed 不算失败）', () => {
    const events: Event[] = [
      turnStart(1, 1),
      {
        type: 'user/message',
        seq: 2,
        time: T0 + 2,
        data: {
          id: 'u-ok',
          role: 'user',
          content: [{ type: 'text', text: '成功的轮' }],
          source: { kind: 'user' }
        },
        surfaceOp: 'append'
      },
      turnEnd(1, 3, { kind: 'completed' })
    ]

    const messages = projectThreadMessages(events)
    expect(messages).toHaveLength(1)
    expect((messages[0]?.content as { metadata?: unknown }).metadata).toBeUndefined()
  })

  it('幂等：同一失败轮的重复 turn/end（重放/重算）只挂一次 turnFailure', () => {
    const events: Event[] = [
      turnStart(1, 1),
      {
        type: 'user/message',
        seq: 2,
        time: T0 + 2,
        data: {
          id: 'u-dup',
          role: 'user',
          content: [{ type: 'text', text: '重复投影' }],
          source: { kind: 'user' }
        },
        surfaceOp: 'append'
      },
      turnEnd(1, 3, { kind: 'error', error: { code: 'boom', message: '炸了' } }),
      // 同一轮再来一条失败的 turn/end（模拟重放/重复事件）
      turnEnd(1, 3, { kind: 'error', error: { code: 'boom', message: '炸了' } })
    ]

    const messages = projectThreadMessages(events)
    expect(messages).toHaveLength(1)
    const metadata = (messages[0]?.content as { metadata?: { turnFailure?: unknown } }).metadata
    expect(Object.keys(metadata ?? {})).toEqual(['turnFailure'])
    expect(metadata?.turnFailure).toEqual({ turn: 1, kind: 'error', code: 'boom', message: '炸了' })
  })

  it('成功轮不补投影（completed 不算失败）', () => {
    const events: Event[] = [
      turnStart(1, 1),
      inboxSplice(2, [userText('排队但没发出去', 'u-queued')]),
      turnEnd(1, 3, { kind: 'completed' })
    ]
    expect(projectThreadMessages(events)).toEqual([])
  })

  it('多轮：只补失败轮，成功轮的上一条 user/message 不被重复', () => {
    const events: Event[] = [
      turnStart(1, 1),
      {
        type: 'user/message',
        seq: 2,
        time: T0 + 2,
        data: {
          id: 'u-ok',
          role: 'user',
          content: [{ type: 'text', text: '第一轮正常' }],
          source: { kind: 'user' }
        },
        surfaceOp: 'append'
      },
      turnEnd(1, 3, { kind: 'completed' }),
      turnStart(2, 4),
      inboxSplice(5, [userText('第二轮失败了', 'u-fail')]),
      turnEnd(2, 6, { kind: 'error', error: { code: 'net', message: '断网' } })
    ]

    const messages = projectThreadMessages(events)
    expect(messages.map((message) => message.id)).toEqual(['u-ok', 'u-fail'])
  })
})
