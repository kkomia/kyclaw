import type { InputProcessor } from '@mastra/core/processors'
import type { ToolHooks } from '@mastra/core/tools'
import { planThreadIdSchema, sessionPlanSchema, type SessionPlan } from '../shared/plan'
import type { SessionPlanStore } from './session-plan'

export interface PlanRunIdentity {
  threadId: string
  runId: string
}

export interface PlanGuardOptions {
  store: Pick<SessionPlanStore, 'find'>
  // Must resolve from the authenticated server run, never model input or request body.
  resolveRun(): Promise<PlanRunIdentity> | PlanRunIdentity
  localMcpMetaTools?: ReadonlySet<string>
}

const planningTools = new Set([
  'read',
  'glob',
  'grep',
  'use_skill',
  'ask_user',
  'todo',
  'enter_plan',
  'submit_plan',
  'web_search'
])

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function planningToolAllowed(
  toolName: string,
  input: unknown,
  localMcpMetaTools: ReadonlySet<string> = new Set()
): boolean {
  if (planningTools.has(toolName)) return true
  const args = record(input)
  if (toolName === 'fetch') {
    return (
      args !== null &&
      args.save_to === undefined &&
      args.body === undefined &&
      (args.method === undefined || args.method === 'GET')
    )
  }
  return (
    localMcpMetaTools.has(toolName) &&
    /^mcp__.+__meta$/.test(toolName) &&
    args !== null &&
    args.action === 'list' &&
    args.tool === undefined &&
    args.args === undefined
  )
}

function visibleInPlanning(name: string, meta: ReadonlySet<string>): boolean {
  return (
    planningTools.has(name) || name === 'fetch' || (meta.has(name) && /^mcp__.+__meta$/.test(name))
  )
}

export function createPlanGuard(options: PlanGuardOptions): {
  processor: InputProcessor
  hooks: ToolHooks
} {
  const meta = new Set(options.localMcpMetaTools ?? [])
  const load = async (): Promise<{ identity: PlanRunIdentity; state: SessionPlan }> => {
    const identity = await options.resolveRun()
    const threadId = planThreadIdSchema.parse(identity.threadId)
    if (!identity.runId || identity.runId.trim() !== identity.runId)
      throw new Error('Plan: missing server run')
    const raw = await options.store.find(threadId)
    if (!raw) throw new Error('Plan: thread mode unavailable')
    const state = sessionPlanSchema.parse(raw)
    if (state.threadId !== threadId) throw new Error('Plan: wrong stored thread')
    if (state.mode === 'cancelled') throw new Error('Plan: cancelled')
    if (state.mode === 'executing' && state.approval?.runId !== identity.runId)
      throw new Error('Plan: wrong execution run')
    return { identity, state }
  }
  return {
    processor: {
      id: 'server-plan-boundary',
      async processInputStep(args) {
        const { identity, state } = await load()
        const thread = args.requestContext?.get('MastraMemory.thread.id')
        const messageThreads = new Set(
          args.messages?.flatMap((message) => (message.threadId ? [message.threadId] : [])) ?? []
        )
        const matchesThread =
          thread === undefined
            ? messageThreads.size === 1 && messageThreads.has(identity.threadId)
            : thread === identity.threadId
        if (!matchesThread || (args.runId !== undefined && args.runId !== identity.runId))
          throw new Error('Plan: framework run/thread mismatch')
        const available = Object.keys(args.tools ?? {})
        const requested =
          args.activeTools === undefined
            ? available
            : available.filter((name) => args.activeTools?.includes(name))
        return {
          activeTools:
            state.mode === 'normal' || state.mode === 'executing'
              ? requested
              : requested.filter((name) => visibleInPlanning(name, meta))
        }
      }
    },
    hooks: {
      async beforeToolCall(call) {
        const { identity, state } = await load()
        const context = record(call.context)
        const agent = record(context?.agent)
        const requestContext = record(context?.requestContext)
        const get = requestContext?.get
        const memory = record(
          typeof get === 'function'
            ? get.call(context?.requestContext, 'MastraMemory')
            : requestContext?.MastraMemory
        )
        const memoryThread = record(memory?.thread)
        const thread = agent?.threadId ?? memoryThread?.id
        if (thread !== identity.threadId) throw new Error('Plan: tool thread mismatch')
        if (state.mode === 'normal' || state.mode === 'executing') return
        if (!planningToolAllowed(call.toolName, call.input, meta)) {
          throw new Error(`Plan: ${call.toolName} prohibited while ${state.mode}`)
        }
      }
    }
  }
}
