// @vitest-environment node
/**
 * 请求快照的**整条链路**（round 87 / 用户反馈 015 + 017）：真 chat 路由 → 真 run 收尾钩子 →
 * 真 libsql → 真 `/api/trajectory/*` 路由。
 *
 * 为什么非要有这一条：`request-log.spec.ts` 测的是抽取器与表，`trajectory-usage-route.spec.ts`
 * 测的是路由形状 —— 两头都对，中间那根线（`chatOptions.onFinish` 里怎么挂、一挂几步、
 * 失败那一步谁来记）还是没被跑过。这里用真的 `startAgentServer` + 脚本化 mock 模型跑完整条：
 *
 *   1. **一轮两步**（先读文件、再回答）：两次模型请求 → 两条快照（step 0 / 1），摘要里
 *      消息条数与工具件数逐条对上；
 *   2. **后续工具结果真进去了**：step 1 的明细里带着 `role: 'tool'` 的那条（文件正文）；
 *   3. **三个模型调用入口的失败都记**（用户反馈 015 的补齐）：
 *      chat 入口（provider 抛错）、ask-user 续跑、Plan 续跑 —— 各落一行 `status: 'error'`，
 *      且 threadId / runId 都是**那一轮真实的**（正文如实留空，不编）；
 *   4. **用户反馈 017**：请求面在 `/api/trajectory/*`，与 `/api/usage/*` 是两条路（用量坏掉
 *      不带它）。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterEach, describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import {
  trajectoryRequestDetailResponseSchema,
  trajectoryThreadRequestsResponseSchema
} from '../../shared/trajectory'
import { threadMemoryBody } from '../../shared/threads'
import { planRefOf } from '../plan-runtime'
import type { SessionPlan } from '../../shared/plan'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import type { KyclawModel } from '../model'
import type { Workspace } from '../../shared/settings'

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }
const FINISH_TOOLS = { unified: 'tool-calls' as const, raw: 'tool_calls' }

type DoStreamResult = Awaited<ReturnType<MockLanguageModelV4['doStream']>>
type StreamPart = DoStreamResult extends { stream: ReadableStream<infer Part> } ? Part : never

function textScript(text: string): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
    { type: 'text-end', id: 't1' },
    { type: 'finish', finishReason: FINISH_STOP, usage: USAGE }
  ]
}

function toolCallScript(toolCallId: string, toolName: string, input: unknown): StreamPart[] {
  const json = JSON.stringify(input)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: json },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input: json },
    { type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE }
  ]
}

/**
 * 把模型收到的调用参数拼成 **provider 形状的请求体**（`@ai-sdk/openai-compatible` 的实测形状：
 * system 进 `messages[].role='system'`、工具进 `tools[]`）。
 *
 * 为什么必须这么做：`steps[].request.body` 是 **provider 层回填**的（本机 LM Studio 实测有值），
 * 而 `ai/test` 的 mock 不会自己填 —— 不填，落库那一侧就没有原料（这是链路的真实前提，
 * 也是 `request-log.ts` 头注里那段实测的由来）。
 */
function providerShapedBody(options: unknown): Record<string, unknown> {
  const opts = (options ?? {}) as { prompt?: unknown; tools?: unknown }
  const prompt = Array.isArray(opts.prompt) ? opts.prompt : []
  const messages = prompt.map((raw) => {
    const message = (raw ?? {}) as { role?: unknown; content?: unknown }
    const role = typeof message.role === 'string' ? message.role : 'user'
    const content = message.content
    if (typeof content === 'string') return { role, content }
    const parts = Array.isArray(content) ? content : []
    const rendered = parts.map((part) => {
      if (
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text'
      ) {
        return String((part as { text?: unknown }).text ?? '')
      }
      // 非文本块（工具调用 / 工具结果）按 JSON 原样带上：真实 provider 也是这么序列化的，
      // 探针要看的就是"后续工具结果里有什么"
      try {
        return JSON.stringify(part) ?? ''
      } catch {
        return '[无法序列化]'
      }
    })
    return { role, content: rendered.join('\n') }
  })
  const tools = (Array.isArray(opts.tools) ? opts.tools : []).flatMap((raw) => {
    if (raw === null || typeof raw !== 'object') return []
    const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown }
    if (typeof tool.name !== 'string') return []
    return [
      {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      }
    ]
  })
  return { model: 'kyclaw-r87-e2e', messages, tools, stream: true }
}

/** ask_user 的入参形状（与 ask-user-resume.spec 的 questionInput 同形；真工具会校验它） */
const QUESTION_INPUT = {
  questions: [
    {
      id: 'format',
      header: '格式',
      question: '用哪种格式？',
      options: [
        { id: 'pdf', label: 'PDF', recommended: true },
        { id: 'docx', label: 'Word' }
      ]
    }
  ]
}

/** 每调一次模型取一个脚本（同 memory.spec / t11 的口径） */
function scriptedModel(scripts: Array<() => StreamPart[]>): KyclawModel {
  return new MockLanguageModelV4({
    provider: 'kyclaw-r87-e2e',
    modelId: 'kyclaw-r87-e2e',
    doStream: async (options) => {
      const script = scripts.shift()
      const chunks = script === undefined ? textScript('（没有脚本了）') : script()
      return {
        stream: simulateReadableStream({ chunks }),
        request: { body: providerShapedBody(options) },
        response: { headers: {} }
      } as never
    }
  }) as unknown as KyclawModel
}

let server: AgentServerHandle | undefined

/**
 * 临时工作目录（2026-10-15 起的新口径）：落**工作区** `.superpowers/test-scratch/` 下，唯一子目录，
 * **跑完不删**。共享 `TEMP`（本机是 `C:\lmstudio-temp`）不再放测试产物，也一律不清理
 * —— 那天有过一次把共享根目录整个清掉的事故，别的测试的临时文件跟着丢了。
 */
function tempDir(label: string): string {
  const value = join(
    process.cwd(),
    '.superpowers',
    'test-scratch',
    `${label}-${randomUUID().slice(0, 8)}`
  )
  mkdirSync(value, { recursive: true })
  return value
}

/** 带鉴权的一发 HTTP（本 spec 里三个路由都用它） */
async function post(handle: AgentServerHandle, path: string, body: unknown): Promise<Response> {
  return fetch(`${handle.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
    body: JSON.stringify(body)
  })
}

function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

async function start(options: {
  model: KyclawModel
  dataDir: string
  workspaces: Workspace[]
  defaultWorkspace: string
}): Promise<AgentServerHandle> {
  server = await startAgentServer({
    dataDir: options.dataDir,
    model: options.model,
    workspaces: () => options.workspaces,
    defaultWorkspace: () => options.defaultWorkspace,
    projects: () => []
  })
  return server
}

async function chat(handle: AgentServerHandle, thread: string, text: string): Promise<string> {
  const response = await fetch(`${handle.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
    body: JSON.stringify({
      messages: [{ id: 'u-1', role: 'user', parts: [{ type: 'text', text }] }],
      memory: { thread, resource: 'local-user' }
    })
  })
  return response.text()
}

async function requestsOf(
  handle: AgentServerHandle,
  thread: string
): Promise<ReturnType<typeof trajectoryThreadRequestsResponseSchema.parse>> {
  const response = await fetch(
    `${handle.baseUrl}/api/trajectory/requests?threadId=${encodeURIComponent(thread)}`,
    { headers: { authorization: `Bearer ${handle.token}` } }
  )
  expect(response.status).toBe(200)
  return trajectoryThreadRequestsResponseSchema.parse(await response.json())
}

afterEach(async () => {
  await server?.stop()
  server = undefined
  // 临时目录**留着**（工作区 `.superpowers/test-scratch/` 下，排障要看；不删共享/工作区里的目录）
})

describe('请求快照 · 整条链路', () => {
  it('一轮两步：两条快照（step 0 / 1），后续工具结果在明细里看得到', async () => {
    const dir = tempDir('r87-e2e-steps')
    const ws = join(dir, 'ws')
    const thread = 'r87-e2e-steps'
    const sessionDir = join(ws, 'tasks', thread.slice(0, 8).toLowerCase())
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'notes.md'), '# 备忘\n\n- 记得交周报\n')

    const handle = await start({
      dataDir: dir,
      model: scriptedModel([
        () => toolCallScript('call-1', 'read', { path: 'notes.md' }),
        () => textScript('它写着要交周报。')
      ]),
      workspaces: [{ path: ws, mode: 'full' }],
      defaultWorkspace: ws
    })

    await chat(handle, thread, '读一下 notes.md，然后一句话告诉我写了什么。')

    const listed = await requestsOf(handle, thread)
    expect(listed.requests.map((entry) => entry.step)).toEqual([0, 1])
    expect(listed.requests.map((entry) => entry.status)).toEqual(['complete', 'complete'])
    expect(listed.requests[0]).toMatchObject({ status: 'complete', error: null })
    // 两次请求都带着满编工具表与系统指令（实测：几十件工具、上万字）
    expect(listed.requests[0]?.toolCount).toBeGreaterThan(10)
    expect(listed.requests[0]?.systemChars).toBeGreaterThan(1000)
    // 第 2 步的消息更多（多了这一次的工具调用与结果）
    expect(listed.requests[1]!.messageCount!).toBeGreaterThan(listed.requests[0]!.messageCount!)

    // 明细：step 1 的请求里带着 role='tool' 的那条（**后续工具结果**真的在请求里）
    const detailResponse = await fetch(
      `${handle.baseUrl}/api/trajectory/requests/detail?id=${encodeURIComponent(listed.requests[1]!.id)}`,
      { headers: { authorization: `Bearer ${handle.token}` } }
    )
    expect(detailResponse.status).toBe(200)
    const detail = trajectoryRequestDetailResponseSchema.parse(await detailResponse.json()).request
    expect(detail.system).toContain('kyclaw')
    expect(detail.tools).toContain('"name": "read"')
    const toolMessages = detail.messages.filter((message) => message.role === 'tool')
    expect(toolMessages.map((message) => message.text).join('\n')).toContain('记得交周报')
  }, 60_000)

  it('chat 入口失败：onFinish 不触发，也留下一行 status=error（正文如实留空、run 是真的）', async () => {
    const dir = tempDir('r87-e2e-failed')
    const thread = 'r87-e2e-failed'
    const model = new MockLanguageModelV4({
      provider: 'kyclaw-r87-e2e-fail',
      modelId: 'kyclaw-r87-e2e-fail',
      doStream: async () => {
        throw new Error('Bad Request（探针故意让 provider 炸）')
      }
    }) as unknown as KyclawModel

    const handle = await start({
      dataDir: dir,
      model,
      workspaces: [],
      defaultWorkspace: dir
    })

    await chat(handle, thread, '在吗')

    const listed = await requestsOf(handle, thread)
    expect(listed.requests).toHaveLength(1)
    expect(listed.requests[0]).toMatchObject({
      status: 'error',
      step: null,
      // 正文未知就空着（不编一份"本该发出去的东西"）
      systemChars: null,
      toolsChars: null,
      messageCount: null,
      toolCount: null
    })
    expect(listed.requests[0]?.error ?? '').not.toBe('')
    // 关联**真实**的 run：chat 入口这一轮的 runId 由 prepareTaskChatParams 产出（不为空、不是编的）
    expect(listed.requests[0]?.runId ?? '').not.toBe('')
  }, 60_000)

  it('ask-user 续跑失败：失败行挂在**挂起时那一轮**的 thread/run 上', async () => {
    const dir = tempDir('r87-e2e-ask-resume')
    const thread = 'r87-e2e-ask-resume'
    const scripts: Array<() => StreamPart[]> = []
    scripts.push(() => toolCallScript('call-ask', 'ask_user', QUESTION_INPUT))
    // 续跑那一次模型调用**炸**：onFinish 不触发，只有入口那条流知道
    const model = new MockLanguageModelV4({
      provider: 'kyclaw-r87-e2e-ask',
      modelId: 'kyclaw-r87-e2e-ask',
      doStream: async (options) => {
        const script = scripts.shift()
        if (script === undefined) throw new Error('续跑那一轮 provider 报错（探针故意）')
        return {
          stream: simulateReadableStream({ chunks: script() }),
          request: { body: providerShapedBody(options) },
          response: { headers: {} }
        } as never
      }
    }) as unknown as KyclawModel

    const handle = await start({
      dataDir: dir,
      model,
      workspaces: [],
      defaultWorkspace: dir
    })

    await fetch(`${handle.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({
        messages: [{ id: 'u-ask', role: 'user', parts: [{ type: 'text', text: '问我一件事' }] }],
        ...threadMemoryBody(thread)
      })
    }).then((response) => response.text())

    // 挂起面：拿**真实**的 runId / toolCallId（不猜）
    const pendingResponse = await fetch(
      `${handle.baseUrl}/ask-user/pending?threadId=${encodeURIComponent(thread)}`,
      { headers: { authorization: `Bearer ${handle.token}` } }
    )
    expect(pendingResponse.status).toBe(200)
    const pending = (await pendingResponse.json()) as {
      pending: Array<{ runId: string; toolCallId: string }>
    }
    const target = pending.pending[0]
    expect(target?.toolCallId).toBe('call-ask')
    expect(target?.runId ?? '').not.toBe('')

    const resumed = await post(handle, '/ask-user/resume', {
      threadId: thread,
      runId: target?.runId,
      toolCallId: 'call-ask',
      resumeData: {
        status: 'answered',
        answers: [{ questionId: 'format', selectedOptionIds: ['pdf'] }]
      }
    })
    expect(resumed.status).toBe(200)
    const resumedParts = sseParts(await resumed.text())
    // 续跑那一轮确实挂了（error part），而 onFinish 那边不会有 step
    expect(resumedParts.some((part) => part.type === 'error')).toBe(true)

    const listed = await requestsOf(handle, thread)
    const failure = listed.requests.find((entry) => entry.status === 'error')
    expect(failure).toBeDefined()
    // 关联**挂起时那一轮**的 run（不是另编一个）
    expect(failure?.runId).toBe(target?.runId)
    expect(failure?.step).toBeNull()
    expect(failure?.systemChars).toBeNull()
  }, 60_000)

  it('Plan 续跑失败：失败行挂在 Plan 批准那一轮的 run 上', async () => {
    const dir = tempDir('r87-e2e-plan-resume')
    const thread = 'r87-e2e-plan-resume'
    const scripts: Array<() => StreamPart[]> = []
    const model = new MockLanguageModelV4({
      provider: 'kyclaw-r87-e2e-plan',
      modelId: 'kyclaw-r87-e2e-plan',
      doStream: async (options) => {
        const script = scripts.shift()
        if (script === undefined) throw new Error('Plan 续跑那一轮 provider 报错（探针故意）')
        return {
          stream: simulateReadableStream({ chunks: script() }),
          request: { body: providerShapedBody(options) },
          response: { headers: {} }
        } as never
      }
    }) as unknown as KyclawModel

    const handle = await start({
      dataDir: dir,
      model,
      workspaces: [{ path: dir, mode: 'ask' }],
      defaultWorkspace: dir
    })
    const state = async (): Promise<SessionPlan> => {
      const response = await fetch(
        `${handle.baseUrl}/plans/state?threadId=${encodeURIComponent(thread)}`,
        { headers: { authorization: `Bearer ${handle.token}` } }
      )
      expect(response.status).toBe(200)
      return ((await response.json()) as { state: SessionPlan }).state
    }

    await post(handle, '/api/threads', { threadId: thread })
    const initial = await state()
    await post(handle, '/plans/enter', { threadId: thread, expectedVersion: initial.version })
    const planning = await state()
    // submit_plan 的入参要用**真的**计划引用（planId / revision / version）
    scripts.push(() =>
      toolCallScript('submit-plan', 'submit_plan', {
        ...planRefOf(planning),
        body: '# 计划\n先读文件。'
      })
    )
    await post(handle, '/chat/kyclaw-agent', {
      ...threadMemoryBody(thread),
      messages: [{ id: 'u-plan', role: 'user', parts: [{ type: 'text', text: '做个计划' }] }]
    }).then((response) => response.text())
    const submitted = await state()
    const approved = await post(handle, '/plans/decision', {
      threadId: thread,
      ref: planRefOf(submitted),
      decision: 'approve'
    })
    expect(approved.status).toBe(200)
    const afterApprove = await state()
    const runId = afterApprove.approval?.runId
    expect(runId ?? '').not.toBe('')

    const resumed = await post(handle, '/plans/resume', {
      threadId: thread,
      ref: planRefOf(afterApprove)
    })
    expect(resumed.status).toBe(200)
    expect(sseParts(await resumed.text()).some((part) => part.type === 'error')).toBe(true)

    const listed = await requestsOf(handle, thread)
    const failure = listed.requests.find((entry) => entry.status === 'error')
    expect(failure).toBeDefined()
    // 关联 Plan 批准那一轮的 run（挂起时的那个 runId）
    expect(failure?.runId).toBe(runId)
    expect(failure?.systemChars).toBeNull()
  }, 60_000)
})
