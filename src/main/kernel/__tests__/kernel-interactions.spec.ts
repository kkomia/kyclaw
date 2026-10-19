// @vitest-environment node
/**
 * PB-025：`$events` 帧形状与回执参数形状（纯函数层）。
 *
 * 这里钉的是**取证结论**，不是"看起来对"：
 * - waterfall 帧收窄（ready/waterfall/emit），形状不对返回 null（不猜）；
 * - `$events/result` 的 args **就是** `{clientId, eventId, outcome}`——**不许再包一层 `{args:…}`**
 *   （包错时内核只回一句 `invalid Remote event result`，任何 outcome 形状都是同一句，极易误判）；
 * - 审批的 `outcome.value` = 裸四态字符串；提问的 `value` = `{answers:[{id,selected,custom?}]}`。
 */
import { describe, expect, it } from 'vitest'
import {
  APPROVAL_REQUEST_EVENT,
  REMOTE_EVENTS_ENDPOINT,
  REMOTE_EVENTS_RESULT_ENDPOINT,
  USER_QUESTIONS_REQUEST_EVENT,
  approvalResultArgs,
  interactionFromFrame,
  parseRemoteEventFrame,
  passResultArgs,
  questionResultArgs
} from '../kernel-interactions'

describe('$events 帧收窄', () => {
  it('ready 帧给出 clientId（回执要带）', () => {
    expect(parseRemoteEventFrame({ type: 'ready', clientId: 'c-1', host: {} })).toEqual({
      type: 'ready',
      clientId: 'c-1',
      host: {}
    })
    expect(parseRemoteEventFrame({ type: 'ready' })).toBeNull()
    expect(parseRemoteEventFrame({ type: 'ready', clientId: '' })).toBeNull()
  })

  it('waterfall 帧保留 event/eventId/agentId/request；缺字段返回 null', () => {
    const frame = {
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'e-1',
      agentId: 's-1',
      request: { toolName: 'bash' }
    }
    expect(parseRemoteEventFrame(frame)).toEqual(frame)
    expect(parseRemoteEventFrame({ ...frame, eventId: undefined })).toBeNull()
    expect(parseRemoteEventFrame({ ...frame, request: null })).toBeNull()
  })

  it('未知 type / 非对象 → null（不猜）', () => {
    expect(parseRemoteEventFrame({ type: 'nope' })).toBeNull()
    expect(parseRemoteEventFrame('ready')).toBeNull()
    expect(parseRemoteEventFrame(null)).toBeNull()
  })

  it('端点常量与取证一致', () => {
    expect(REMOTE_EVENTS_ENDPOINT).toBe('$events')
    expect(REMOTE_EVENTS_RESULT_ENDPOINT).toBe('$events/result')
    expect(APPROVAL_REQUEST_EVENT).toBe('approval/request')
    expect(USER_QUESTIONS_REQUEST_EVENT).toBe('user-questions/request')
  })
})

describe('waterfall → 我方交互事件', () => {
  it('审批：toolName/callId/reason 映射，threadId 取 agentId', () => {
    const frame = parseRemoteEventFrame({
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'e-1',
      agentId: 'session-1',
      request: { toolName: 'bash', callId: 'call-9', reason: '要写权限' }
    })
    expect(frame).not.toBeNull()
    expect(interactionFromFrame(frame!)).toEqual({
      kind: 'approval',
      eventId: 'e-1',
      threadId: 'session-1',
      toolName: 'bash',
      callId: 'call-9',
      reason: '要写权限'
    })
  })

  it('审批：没有工具名 → null（不伪造挂起项）', () => {
    const frame = parseRemoteEventFrame({
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'e-1',
      agentId: 'session-1',
      request: { reason: '没写工具名' }
    })
    expect(interactionFromFrame(frame!)).toBeNull()
  })

  it('提问：questions 映射（含 options/multiSelect），空问题 → null', () => {
    const frame = parseRemoteEventFrame({
      type: 'waterfall',
      event: 'user-questions/request',
      eventId: 'e-2',
      agentId: 'session-2',
      request: {
        questions: [
          {
            id: 'q1',
            question: '选 A 还是 B？',
            header: '选择',
            options: [{ label: 'A' }, { label: 'B', description: '乙' }],
            multiSelect: true
          }
        ]
      }
    })
    expect(interactionFromFrame(frame!)).toEqual({
      kind: 'question',
      eventId: 'e-2',
      threadId: 'session-2',
      questions: [
        {
          id: 'q1',
          question: '选 A 还是 B？',
          header: '选择',
          options: [{ label: 'A' }, { label: 'B', description: '乙' }],
          multiSelect: true
        }
      ]
    })
    const empty = parseRemoteEventFrame({
      type: 'waterfall',
      event: 'user-questions/request',
      eventId: 'e-3',
      agentId: 'session-2',
      request: { questions: [] }
    })
    expect(interactionFromFrame(empty!)).toBeNull()
  })
})

describe('$events/result 回执形状（钉死，别再套一层 args）', () => {
  it('审批回执：args 恰好三个键，outcome.value = 裸四态字符串', () => {
    const args = approvalResultArgs('c-1', 'e-1', 'allowed-once')
    expect(Object.keys(args).sort()).toEqual(['clientId', 'eventId', 'outcome'])
    expect(args).toEqual({
      clientId: 'c-1',
      eventId: 'e-1',
      outcome: { kind: 'result', value: 'allowed-once' }
    })
    // 红线：不能出现 args.args（那正是我们踩过的坑）
    expect('args' in args).toBe(false)
  })

  it('提问回执：value = {answers:[{id,selected,custom?}]}', () => {
    const args = questionResultArgs('c-1', 'e-2', {
      answers: [{ id: 'q1', selected: ['A'], custom: '其它' }]
    })
    expect(args).toEqual({
      clientId: 'c-1',
      eventId: 'e-2',
      outcome: {
        kind: 'result',
        value: { answers: [{ id: 'q1', selected: ['A'], custom: '其它' }] }
      }
    })
  })

  it('让出应答（next）：只有 kind，无 value', () => {
    expect(passResultArgs('c-1', 'e-1')).toEqual({
      clientId: 'c-1',
      eventId: 'e-1',
      outcome: { kind: 'next' }
    })
  })
})
