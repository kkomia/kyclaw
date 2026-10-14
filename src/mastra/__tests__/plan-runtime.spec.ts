// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LibSQLStore } from '@mastra/libsql'
import { expect, it, vi } from 'vitest'
import { createSessionPlanStore } from '../session-plan'
import {
  createPlanRuntime,
  planRefOf,
  type PlanCoordinator,
  type PlanSuspension
} from '../plan-runtime'

it('uses server suspension bindings, consumes decisions once and cancels before resetting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-runtime-'))
  const storage = new LibSQLStore({
    id: 'plan-runtime',
    url: `file:${join(dir, 'app.db').replace(/\\/g, '/')}`
  })
  const store = createSessionPlanStore(storage)
  const order: string[] = []
  let targets: PlanSuspension[] = []
  const release = vi.fn()
  const coordinator: PlanCoordinator = {
    assertThread: async (thread) => {
      if (thread !== 't') throw new Error('foreign-thread')
    },
    listSuspended: async () => targets,
    claimSuspend: async (threadId, runId, toolCallId) => {
      const target = targets.find(
        (item) =>
          item.threadId === threadId && item.runId === runId && item.toolCallId === toolCallId
      )
      if (!target) throw new Error('stale')
      return { target, release, bindStop: vi.fn() }
    },
    withIdleThread: async (_threadId, operation) => operation(),
    withThreadChange: async (operationThread, operation) => {
      expect(operationThread).toBe('t')
      order.push('stopped-and-snapshots-deleted')
      targets = []
      return operation()
    }
  }
  const runtime = createPlanRuntime({
    store,
    coordinator,
    resume: async () =>
      new ReadableStream({
        start(controller) {
          controller.close()
        }
      })
  })
  try {
    const initial = await store.initialize('t')
    const planning = await runtime.enter('t', initial.version)
    const submitted = await runtime.submit(
      { threadId: 't', runId: 'server-run' },
      { ...planRefOf(planning), body: 'plan' }
    )
    targets = [
      {
        threadId: 't',
        runId: 'server-run',
        toolCallId: 'submit-call',
        toolName: 'submit_plan',
        suspendPayload: planRefOf(submitted)
      }
    ]
    await expect(runtime.decision('foreign', planRefOf(submitted), 'approve')).rejects.toThrow()
    const approved = await runtime.decision('t', planRefOf(submitted), 'approve')
    expect(approved.approval).toEqual({ runId: 'server-run', toolCallId: 'submit-call' })
    await expect(
      runtime.resumeSubmit({ threadId: 't', runId: 'fake' }, 'submit-call', {
        ...planRefOf(planning),
        body: 'plan'
      })
    ).rejects.toThrow()
    const consumed = await runtime.resumeSubmit(
      { threadId: 't', runId: 'server-run' },
      'submit-call',
      { ...planRefOf(planning), body: 'plan' }
    )
    expect(consumed.status).toBe('approved')
    await expect(
      runtime.resumeSubmit({ threadId: 't', runId: 'server-run' }, 'submit-call', {
        ...planRefOf(planning),
        body: 'plan'
      })
    ).rejects.toThrow()
    const reset = await runtime.cancel('t', consumed.state.version)
    order.push(reset.mode)
    expect(order).toEqual(['stopped-and-snapshots-deleted', 'normal'])
    const second = await runtime.enter('t', reset.version)
    const next = await runtime.submit(
      { threadId: 't', runId: 'r2' },
      { ...planRefOf(second), body: 'new plan' }
    )
    targets = [
      {
        threadId: 't',
        runId: 'r2',
        toolCallId: 'c2',
        toolName: 'submit_plan',
        suspendPayload: planRefOf(next)
      }
    ]
    const revised = await runtime.decision('t', planRefOf(next), 'revise', 'smaller')
    expect(revised.mode).toBe('planning')
    const reopened = createPlanRuntime({
      store: createSessionPlanStore(storage),
      coordinator,
      resume: async () => new ReadableStream()
    })
    const result = await reopened.resumeSubmit({ threadId: 't', runId: 'r2' }, 'c2', {
      ...planRefOf(second),
      body: 'new plan'
    })
    expect(result.feedback).toBe('smaller')
    await expect(
      reopened.resumeSubmit({ threadId: 't', runId: 'r2' }, 'c2', {
        ...planRefOf(second),
        body: 'new plan'
      })
    ).rejects.toThrow()
  } finally {
    await storage.close()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      console.warn('plan runtime cleanup deferred', error)
    }
  }
})
