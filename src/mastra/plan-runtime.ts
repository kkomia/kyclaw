import { randomUUID } from 'node:crypto'
import { RequestContext } from '@mastra/core/request-context'
import type { StreamLease } from './ask-user-runtime'
import { ownStream } from './stream-lifecycle'
import { createPlanGuard, type PlanRunIdentity } from './plan-guard'
import type { SessionPlanStore } from './session-plan'
import {
  planBodySchema,
  planRefSchema,
  planThreadIdSchema,
  type PlanBinding,
  type PlanRef,
  type SessionPlan,
  type SubmitPlan
} from '../shared/plan'

export interface PlanSuspension extends PlanBinding {
  threadId: string
  toolName: 'submit_plan'
  suspendPayload: PlanRef
}
export interface PlanCoordinator {
  assertThread(threadId: string): Promise<void>
  listSuspended(threadId: string): Promise<readonly PlanSuspension[]>
  claimSuspend(
    threadId: string,
    runId: string,
    toolCallId: string,
    toolName: 'submit_plan'
  ): Promise<StreamLease & { target: PlanSuspension }>
  withThreadChange<T>(threadId: string, operation: () => Promise<T>): Promise<T>
  withIdleThread?<T>(threadId: string, operation: () => Promise<T>): Promise<T>
}
export interface PlanRuntimeOptions {
  store: SessionPlanStore
  coordinator: PlanCoordinator
  resume(
    input: PlanBinding & {
      threadId: string
      resumeData: { type: 'server-plan-decision' }
      requestContext: RequestContext
    }
  ): Promise<ReadableStream<unknown>>
}
export interface PlanRuntimeHandle {
  prepareRequest(
    threadId: string,
    runId?: string,
    requestContext?: RequestContext
  ): { requestContext: RequestContext; runId: string }
  identityOf(context: RequestContext | undefined): PlanRunIdentity
  guardFor(requestContext: RequestContext): ReturnType<typeof createPlanGuard>
  state(thread: string): Promise<SessionPlan>
  enter(threadId: string, expectedVersion: number): Promise<SessionPlan>
  submit(identity: PlanRunIdentity, input: SubmitPlan): Promise<SessionPlan>
  decision(
    threadId: string,
    ref: PlanRef,
    decision: 'approve' | 'revise',
    feedback?: string
  ): Promise<SessionPlan>
  resume(threadId: string, ref: PlanRef): Promise<ReadableStream<unknown>>
  resumeSubmit(
    identity: PlanRunIdentity,
    toolCallId: string,
    input: SubmitPlan
  ): Promise<
    | { status: 'approved'; state: SessionPlan; feedback: null }
    | { status: 'revise'; state: SessionPlan; feedback: SessionPlan['feedback'] }
  >
  cancel(threadId: string, expectedVersion: number): Promise<SessionPlan>
}
export class PlanHttpError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string
  ) {
    super(message)
  }
}
export function planRefOf(state: SessionPlan): PlanRef {
  return planRefSchema.parse({
    planId: state.planId,
    revision: state.revision,
    version: state.version
  })
}

export function createPlanRuntime(options: PlanRuntimeOptions): PlanRuntimeHandle {
  const scopeKey = `plan-scope-${randomUUID()}`
  const prepareRequest = (
    threadId: string,
    runId: string = randomUUID(),
    requestContext = new RequestContext()
  ): { requestContext: RequestContext; runId: string } => {
    const identity = { threadId: planThreadIdSchema.parse(threadId), runId }
    requestContext.set(scopeKey, identity)
    return { requestContext, runId }
  }
  const identityOf = (context: RequestContext | undefined): PlanRunIdentity => {
    const scope = context?.get(scopeKey) as PlanRunIdentity | undefined
    if (!scope?.runId || !scope.threadId) throw new PlanHttpError(409, 'missing-server-plan-scope')
    return scope
  }
  const state = async (thread: string): Promise<SessionPlan> => {
    const threadId = planThreadIdSchema.parse(thread)
    await options.coordinator.assertThread(threadId)
    const value = await options.store.find(threadId)
    return value ?? (await options.store.initialize(threadId))
  }
  const targetFor = async (threadId: string, value: SessionPlan): Promise<PlanSuspension> => {
    const targets = (await options.coordinator.listSuspended(threadId)).filter(
      (target) =>
        target.threadId === threadId &&
        target.toolName === 'submit_plan' &&
        target.suspendPayload.planId === value.planId &&
        target.suspendPayload.revision ===
          (value.pendingRevision?.submittedRevision ?? value.revision) &&
        (!value.approval ||
          (target.runId === value.approval.runId &&
            target.toolCallId === value.approval.toolCallId)) &&
        (!value.pendingRevision ||
          (target.runId === value.pendingRevision.binding.runId &&
            target.toolCallId === value.pendingRevision.binding.toolCallId))
    )
    if (targets.length !== 1) throw new PlanHttpError(409, 'ambiguous-or-stale-plan-suspension')
    return targets[0]
  }
  const checkRef = (value: SessionPlan, ref: PlanRef): void => {
    const parsed = planRefSchema.parse(ref)
    if (value.planId === null || JSON.stringify(planRefOf(value)) !== JSON.stringify(parsed))
      throw new PlanHttpError(409, 'stale-plan-reference')
  }
  return {
    prepareRequest,
    identityOf,
    guardFor(requestContext: RequestContext) {
      return createPlanGuard({ store: options.store, resolveRun: () => identityOf(requestContext) })
    },
    state,
    async enter(threadId: string, expectedVersion: number) {
      const operation = async (): Promise<SessionPlan> => {
        const current = await state(threadId)
        if (current.mode !== 'normal') throw new PlanHttpError(409, 'plan-already-active')
        return options.store.enter(threadId, expectedVersion)
      }
      if (!options.coordinator.withIdleThread)
        throw new PlanHttpError(409, 'plan-idle-coordinator-required')
      return options.coordinator.withIdleThread(threadId, operation)
    },
    async submit(identity: PlanRunIdentity, input: SubmitPlan) {
      await options.coordinator.assertThread(identity.threadId)
      return options.store.submit(identity.threadId, input)
    },
    async decision(
      threadId: string,
      ref: PlanRef,
      decision: 'approve' | 'revise',
      feedback?: string
    ) {
      const current = await state(threadId)
      checkRef(current, ref)
      const target = await targetFor(threadId, current)
      const lease = await options.coordinator.claimSuspend(
        threadId,
        target.runId,
        target.toolCallId,
        'submit_plan'
      )
      try {
        if (
          lease.target.threadId !== threadId ||
          lease.target.runId !== target.runId ||
          lease.target.toolCallId !== target.toolCallId
        )
          throw new PlanHttpError(409, 'wrong-plan-claim')
        return decision === 'approve'
          ? await options.store.decide(threadId, {
              ...ref,
              decision,
              binding: { runId: target.runId, toolCallId: target.toolCallId }
            })
          : await options.store.reviseSuspended(threadId, ref, planBodySchema.parse(feedback), {
              runId: target.runId,
              toolCallId: target.toolCallId
            })
      } finally {
        lease.release()
      }
    },
    async resume(threadId: string, ref: PlanRef) {
      const current = await state(threadId)
      checkRef(current, ref)
      if (!current.approval && !current.pendingRevision)
        throw new PlanHttpError(409, 'plan-decision-required')
      const target = await targetFor(threadId, current)
      const lease = await options.coordinator.claimSuspend(
        threadId,
        target.runId,
        target.toolCallId,
        'submit_plan'
      )
      try {
        const request = prepareRequest(threadId, target.runId)
        const stream = await options.resume({
          threadId,
          runId: target.runId,
          toolCallId: target.toolCallId,
          resumeData: { type: 'server-plan-decision' },
          requestContext: request.requestContext
        })
        return ownStream(stream, lease)
      } catch (error) {
        lease.release()
        throw error
      }
    },
    async resumeSubmit(identity: PlanRunIdentity, toolCallId: string, input: SubmitPlan) {
      const current = await state(identity.threadId)
      if (current.planId !== input.planId || current.body !== input.body)
        throw new PlanHttpError(409, 'stale-resumed-plan')
      const binding = { runId: identity.runId, toolCallId }
      if (current.pendingRevision) {
        if (current.pendingRevision.submittedRevision !== input.revision)
          throw new PlanHttpError(409, 'stale-resumed-revision')
        const next = await options.store.consumeRevision(
          identity.threadId,
          planRefOf(current),
          binding
        )
        return { status: 'revise' as const, state: next, feedback: next.feedback }
      }
      if (current.revision !== input.revision)
        throw new PlanHttpError(409, 'stale-resumed-revision')
      const next = await options.store.consume(identity.threadId, planRefOf(current), binding)
      return { status: 'approved' as const, state: next, feedback: null }
    },
    async cancel(threadId: string, expectedVersion: number) {
      const current = await state(threadId)
      if (current.version !== expectedVersion) throw new PlanHttpError(409, 'stale-plan-version')
      const cancelled =
        current.mode === 'cancelled'
          ? current
          : await options.store.cancel(threadId, expectedVersion)
      return options.coordinator.withThreadChange(threadId, () =>
        options.store.resetCancelled(threadId, cancelled.version)
      )
    }
  }
}
export type PlanRuntime = ReturnType<typeof createPlanRuntime>
