// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer } from '../../main/agent/service'
import { threadMemoryBody } from '../../shared/threads'
import type { SessionPlan } from '../../shared/plan'
import type { Workspace } from '../../shared/settings'
import { planRefOf } from '../plan-runtime'

type Part =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>> extends { stream: ReadableStream<infer P> }
    ? P
    : never
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 }
}
const call = (name: string, input: unknown, id = 'plan-call'): Part[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-input-start', id, toolName: name },
  { type: 'tool-input-delta', id, delta: JSON.stringify(input) },
  { type: 'tool-input-end', id },
  { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage }
]
const done = (): Part[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'text' },
  { type: 'text-delta', id: 'text', delta: 'done' },
  { type: 'text-end', id: 'text' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }
]

it('production Plan HTTP persists/revises/approves/cancels without bypassing write approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plans-production-'))
  const file = join(dir, 'target.txt')
  writeFileSync(file, 'original')
  const scripts: Array<() => Part[]> = []
  const exposed: string[][] = []
  const model = new MockLanguageModelV4({
    provider: 'plans-production',
    modelId: 'plans-production',
    doStream: async (options) => {
      exposed.push((options.tools ?? []).map((tool) => tool.name))
      const script = scripts.shift()
      if (!script) throw new Error('plan script exhausted')
      return { stream: simulateReadableStream({ chunks: script() }) }
    }
  })
  const workspaces = (): readonly Workspace[] => [{ path: dir, mode: 'ask' as const }]
  let server = await startAgentServer({ dataDir: dir, model, workspaces })
  const request = (path: string, body?: unknown): Promise<Response> =>
    fetch(`${server.baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  const get = async (): Promise<SessionPlan> =>
    ((await (await request('/plans/state?threadId=t')).json()) as { state: SessionPlan }).state
  const chat = async (): Promise<string> => {
    const response = await request('/chat/kyclaw-agent', {
      ...threadMemoryBody('t'),
      messages: [
        { id: `u-${Date.now()}`, role: 'user', parts: [{ type: 'text', text: 'continue' }] }
      ]
    })
    expect(response.status).toBe(200)
    return response.text()
  }
  try {
    expect((await request('/plans/state?threadId=unmaterialized')).status).toBe(409)
    expect((await request('/api/threads', { threadId: 't' })).status).toBe(200)
    const initial = await get()
    expect(
      (await request('/plans/enter', { threadId: 't', expectedVersion: initial.version })).status
    ).toBe(200)
    scripts.push(() => call('write', { path: file, content: 'blocked' }, 'blocked-write'), done)
    await chat()
    expect(readFileSync(file, 'utf8')).toBe('original')
    expect(exposed[0]).not.toContain('write')
    let planning = await get()
    scripts.push(() =>
      call('submit_plan', { ...planRefOf(planning), body: '# Plan\nRead then write.' })
    )
    await chat()
    const submitted = await get()
    expect(submitted.mode).toBe('awaiting_approval')
    expect(
      (
        await request('/plans/resume', {
          threadId: 't',
          ref: planRefOf(submitted),
          resumeData: { approved: true }
        })
      ).status
    ).toBe(400)
    expect(
      (
        await request('/plans/decision', {
          threadId: 't',
          ref: planRefOf(submitted),
          decision: 'approve',
          binding: { runId: 'fake', toolCallId: 'fake' }
        })
      ).status
    ).toBe(400)
    const revise = await request('/plans/decision', {
      threadId: 't',
      ref: planRefOf(submitted),
      decision: 'revise',
      feedback: 'smaller change'
    })
    expect(revise.status).toBe(200)
    const revised = await get()
    scripts.push(done)
    const revisedStream = await request('/plans/resume', { threadId: 't', ref: planRefOf(revised) })
    expect(revisedStream.status).toBe(200)
    expect(await revisedStream.text()).toContain('smaller change')
    planning = await get()
    scripts.push(() =>
      call('submit_plan', { ...planRefOf(planning), body: 'Smaller plan' }, 'submit-next')
    )
    await chat()
    await server.stop()
    server = await startAgentServer({ dataDir: dir, model, workspaces })
    const restored = await get()
    expect(restored.body).toBe('Smaller plan')
    const approval = await request('/plans/decision', {
      threadId: 't',
      ref: planRefOf(restored),
      decision: 'approve'
    })
    expect(approval.status).toBe(200)
    const approved = await get()
    expect(approved.approval?.runId).toBeTruthy()
    scripts.push(() => call('write', { path: file, content: 'needs approval' }, 'approved-write'))
    const resumed = await request('/plans/resume', { threadId: 't', ref: planRefOf(approved) })
    expect(resumed.status).toBe(200)
    const stream = await resumed.text()
    expect(stream).toContain('tool-approval-request')
    expect(readFileSync(file, 'utf8')).toBe('original')
    const executing = await get()
    expect(executing.mode).toBe('executing')
    expect(
      (await request('/plans/resume', { threadId: 't', ref: planRefOf(approved) })).status
    ).toBe(409)
    expect(
      (await request('/plans/cancel', { threadId: 't', expectedVersion: executing.version })).status
    ).toBe(200)
    expect((await get()).mode).toBe('normal')
    expect(
      (await request('/plans/resume', { threadId: 't', ref: planRefOf(approved) })).status
    ).toBe(409)
    const history = await (await request('/api/threads/t/messages')).text()
    expect(history).toContain('cancelled')
  } finally {
    await server.stop()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      console.warn('plan production cleanup deferred', error)
    }
  }
}, 60_000)

it('approved Plan writes only after tool approval, finishes normal and accepts the next ordinary run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plans-complete-'))
  const file = join(dir, 'completed.txt')
  const scripts: Array<() => Part[]> = []
  const model = new MockLanguageModelV4({
    provider: 'plans-complete',
    modelId: 'plans-complete',
    doStream: async () => {
      const script = scripts.shift()
      if (!script) throw new Error('completion script exhausted')
      return { stream: simulateReadableStream({ chunks: script() }) }
    }
  })
  const server = await startAgentServer({
    dataDir: dir,
    model,
    workspaces: () => [{ path: dir, mode: 'ask' }]
  })
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${server.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  const state = async (): Promise<SessionPlan> => {
    const response = await fetch(`${server.baseUrl}/plans/state?threadId=complete`, {
      headers: { Authorization: `Bearer ${server.token}` }
    })
    expect(response.status).toBe(200)
    return ((await response.json()) as { state: SessionPlan }).state
  }
  try {
    await post('/api/threads', { threadId: 'complete' })
    const initial = await state()
    await post('/plans/enter', { threadId: 'complete', expectedVersion: initial.version })
    const planning = await state()
    scripts.push(() =>
      call(
        'submit_plan',
        { ...planRefOf(planning), body: 'Write the approved file.' },
        'submit-complete'
      )
    )
    const submittedStream = await post('/chat/kyclaw-agent', {
      ...threadMemoryBody('complete'),
      messages: [{ id: 'u-complete', role: 'user', parts: [{ type: 'text', text: 'make plan' }] }]
    })
    expect(submittedStream.status).toBe(200)
    await submittedStream.text()
    const submitted = await state()
    expect(
      (
        await post('/plans/decision', {
          threadId: 'complete',
          ref: planRefOf(submitted),
          decision: 'approve'
        })
      ).status
    ).toBe(200)
    const approved = await state()
    scripts.push(() => call('write', { path: file, content: 'actually written' }, 'write-complete'))
    const planResume = await post('/plans/resume', {
      threadId: 'complete',
      ref: planRefOf(approved)
    })
    expect(planResume.status).toBe(200)
    const body = await planResume.text()
    const parts = body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((line) => line !== '[DONE]')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    const approval = parts.find((part) => part.type === 'tool-approval-request')
    expect(approval?.toolCallId).toBe('write-complete')
    expect(String(approval?.approvalId)).toBe(`${approved.approval!.runId}::write-complete`)
    expect((await state()).mode).toBe('executing')
    scripts.push(done)
    const toolResume = await post('/chat/kyclaw-agent', {
      ...threadMemoryBody('complete'),
      messages: [
        {
          id: 'assistant-approved-write',
          role: 'assistant',
          parts: [
            {
              type: 'tool-write',
              toolCallId: 'write-complete',
              input: { path: file, content: 'actually written' },
              state: 'approval-responded',
              approval: { id: approval!.approvalId, approved: true }
            }
          ]
        }
      ]
    })
    expect(toolResume.status).toBe(200)
    const completed = await toolResume.text()
    expect(completed).toContain('done')
    expect(completed).not.toContain('"type":"error"')
    expect(readFileSync(file, 'utf8')).toBe('actually written')
    expect((await state()).mode).toBe('normal')
    expect(
      (await post('/plans/resume', { threadId: 'complete', ref: planRefOf(approved) })).status
    ).toBe(409)
    scripts.push(done)
    const ordinary = await post('/chat/kyclaw-agent', {
      ...threadMemoryBody('complete'),
      messages: [
        { id: 'u-next', role: 'user', parts: [{ type: 'text', text: 'next ordinary turn' }] }
      ]
    })
    expect(ordinary.status).toBe(200)
    expect(await ordinary.text()).toContain('done')
    expect((await state()).mode).toBe('normal')
    expect(scripts).toHaveLength(0)
  } finally {
    await server.stop()
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      console.warn('plan completion cleanup deferred', error)
    }
  }
}, 60_000)
