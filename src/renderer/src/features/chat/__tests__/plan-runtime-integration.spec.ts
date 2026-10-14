import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Chat } from '@ai-sdk/react'
import type { UIMessage } from 'ai'
import {
  rendererPlansStore,
  registerPlanChat,
  resetPlanRuntime,
  settledPlan,
  planWaiting
} from '../plan-runtime'
import { createMockTransport } from './mock-transport'
import type { SessionPlan } from '@shared/plan'

const api = vi.hoisted(() => ({
  get: vi.fn(),
  decision: vi.fn(),
  resumeRequest: vi.fn(),
  enter: vi.fn(),
  cancel: vi.fn()
}))
vi.mock('@renderer/lib/plans-api', async (original) => ({
  ...(await original<typeof import('@renderer/lib/plans-api')>()),
  plansApi: api
}))
beforeEach(() => {
  resetPlanRuntime()
  vi.clearAllMocks()
})
afterEach(() => vi.useRealTimers())
describe('Plan same Chat integration', () => {
  it('从未进入 Plan 的查询失败不永久锁普通会话', async () => {
    api.get.mockRejectedValueOnce(new Error('state unavailable'))
    await expect(rendererPlansStore.getState().load('unused')).rejects.toThrow('unavailable')
    expect(planWaiting('unused')).toBe(false)
    expect(rendererPlansStore.getState().sessions.unused?.error).toBe('state unavailable')
    rendererPlansStore.getState().forget('unused')
  })
  it('busy 永不结束时停止等待有明确超时且解除订阅', async () => {
    vi.useFakeTimers()
    rendererPlansStore.setState({
      sessions: { stuck: { state: null, ref: null, busy: true, error: null, feedback: '' } }
    })
    const waiting = settledPlan('stuck')
    const assertion = expect(waiting).rejects.toThrow('停止未确认')
    await vi.advanceTimersByTimeAsync(15_000)
    await assertion
    rendererPlansStore.getState().forget('stuck')
  })

  it('决定成功读取新 ref，再恢复同一 Chat，不追加用户消息', async () => {
    const state: SessionPlan = {
      threadId: 'thread',
      version: 1,
      mode: 'awaiting_approval',
      planId: 'plan',
      revision: 1,
      body: '计划',
      feedback: null,
      approval: null,
      updatedAt: '2026-10-14T00:00:00Z'
    }
    const ref = { planId: 'plan', revision: 1, version: 1 }
    api.get.mockResolvedValue({ state, ref })
    const control = createMockTransport()
    const chat = new Chat<UIMessage>({
      transport: control.transport,
      messages: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: '工作' }] }]
    })
    registerPlanChat('thread', chat)
    await rendererPlansStore.getState().load('thread')
    const approved = { ...state, version: 2, approval: { runId: 'run', toolCallId: 'submit' } }
    const nextRef = { ...ref, version: 2 }
    api.decision.mockResolvedValue({ state: approved, ref: nextRef })
    await rendererPlansStore.getState().approve('thread', ref)
    api.resumeRequest.mockResolvedValue({
      url: 'http://localhost/plans/resume',
      init: {
        method: 'POST',
        headers: {},
        body: JSON.stringify({ threadId: 'thread', ref: nextRef })
      }
    })
    const resume = rendererPlansStore.getState().resume('thread', nextRef)
    await vi.waitFor(() => expect(control.requests).toHaveLength(1))
    expect(control.requests[0].body).toEqual({ planResume: { threadId: 'thread', ref: nextRef } })
    expect(control.requests[0].messages.filter((message) => message.role === 'user')).toHaveLength(
      1
    )
    api.get.mockResolvedValue({ state: { ...approved, mode: 'executing' }, ref: nextRef })
    control.finish()
    await resume
    expect(rendererPlansStore.getState().sessions.thread?.busy).toBe(false)
  })
})
