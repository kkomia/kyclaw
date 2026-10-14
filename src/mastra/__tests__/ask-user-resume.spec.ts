// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Chat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { threadMemoryBody } from '../../shared/threads'

const questionInput = {
  questions: [
    {
      id: 'format',
      header: 'Format',
      question: 'Which format should I use?',
      options: [
        { id: 'pdf', label: 'PDF', recommended: true },
        { id: 'docx', label: 'Word' }
      ]
    }
  ]
}
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const stop = { unified: 'stop' as const, raw: 'stop' }
const tools = { unified: 'tool-calls' as const, raw: 'tool_calls' }
type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>> extends {
    stream: ReadableStream<infer Part>
  }
    ? Part
    : never

function toolCall(): StreamPart[] {
  const input = JSON.stringify(questionInput)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: 'call-ask', toolName: 'ask_user' },
    { type: 'tool-input-delta', id: 'call-ask', delta: input },
    { type: 'tool-input-end', id: 'call-ask' },
    { type: 'tool-call', toolCallId: 'call-ask', toolName: 'ask_user', input },
    { type: 'finish', finishReason: tools, usage }
  ]
}
function multiCalls(): StreamPart[] {
  const calls = [
    { id: 'ask-a', name: 'ask_user', input: questionInput },
    { id: 'ask-b', name: 'ask_user', input: questionInput },
    { id: 'approve-c', name: 'bash', input: { command: 'echo mixed-resumed' } }
  ]
  const parts: StreamPart[] = [{ type: 'stream-start', warnings: [] }]
  for (const call of calls) {
    const input = JSON.stringify(call.input)
    parts.push(
      { type: 'tool-input-start', id: call.id, toolName: call.name },
      { type: 'tool-input-delta', id: call.id, delta: input },
      { type: 'tool-input-end', id: call.id },
      { type: 'tool-call', toolCallId: call.id, toolName: call.name, input }
    )
  }
  parts.push({ type: 'finish', finishReason: tools, usage })
  return parts
}

function text(): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'done' },
    { type: 'text-delta', id: 'done', delta: '已收到你的选择。' },
    { type: 'text-end', id: 'done' },
    { type: 'finish', finishReason: stop, usage }
  ]
}
function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (check()) return resolve()
      if (Date.now() >= deadline) return reject(new Error('等待 ask_user 恢复超时'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

let dir: string
let server: AgentServerHandle
let promptHistory: unknown[][] = []
let scripts: Array<() => StreamPart[]> = []
let streamDelay = 0

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-ask-user-'))
  const model = new MockLanguageModelV4({
    provider: 'kyclaw-ask-user-mock',
    modelId: 'kyclaw-ask-user-mock',
    doStream: async (options) => {
      promptHistory.push(options.prompt as unknown[])
      const script = scripts.shift()
      if (!script) throw new Error('mock 脚本用完了')
      return { stream: simulateReadableStream({ chunks: script(), chunkDelayInMs: streamDelay }) }
    }
  })
  server = await startAgentServer({
    dataDir: dir,
    model,
    workspaces: () => [],
    projects: () => [],
    rules: {
      readGlobalRules: () => ({ text: 'rules-wire-marker', diagnostics: [] }),
      readProjectRules: () => ({ text: '', diagnostics: [] })
    }
  })
})

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除，交给系统清理：', dir)
  }
})

describe('ask_user suspend/resume: real server + Chat', () => {
  it('request bodies cannot replace server rules/compaction processors', async () => {
    const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
      body: JSON.stringify({
        messages: [],
        ...threadMemoryBody('thread-processor-override'),
        inputProcessors: []
      })
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'server-owned-processors' })
  })
  it('persists suspension, resumes one toolCallId, and returns structured output', async () => {
    promptHistory = []
    scripts = [toolCall, text]
    const chat = new Chat<UIMessage>({
      transport: new DefaultChatTransport({
        api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
        headers: { authorization: `Bearer ${server.token}` }
      }),
      sendAutomaticallyWhen: () => false
    })
    const options = { body: threadMemoryBody('thread-ask-user-real') }
    await chat.sendMessage({ text: '请帮我选择格式' }, options)
    await waitUntil(() => chat.status === 'ready' || chat.error !== undefined)
    if (chat.error) throw chat.error
    await waitUntil(() =>
      chat.messages.some((message) =>
        message.parts.some((part) => (part as { type?: string }).type === 'tool-ask_user')
      )
    )

    const pending = chat.messages
      .flatMap((message) => message.parts)
      .find((part) => (part as { type?: string }).type === 'tool-ask_user') as unknown as {
      toolCallId?: string
      state?: string
      input?: unknown
    }
    expect(pending?.toolCallId).toBe('call-ask')
    expect(pending?.state).toBe('input-available')
    expect(pending?.input).toEqual(questionInput)
    const suspended = chat.messages
      .flatMap((message) => message.parts)
      .find(
        (part) => (part as { type?: string }).type === 'data-tool-call-suspended'
      ) as unknown as { data?: { runId?: string; toolCallId?: string } }
    expect(suspended?.data?.toolCallId).toBe('call-ask')
    expect(suspended?.data?.runId).toBeTruthy()
    const { LibSQLStore } = await import('@mastra/libsql')
    const probe = new LibSQLStore({
      id: 'ask-user-db-probe',
      url: `file:${join(dir, 'kyclaw.db').replace(/\\/g, '/')}`
    })
    const { usageSqlClient } = await import('../usage')
    const snapshot = await usageSqlClient(probe).execute(
      'SELECT json(snapshot) AS snapshot_text FROM mastra_workflow_snapshot'
    )
    expect(JSON.stringify(snapshot.rows)).toContain('suspendedTools')
    expect(JSON.stringify(snapshot.rows)).toContain('call-ask')

    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(`${server.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
        body: JSON.stringify(body)
      })
    const target = {
      threadId: 'thread-ask-user-real',
      runId: suspended?.data?.runId,
      toolCallId: 'call-ask'
    }
    const invalid = await post('/ask-user/resume', {
      ...target,
      resumeData: {
        status: 'answered',
        answers: [{ questionId: 'format', selectedOptionIds: ['unknown'] }]
      }
    })
    expect(invalid.status).toBe(400)
    const foreign = await post('/ask-user/resume', {
      ...target,
      threadId: 'foreign-thread',
      resumeData: {
        status: 'answered',
        answers: [{ questionId: 'format', selectedOptionIds: ['pdf'] }]
      }
    })
    expect(foreign.status).toBe(409)
    const pendingResponse = await fetch(
      `${server.baseUrl}/ask-user/pending?threadId=thread-ask-user-real`,
      { headers: { authorization: `Bearer ${server.token}` } }
    )
    expect(await pendingResponse.json()).toMatchObject({
      pending: [{ runId: target.runId, toolCallId: 'call-ask', input: questionInput }]
    })
    const resumed = await post('/ask-user/resume', {
      ...target,
      resumeData: {
        status: 'answered',
        answers: [{ questionId: 'format', selectedOptionIds: ['pdf'] }]
      }
    })
    expect(resumed.status).toBe(200)
    const resumedParts = sseParts(await resumed.text())
    expect(
      resumedParts.some(
        (part) => part.type === 'tool-output-available' && part.toolCallId === 'call-ask'
      )
    ).toBe(true)
    expect(
      resumedParts.some((part) => part.type === 'text-delta' && part.delta === '已收到你的选择。')
    ).toBe(true)
    expect(promptHistory).toHaveLength(2)
    expect(JSON.stringify(promptHistory[0])).toContain('rules-wire-marker')
    expect(JSON.stringify(promptHistory[1])).toContain('rules-wire-marker')
    const userPrompts = promptHistory[1].filter(
      (message) => (message as { role?: string }).role === 'user'
    )
    expect(userPrompts).toHaveLength(1)
    const toolMessages = promptHistory[1].filter(
      (message) => (message as { role?: string }).role === 'tool'
    )
    expect(JSON.stringify(toolMessages)).toContain('selectedLabels')
    expect(JSON.stringify(toolMessages)).toContain('PDF')
    expect(JSON.stringify(toolMessages)).toContain('call-ask')
    expect(
      resumedParts.find((part) => part.type === 'tool-output-available')?.output
    ).toMatchObject({
      status: 'answered',
      questions: questionInput.questions,
      answers: [{ questionId: 'format', selectedOptionIds: ['pdf'], selectedLabels: ['PDF'] }]
    })
    const duplicate = await post('/ask-user/resume', {
      ...target,
      resumeData: {
        status: 'answered',
        answers: [{ questionId: 'format', selectedOptionIds: ['pdf'] }]
      }
    })
    expect(duplicate.status).toBe(409)
  }, 60_000)

  it('directed resume preserves sibling questions and approval; cancel revokes the whole run', async () => {
    scripts = [multiCalls]
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${server.token}` }
    const threadId = 'thread-mixed'
    const first = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [
          { id: 'u-mixed', role: 'user', parts: [{ type: 'text', text: 'mixed choices' }] }
        ],
        ...threadMemoryBody(threadId)
      })
    })
    const initial = sseParts(await first.text())
    const runId = (
      initial.find((part) => part.type === 'data-tool-call-suspended')?.data as { runId: string }
    ).runId
    const resumed = await fetch(`${server.baseUrl}/ask-user/resume`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        threadId,
        runId,
        toolCallId: 'ask-a',
        resumeData: {
          status: 'answered',
          answers: [{ questionId: 'format', selectedOptionIds: ['pdf'] }]
        }
      })
    })
    expect(resumed.status).toBe(200)
    const parts = sseParts(await resumed.text())
    expect(parts.some((part) => part.type === 'error')).toBe(false)
    const pending = await fetch(`${server.baseUrl}/ask-user/pending?threadId=${threadId}`, {
      headers
    })
    expect(await pending.json()).toMatchObject({ pending: [{ toolCallId: 'ask-b' }] })
    const cancelled = await fetch(`${server.baseUrl}/ask-user/cancel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ threadId, runId })
    })
    expect(cancelled.status).toBe(200)
    const stale = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [
          {
            id: 'm-approval',
            role: 'assistant',
            parts: [
              {
                type: 'tool-bash',
                toolCallId: 'approve-c',
                state: 'approval-responded',
                input: { command: 'echo mixed-resumed' },
                approval: { id: `${runId}::approve-c`, approved: true }
              }
            ]
          }
        ],
        ...threadMemoryBody(threadId)
      })
    })
    expect(stale.status).toBe(409)
    expect(scripts).toHaveLength(0)
  }, 60_000)

  it('two questions then approval complete the same run with both structured results', async () => {
    scripts = [multiCalls, text]
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${server.token}` }
    const threadId = 'thread-mixed-complete'
    const first = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [
          { id: 'u-mixed-complete', role: 'user', parts: [{ type: 'text', text: 'mixed choices' }] }
        ],
        ...threadMemoryBody(threadId)
      })
    })
    const initial = sseParts(await first.text())
    const runId = (
      initial.find((part) => part.type === 'data-tool-call-suspended')?.data as { runId: string }
    ).runId
    for (const toolCallId of ['ask-a', 'ask-b']) {
      const response = await fetch(`${server.baseUrl}/ask-user/resume`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          threadId,
          runId,
          toolCallId,
          resumeData: {
            status: 'answered',
            answers: [
              { questionId: 'format', selectedOptionIds: [toolCallId === 'ask-a' ? 'pdf' : 'docx'] }
            ]
          }
        })
      })
      expect(response.status).toBe(200)
      expect(sseParts(await response.text()).some((part) => part.type === 'error')).toBe(false)
    }
    const approved = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [
          {
            id: 'm-approval-complete',
            role: 'assistant',
            parts: [
              {
                type: 'tool-bash',
                toolCallId: 'approve-c',
                state: 'approval-responded',
                input: { command: 'echo mixed-resumed' },
                approval: { id: `${runId}::approve-c`, approved: true }
              }
            ]
          }
        ],
        ...threadMemoryBody(threadId)
      })
    })
    expect(approved.status).toBe(200)
    const final = sseParts(await approved.text())
    expect(final.some((part) => part.type === 'error')).toBe(false)
    expect(final.some((part) => part.type === 'text-delta')).toBe(true)
    expect(JSON.stringify(promptHistory.at(-1))).toContain('selectedLabels')
    expect(JSON.stringify(promptHistory.at(-1))).toContain('PDF')
    expect(JSON.stringify(promptHistory.at(-1))).toContain('Word')
    expect(scripts).toHaveLength(0)
  }, 60_000)

  it('rejects concurrent answer requests until the winning response stream ends', async () => {
    scripts = [toolCall, text]
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${server.token}` }
    const threadId = 'thread-race'
    const chat = new Chat<UIMessage>({
      transport: new DefaultChatTransport({
        api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
        headers
      })
    })
    await chat.sendMessage({ text: 'race' }, { body: threadMemoryBody(threadId) })
    await waitUntil(() => chat.status === 'ready')
    const response = await fetch(`${server.baseUrl}/ask-user/pending?threadId=${threadId}`, {
      headers
    })
    const { pending } = (await response.json()) as {
      pending: Array<{ runId: string; toolCallId: string }>
    }
    streamDelay = 50
    try {
      const submit = (): Promise<Response> =>
        fetch(`${server.baseUrl}/ask-user/resume`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            threadId,
            ...pending[0],
            resumeData: {
              status: 'answered',
              answers: [{ questionId: 'format', selectedOptionIds: ['pdf'] }]
            }
          })
        })
      const replies = await Promise.all([submit(), submit()])
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409])
      await Promise.all(replies.map((reply) => reply.text()))
      expect((await submit()).status).toBe(409)
    } finally {
      streamDelay = 0
    }
  }, 60_000)

  it('stop during an active resume retains its run target and persists cancelled state', async () => {
    scripts = [toolCall, text]
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${server.token}` }
    const threadId = 'thread-active-cancel'
    const chat = new Chat<UIMessage>({
      transport: new DefaultChatTransport({
        api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
        headers
      })
    })
    await chat.sendMessage({ text: 'active stop' }, { body: threadMemoryBody(threadId) })
    await waitUntil(() => chat.status === 'ready')
    const pendingResponse = await fetch(`${server.baseUrl}/ask-user/pending?threadId=${threadId}`, {
      headers
    })
    const { pending } = (await pendingResponse.json()) as {
      pending: Array<{ runId: string; toolCallId: string }>
    }
    streamDelay = 100
    try {
      const resumed = await fetch(`${server.baseUrl}/ask-user/resume`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          threadId,
          ...pending[0],
          resumeData: {
            status: 'answered',
            answers: [{ questionId: 'format', selectedOptionIds: ['pdf'] }]
          }
        })
      })
      const draining = resumed.text()
      const stop = await fetch(`${server.baseUrl}/ask-user/cancel`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ threadId, runId: pending[0].runId })
      })
      expect(stop.status).toBe(200)
      await draining
      const retry = await fetch(`${server.baseUrl}/ask-user/cancel`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ threadId, runId: pending[0].runId })
      })
      expect(retry.status, await retry.text()).toBe(200)
    } finally {
      streamDelay = 0
    }
  }, 60_000)

  it('cancel finishes an unread resume response without depending on client SSE consumption', async () => {
    scripts = [toolCall, text]
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${server.token}` }
    const threadId = 'thread-unread-resume'
    const chat = new Chat<UIMessage>({
      transport: new DefaultChatTransport({
        api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
        headers
      })
    })
    await chat.sendMessage({ text: 'unread response' }, { body: threadMemoryBody(threadId) })
    await waitUntil(() => chat.status === 'ready')
    const pendingResponse = await fetch(`${server.baseUrl}/ask-user/pending?threadId=${threadId}`, {
      headers
    })
    const { pending } = (await pendingResponse.json()) as {
      pending: Array<{ runId: string; toolCallId: string }>
    }
    const resumed = await fetch(`${server.baseUrl}/ask-user/resume`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        threadId,
        ...pending[0],
        resumeData: {
          status: 'answered',
          answers: [{ questionId: 'format', selectedOptionIds: ['pdf'] }]
        }
      })
    })
    const stopped = await fetch(`${server.baseUrl}/ask-user/cancel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ threadId, runId: pending[0].runId })
    })
    expect(stopped.status).toBe(200)
    await resumed.body?.cancel()
  }, 60_000)

  it('thread truncate and deletion invalidate the old suspended capability', async () => {
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${server.token}` }
    for (const operation of ['truncate', 'delete']) {
      scripts = [toolCall]
      const threadId = `thread-${operation}-ask`
      const chat = new Chat<UIMessage>({
        transport: new DefaultChatTransport({
          api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
          headers
        })
      })
      await chat.sendMessage({ text: operation }, { body: threadMemoryBody(threadId) })
      await waitUntil(() => chat.status === 'ready')
      const pending = await fetch(`${server.baseUrl}/ask-user/pending?threadId=${threadId}`, {
        headers
      })
      const { pending: targets } = (await pending.json()) as {
        pending: Array<{ runId: string; toolCallId: string }>
      }
      const response = await fetch(
        `${server.baseUrl}/api/threads/${threadId}${operation === 'truncate' ? '/truncate' : ''}`,
        {
          method: operation === 'truncate' ? 'POST' : 'DELETE',
          headers,
          ...(operation === 'truncate'
            ? { body: JSON.stringify({ messageId: chat.messages[0].id }) }
            : {})
        }
      )
      expect(response.status).toBe(200)
      const stale = await fetch(`${server.baseUrl}/ask-user/resume`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          threadId,
          ...targets[0],
          resumeData: {
            status: 'answered',
            answers: [{ questionId: 'format', selectedOptionIds: ['pdf'] }]
          }
        })
      })
      expect(stale.status).toBe(409)
      const after = await fetch(`${server.baseUrl}/ask-user/pending?threadId=${threadId}`, {
        headers
      })
      expect(await after.json()).toEqual({ pending: [] })
    }
  }, 60_000)

  it('cancel is persistent and idempotent without asking the model to continue', async () => {
    scripts = [toolCall]
    const chat = new Chat<UIMessage>({
      transport: new DefaultChatTransport({
        api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
        headers: { authorization: `Bearer ${server.token}` }
      })
    })
    await chat.sendMessage({ text: '取消测试' }, { body: threadMemoryBody('thread-ask-cancel') })
    await waitUntil(() => chat.status === 'ready')
    const pendingResponse = await fetch(
      `${server.baseUrl}/ask-user/pending?threadId=thread-ask-cancel`,
      { headers: { authorization: `Bearer ${server.token}` } }
    )
    const body = (await pendingResponse.json()) as { pending: Array<{ runId: string }> }
    const runId = body.pending[0].runId
    const cancel = (): Promise<Response> =>
      fetch(`${server.baseUrl}/ask-user/cancel`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ threadId: 'thread-ask-cancel', runId })
      })
    const calls = promptHistory.length
    expect((await cancel()).status).toBe(200)
    expect((await cancel()).status).toBe(200)
    expect(promptHistory.length).toBe(calls)
    const after = await fetch(`${server.baseUrl}/ask-user/pending?threadId=thread-ask-cancel`, {
      headers: { authorization: `Bearer ${server.token}` }
    })
    expect(await after.json()).toEqual({ pending: [] })
    await server.stop()
    const model = new MockLanguageModelV4({
      provider: 'restart-mock',
      modelId: 'restart-mock',
      doStream: async () => {
        throw new Error('cancel must not resume the model')
      }
    })
    server = await startAgentServer({
      dataDir: dir,
      model,
      workspaces: () => [],
      projects: () => []
    })
    const restarted = await fetch(`${server.baseUrl}/ask-user/pending?threadId=thread-ask-cancel`, {
      headers: { authorization: `Bearer ${server.token}` }
    })
    expect(await restarted.json()).toEqual({ pending: [] })
    expect((await cancel()).status).toBe(200)
  }, 60_000)
})
