// @vitest-environment node
/**
 * PB-004：交互中枢（审批四态 + 提问状态）与**文案归因红线**。
 *
 * 依据：gwen 设计 §3.1（状态归 main、切走不结束）、§4.1/4.2（状态表）、§4.4（文案规则）；
 * Ada 研究（四态来自 `approval/decided.outcome`；提问超时是 `pending`/`continued`，不是拒绝）。
 *
 * 这个 spec 钉死的三件事：
 * 1. 四态文案表 + **只有 rejected 能出现「你拒绝」**（unavailable/cancelled 出现即失败）；
 * 2. 审批生命周期（asked → decided 一次结算；重复 decided 不重复出结果）；
 * 3. 读快照/切会话**不会**结束任何挂起（没有"离开即拒绝"）；提问 `continued` 仍是"可答"。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_OUTCOMES,
  InteractionHub,
  answerContinued,
  applyInteractionEvent,
  approvalOutcomeCopy,
  feedKernelEvent,
  isApprovalOutcome,
  parseUserQuestions,
  respondAndDismiss
} from '../interaction-hub'

const FORBIDDEN_FOR_NON_REJECTED = ['你拒绝', '你拒绝了', '用户拒绝']

describe('审批四态文案（红线：归因必须准确）', () => {
  it('四态都有文案，且只有 rejected 归因给用户', () => {
    for (const outcome of APPROVAL_OUTCOMES) {
      const copy = approvalOutcomeCopy(outcome)
      expect(copy.title).not.toBe('')
      expect(copy.detail).not.toBe('')
      if (outcome === 'rejected' || outcome === 'allowed-once') {
        expect(copy.attribution).toBe('user')
      } else {
        expect(copy.attribution).toBe('system')
      }
    }
  })

  it('unavailable / cancelled **绝不**写成「你拒绝」（红线）', () => {
    for (const outcome of ['unavailable', 'cancelled'] as const) {
      const copy = approvalOutcomeCopy(outcome)
      const text = `${copy.title}${copy.detail}`
      for (const forbidden of FORBIDDEN_FOR_NON_REJECTED) expect(text).not.toContain(forbidden)
    }
    // unavailable 必须说清"不是你点的"+"没有执行"，并给重新发起
    const unavailable = approvalOutcomeCopy('unavailable')
    expect(unavailable.detail).toContain('这不是你点的')
    expect(unavailable.detail).toContain('没有执行')
    expect(unavailable.canRetry).toBe(true)
    // cancelled 说明可能原因（取消/断连/应用关闭）
    const cancelled = approvalOutcomeCopy('cancelled')
    expect(cancelled.detail).toContain('取消')
    expect(cancelled.detail).toContain('应用被关闭')
    expect(cancelled.canRetry).toBe(true)
  })

  it('只有 rejected 是「你拒绝了这次操作」', () => {
    expect(approvalOutcomeCopy('rejected').title).toBe('你拒绝了这次操作')
    const others = APPROVAL_OUTCOMES.filter((outcome) => outcome !== 'rejected')
    for (const outcome of others) expect(approvalOutcomeCopy(outcome).title).not.toContain('你拒绝')
  })

  it('内核词汇表只有四个（不自己造态）', () => {
    expect(APPROVAL_OUTCOMES).toEqual(['allowed-once', 'rejected', 'cancelled', 'unavailable'])
    expect(isApprovalOutcome('allowed-once')).toBe(true)
    expect(isApprovalOutcome('denied')).toBe(false)
  })
})

describe('审批生命周期（asked → decided，一次结算）', () => {
  it('asked 建挂起；decided 结算并出结果行；重复 decided 不重复', () => {
    const hub = new InteractionHub()
    const changed = vi.fn()
    hub.subscribe(changed)

    hub.applyApprovalAsked('thread-A', { id: 'ap-1', toolName: 'bash', callId: 'call-1' }, 10)
    expect(hub.hasPending('thread-A')).toBe(true)
    expect(hub.snapshot('thread-A').approvals.pending).toEqual([
      {
        threadId: 'thread-A',
        id: 'ap-1',
        source: 'asked',
        // PB-026 契约：asked 只有审计 id，不能应答
        respondable: false,
        actions: [],
        toolName: 'bash',
        callId: 'call-1',
        askedAtSeq: 10
      }
    ])

    const result = hub.applyApprovalDecided(
      'thread-A',
      { id: 'ap-1', outcome: 'unavailable' },
      12,
      1_700_000_000_123
    )
    expect(result?.outcome).toBe('unavailable')
    expect(result?.systemInitiated).toBe(true)
    // PB-026 契约：结果行要带 谁结束的 / 什么时候 / 为什么
    expect(result?.settledBy).toBe('system')
    expect(result?.at).toBe(1_700_000_000_123)
    expect(result?.decidedAtSeq).toBe(12)
    expect(hub.hasPending('thread-A')).toBe(false)
    expect(hub.snapshot('thread-A').approvals.results).toHaveLength(1)

    // 重复 decided：没有挂起了 → 不重复出结果、不抛
    expect(hub.applyApprovalDecided('thread-A', { id: 'ap-1', outcome: 'rejected' }, 13)).toBeNull()
    expect(hub.snapshot('thread-A').approvals.results).toHaveLength(1)
    expect(changed).toHaveBeenCalled()
  })

  it('读快照 / 切走再回来**不会**结束挂起（没有"离开即拒绝"）', () => {
    const hub = new InteractionHub()
    hub.applyApprovalAsked('thread-A', { id: 'ap-1', toolName: 'write' })
    for (let index = 0; index < 5; index += 1) hub.snapshot('thread-A')
    hub.snapshot('thread-B')
    expect(hub.hasPending('thread-A')).toBe(true)
    expect(hub.snapshot('thread-A').approvals.results).toHaveLength(0)
  })

  it('多 thread 互不影响；结果按 thread 隔离', () => {
    const hub = new InteractionHub()
    hub.applyApprovalAsked('thread-A', { id: 'a1', toolName: 'bash' })
    hub.applyApprovalAsked('thread-B', { id: 'b1', toolName: 'bash' })
    hub.applyApprovalDecided('thread-B', { id: 'b1', outcome: 'rejected' })
    expect(hub.hasPending('thread-A')).toBe(true)
    expect(hub.hasPending('thread-B')).toBe(false)
    expect(hub.snapshot('thread-A').approvals.results).toHaveLength(0)
    expect(hub.snapshot('thread-B').approvals.results[0]?.outcome).toBe('rejected')
  })

  it('历史结果按上限裁剪（不无限增长）', () => {
    const hub = new InteractionHub({ maxResultsPerThread: 2 })
    for (const id of ['x1', 'x2', 'x3']) {
      hub.applyApprovalAsked('thread-A', { id, toolName: 'bash' })
      hub.applyApprovalDecided('thread-A', { id, outcome: 'allowed-once' })
    }
    expect(hub.snapshot('thread-A').approvals.results.map((item) => item.id)).toEqual(['x2', 'x3'])
  })
})

describe('feedKernelEvent（内核事件 → hub）', () => {
  it('approval/asked + approval/decided 原样折叠；坏事件不崩、不伪造', () => {
    const hub = new InteractionHub()
    expect(
      feedKernelEvent(hub, 'thread-A', {
        type: 'approval/asked',
        seq: 3,
        data: { id: 'ap-1', toolName: 'bash', reason: '写文件需要授权' }
      })
    ).toBe(true)
    expect(
      feedKernelEvent(hub, 'thread-A', {
        type: 'approval/decided',
        seq: 4,
        time: 1_700_000_000_456,
        data: { id: 'ap-1', outcome: 'rejected' }
      })
    ).toBe(true)
    const result = hub.snapshot('thread-A').approvals.results[0]
    expect(result?.copy.title).toBe('你拒绝了这次操作')
    expect(result?.systemInitiated).toBe(false)
    // PB-026 契约：结果行带 谁结束的 / 什么时候 / 为什么（reason 从 asked 带过来）
    expect(result?.settledBy).toBe('user')
    expect(result?.at).toBe(1_700_000_000_456)
    expect(result?.reason).toBe('写文件需要授权')

    // 未知 outcome / 缺字段：不处理、不伪造
    expect(
      feedKernelEvent(hub, 'thread-A', {
        type: 'approval/asked',
        data: { id: 'ap-2', toolName: 'bash' }
      })
    ).toBe(true)
    expect(
      feedKernelEvent(hub, 'thread-A', {
        type: 'approval/decided',
        data: { id: 'ap-2', outcome: 'denied' }
      })
    ).toBe(false)
    expect(hub.hasPending('thread-A')).toBe(true)
    expect(feedKernelEvent(hub, 'thread-A', { type: 'turn/start' })).toBe(false)
  })
})

describe('提问状态（投影 userQuestions；超时/continued 不是拒绝）', () => {
  const projection = {
    active: [
      {
        callId: 'call-1',
        questions: [{ id: 'q1', question: '选哪个？', header: '选择' }],
        state: 'continued'
      }
    ],
    settled: [{ callId: 'call-0', answers: [{ id: 'q0', selected: ['A'] }] }]
  }

  it('open/continued/settled 原样映射；continued = 仍可答，不是拒绝', () => {
    const hub = new InteractionHub()
    hub.applyUserQuestionsProjection('thread-A', projection, { timed: true })
    const state = hub.snapshot('thread-A').askUser
    expect(state.timed).toBe(true)
    expect(state.active[0]?.state).toBe('continued')
    expect(state.active[0]?.questions[0]?.question).toBe('选哪个？')
    expect(state.settled[0]?.answers[0]?.selected).toEqual(['A'])
  })

  it('形状不对时不猜（返回 null / 保持空态）', () => {
    expect(parseUserQuestions(null)).toBeNull()
    expect(parseUserQuestions({ active: 'x', settled: [] })).toBeNull()
    const hub = new InteractionHub()
    hub.applyUserQuestionsProjection('thread-A', { nonsense: true })
    expect(hub.snapshot('thread-A').askUser).toEqual({ active: [], settled: [], timed: false })
  })
})

/**
 * PB-025 批次 2：`$events` waterfall → hub 接线，以及三种状态语义。
 *
 * 语义来源（一手，见 `bao/pb025-wire-forensics.md` §7.3）：关闭 `$events` 只是摘投递，
 * pending 会随新客户端重连**重新投递**；只有请求 signal 中止（应用退出/会话中止）才走 `cancelled`；
 * `unavailable` 是"没人答"的 fail-closed。→ 切会话/读快照/重连**都不得**改状态。
 */
describe('PB-025 waterfall → hub 接线', () => {
  const approvalFrame = {
    kind: 'approval' as const,
    eventId: 'evt-1',
    threadId: 'thread-A',
    toolName: 'pwsh',
    callId: 'call-1',
    reason: '要写 workspace 之外'
  }

  it('approval waterfall → 可应答挂起（source=waterfall，id=eventId，respondable=true）', () => {
    const hub = new InteractionHub()
    expect(applyInteractionEvent(hub, approvalFrame)).toBe(true)
    expect(hub.snapshot('thread-A').approvals.pending).toEqual([
      {
        threadId: 'thread-A',
        id: 'evt-1',
        source: 'waterfall',
        // PB-026 契约：UI 直接看 respondable/actions，不读 source
        respondable: true,
        actions: ['allow-once', 'reject'],
        toolName: 'pwsh',
        callId: 'call-1',
        reason: '要写 workspace 之外'
      }
    ])
  })

  it('应答成功才摘挂起；应答失败挂起必须留着（可重试）', async () => {
    const hub = new InteractionHub()
    applyInteractionEvent(hub, approvalFrame)
    const failing = { respondInteraction: () => Promise.reject(new Error('$events 流尚未就绪')) }
    await expect(
      respondAndDismiss(failing, hub, 'thread-A', {
        eventId: 'evt-1',
        kind: 'approval',
        outcome: 'rejected'
      })
    ).rejects.toThrow(/尚未就绪/u)
    expect(hub.hasPending('thread-A')).toBe(true)

    const sent: unknown[] = []
    const ok = {
      respondInteraction: (response: unknown) => {
        sent.push(response)
        return Promise.resolve()
      }
    }
    await respondAndDismiss(ok, hub, 'thread-A', {
      eventId: 'evt-1',
      kind: 'approval',
      outcome: 'allowed-once'
    })
    expect(sent).toEqual([{ eventId: 'evt-1', kind: 'approval', outcome: 'allowed-once' }])
    expect(hub.hasPending('thread-A')).toBe(false)
  })

  it('decided 关联：唯一挂起按 sole 关联；无挂起只出结果行（matchedBy none，不硬配工具名）', () => {
    const hub = new InteractionHub()
    applyInteractionEvent(hub, approvalFrame)
    const matched = hub.applyApprovalDecided('thread-A', { id: 'ap-x', outcome: 'rejected' }, 9)
    expect(matched?.matchedBy).toBe('sole')
    expect(matched?.toolName).toBe('pwsh')
    expect(matched?.callId).toBe('call-1')
    expect(hub.hasPending('thread-A')).toBe(false)

    const orphan = hub.applyApprovalDecided('thread-A', { id: 'ap-y', outcome: 'cancelled' }, 10)
    expect(orphan?.matchedBy).toBe('none')
    expect(orphan?.toolName).toBeUndefined()
    expect(orphan?.systemInitiated).toBe(true)
  })

  it('两个挂起项 + 无关 decided → 不猜（matchedBy none，两个挂起都留着）', () => {
    const hub = new InteractionHub()
    applyInteractionEvent(hub, { ...approvalFrame, eventId: 'evt-1' })
    applyInteractionEvent(hub, { ...approvalFrame, eventId: 'evt-2', callId: 'call-2' })
    const result = hub.applyApprovalDecided('thread-A', { id: 'ap-z', outcome: 'unavailable' }, 11)
    expect(result?.matchedBy).toBe('none')
    expect(hub.snapshot('thread-A').approvals.pending).toHaveLength(2)
  })

  it('提问 waterfall → 可应答提问挂起；作答后摘除', async () => {
    const hub = new InteractionHub()
    expect(
      applyInteractionEvent(hub, {
        kind: 'question',
        eventId: 'q-evt-1',
        threadId: 'thread-A',
        questions: [{ id: 'q1', question: '选 A 还是 B？', header: '选择' }]
      })
    ).toBe(true)
    const pending = hub.snapshot('thread-A').questions.pending
    expect(pending).toHaveLength(1)
    expect(pending[0]?.eventId).toBe('q-evt-1')
    expect(Number.isFinite(Date.parse(pending[0]?.suspendedAt ?? ''))).toBe(true)

    const sent: unknown[] = []
    await respondAndDismiss(
      {
        respondInteraction: (response: unknown) => {
          sent.push(response)
          return Promise.resolve()
        }
      },
      hub,
      'thread-A',
      { eventId: 'q-evt-1', kind: 'question', answer: { answers: [{ id: 'q1', selected: ['A'] }] } }
    )
    expect(sent).toHaveLength(1)
    expect(hub.snapshot('thread-A').questions.pending).toHaveLength(0)
  })

  it('continued 补答原样转给 adapter（返回内核 boolean，不摘投影状态）', async () => {
    const calls: Array<{ threadId: string; callId: string; answer: unknown }> = []
    const stillContinued = await answerContinued(
      {
        answerContinuedQuestion: (threadId, callId, answer) => {
          calls.push({ threadId, callId, answer })
          return Promise.resolve(true)
        }
      },
      'thread-A',
      'call-1',
      { answers: [{ id: 'q1', selected: ['A'], custom: '其它' }] }
    )
    expect(stillContinued).toBe(true)
    expect(calls).toEqual([
      {
        threadId: 'thread-A',
        callId: 'call-1',
        answer: { answers: [{ id: 'q1', selected: ['A'], custom: '其它' }] }
      }
    ])
  })
})

describe('PB-025 三种状态语义（切会话 ≠ 拒绝；应用退出 = cancelled）', () => {
  it('读快照/切会话/重连重投递：挂起项保持原样（不自动 deny）', () => {
    const hub = new InteractionHub()
    applyInteractionEvent(hub, {
      kind: 'approval',
      eventId: 'evt-1',
      threadId: 'thread-A',
      toolName: 'pwsh'
    })
    for (let index = 0; index < 3; index += 1) {
      hub.snapshot('thread-A')
      hub.snapshot('thread-B')
    }
    const pending = hub.snapshot('thread-A').approvals.pending
    expect(pending).toHaveLength(1)
    expect(pending[0]?.source).toBe('waterfall')
    expect(hub.snapshot('thread-A').approvals.results).toHaveLength(0)

    // 重连重投递：同一个 waterfall 事件再喂一次（新事件流），挂起项仍是一条（按 eventId 去重）
    applyInteractionEvent(hub, {
      kind: 'approval',
      eventId: 'evt-1',
      threadId: 'thread-A',
      toolName: 'pwsh'
    })
    expect(hub.snapshot('thread-A').approvals.pending).toHaveLength(1)
  })

  it('应用退出/会话中止 → cancelled：文案说"取消/可能因应用关闭"，不说「你拒绝」', () => {
    const copy = approvalOutcomeCopy('cancelled')
    expect(copy.title).toBe('这次审批已取消')
    expect(copy.detail).toContain('应用被关闭')
    expect(copy.attribution).toBe('system')
    expect(copy.canRetry).toBe(true)
    for (const forbidden of ['你拒绝', '你拒绝了'])
      expect(`${copy.title}${copy.detail}`).not.toContain(forbidden)
  })

  it('无应答者 fail-closed → unavailable：说"不是你点的"；三态标题互不相同', () => {
    const rejected = approvalOutcomeCopy('rejected')
    const cancelled = approvalOutcomeCopy('cancelled')
    const unavailable = approvalOutcomeCopy('unavailable')
    expect(rejected.title).toContain('你拒绝')
    expect(unavailable.detail).toContain('这不是你点的')
    expect(new Set([rejected.title, cancelled.title, unavailable.title]).size).toBe(3)
    expect(cancelled.title).not.toContain('你拒绝')
    expect(unavailable.title).not.toContain('你拒绝')
  })
})
