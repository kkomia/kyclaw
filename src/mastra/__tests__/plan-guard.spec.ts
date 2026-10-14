import { describe, expect, it, vi } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import type { ProcessInputStepArgs } from '@mastra/core/processors'
import { createPlanGuard, planningToolAllowed } from '../plan-guard'
import type { SessionPlan } from '../../shared/plan'

function state(mode: SessionPlan['mode'] = 'planning'): SessionPlan {
  return {
    threadId: 't1',
    version: 2,
    mode,
    planId: 'p',
    revision: 1,
    body: 'plan',
    feedback: null,
    approval: mode === 'executing' ? { runId: 'r1', toolCallId: 'submit' } : null,
    updatedAt: new Date().toISOString()
  }
}
function setup(
  value: SessionPlan | null = state()
): ReturnType<typeof createPlanGuard> & { find: ReturnType<typeof vi.fn> } {
  const find = vi.fn(async () => value)
  return {
    find,
    ...createPlanGuard({
      store: { find },
      resolveRun: () => ({ threadId: 't1', runId: 'r1' }),
      localMcpMetaTools: new Set(['mcp__local__meta'])
    })
  }
}
function step(tools: string[], threadId = 't1'): ProcessInputStepArgs {
  const requestContext = new RequestContext()
  requestContext.set('MastraMemory.thread.id', threadId)
  return {
    requestContext,
    runId: 'r1',
    tools: Object.fromEntries(tools.map((tool) => [tool, {}]))
  } as ProcessInputStepArgs
}
function call(
  toolName: string,
  input: unknown = {},
  threadId = 't1'
): {
  toolName: string
  input: unknown
  context: { agent: { threadId: string; toolCallId: string }; workspace: { mode: string } }
} {
  return {
    toolName,
    input,
    context: { agent: { threadId, toolCallId: 'call' }, workspace: { mode: 'full' } }
  }
}

describe('Plan double server boundary', () => {
  it('filters activeTools and full workspace permission cannot bypass execution hook', async () => {
    const { processor, hooks } = setup()
    const result = await processor.processInputStep!(
      step([
        'read',
        'web_search',
        'fetch',
        'write',
        'bash',
        'git_diff',
        'mcp__local__meta',
        'mcp__other__read'
      ])
    )
    expect(result).toEqual({ activeTools: ['read', 'web_search', 'fetch', 'mcp__local__meta'] })
    for (const name of [
      'write',
      'edit',
      'delete',
      'move',
      'bash',
      'create_ppt',
      'edit_ppt',
      'create_docx',
      'edit_docx',
      'create_excel',
      'edit_excel',
      'render_ppt',
      'create_skill',
      'add_mcp_server',
      'git_status',
      'git_diff',
      'git_log',
      'mcp__other__read'
    ]) {
      await expect(hooks.beforeToolCall!(call(name))).rejects.toThrow('prohibited')
    }
    await expect(
      hooks.beforeToolCall!(call('web_search', { query: 'SDK docs' }))
    ).resolves.toBeUndefined()
  })
  it('MCP local list only; no read-classification or meta call escape', async () => {
    const { hooks } = setup()
    await expect(
      hooks.beforeToolCall!(call('mcp__local__meta', { action: 'list' }))
    ).resolves.toBeUndefined()
    await expect(
      hooks.beforeToolCall!(call('mcp__local__meta', { action: 'call', tool: 'read' }))
    ).rejects.toThrow()
    await expect(
      hooks.beforeToolCall!(call('mcp__other__meta', { action: 'list' }))
    ).rejects.toThrow()
  })
  it('fetch is GET-only without save_to/body, retaining downstream network policy', async () => {
    expect(planningToolAllowed('fetch', { url: 'https://example.com' })).toBe(true)
    for (const args of [
      { save_to: 'file' },
      { save_to: '' },
      { method: 'POST' },
      { body: 'payload' }
    ]) {
      expect(planningToolAllowed('fetch', args)).toBe(false)
    }
  })
  it('rejects missing/damaged states and incorrect real thread despite model fields', async () => {
    const missing = setup(null)
    await expect(missing.hooks.beforeToolCall!(call('read', { threadId: 't1' }))).rejects.toThrow()
    const damaged = setup({ ...state(), mode: 'bogus' } as never)
    await expect(damaged.processor.processInputStep!(step(['read']))).rejects.toThrow()
    const valid = setup()
    await expect(
      valid.hooks.beforeToolCall!(call('read', { threadId: 't1', approved: true }, 't2'))
    ).rejects.toThrow('thread mismatch')
    await expect(valid.processor.processInputStep!(step(['read'], 't2'))).rejects.toThrow(
      'mismatch'
    )
    expect(valid.find).toHaveBeenCalledWith('t1')
    const wrongStoredThread = setup({ ...state(), threadId: 't2' })
    await expect(wrongStoredThread.hooks.beforeToolCall!(call('read'))).rejects.toThrow(
      'wrong stored thread'
    )
  })
  it('normal mode needs no per-run Plan state mutation or binding', async () => {
    const normalState: SessionPlan = {
      threadId: 't1',
      version: 4,
      mode: 'normal',
      planId: null,
      revision: 0,
      body: null,
      feedback: null,
      approval: null,
      updatedAt: new Date().toISOString()
    }
    for (const runId of ['first-chat', 'second-chat']) {
      const guard = createPlanGuard({
        store: { find: async () => normalState },
        resolveRun: () => ({ threadId: 't1', runId })
      })
      await expect(guard.hooks.beforeToolCall!(call('write'))).resolves.toBeUndefined()
    }
    expect(normalState.version).toBe(4)
  })
  it('rereads mode at tool boundary, cancelling or wrong run blocks execution', async () => {
    const cancelled = setup(state('cancelled'))
    await expect(cancelled.hooks.beforeToolCall!(call('read'))).rejects.toThrow('cancelled')
    const wrongRun = setup({
      ...state('executing'),
      approval: { runId: 'old', toolCallId: 'submit' }
    })
    await expect(wrongRun.hooks.beforeToolCall!(call('write'))).rejects.toThrow(
      'wrong execution run'
    )
    const executing = setup(state('executing'))
    await expect(executing.hooks.beforeToolCall!(call('write'))).resolves.toBeUndefined()
  })
})
