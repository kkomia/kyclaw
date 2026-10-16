// @vitest-environment node
/**
 * system-first 的 **wire 级回归**（用户反馈：内网 exe 回 `400 System message must be at the
 * beginning.`）。
 *
 * 立足点是**真实发出的 HTTP 请求体**：假网关（真 node http）严格执行"role=system 恰好一条、
 * 且在第一条"，否则回 400（与用户报的错同文）；模型走真的 `@ai-sdk/openai-compatible`（经
 * `buildLanguageModel`，与生产同一装配路径）；agent 走真的 `startAgentServer`，覆盖首次、
 * 多步工具、审批恢复、ask-user 恢复、Plan 恢复五条路。旧补丁（挂在 `processInput` 上读
 * `get.all.db()`）看不到 system（MessageList 把 system 放独立桶里），故改在模型边界归并。
 *
 * 诚实边界：假网关执行的是"唯一首条 system"这一**最严读法**；那台内网网关到底卡的是"多条
 * system"还是"system 不在首位"没有取证 —— 本规则同时覆盖两种读法，但**不能**据此宣称
 * "内网根因已确认"。
 */
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Chat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { canResumeAfterApproval } from '../../renderer/src/features/chat/approval'
import {
  buildLanguageModel,
  mergeSystemFirstPrompt,
  systemFirstEnabled,
  SYSTEM_FIRST_ENV,
  type KyclawModel
} from '../model'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { threadMemoryBody } from '../../shared/threads'
import type { SessionPlan } from '../../shared/plan'
import { planRefOf } from '../plan-runtime'

/** 模型收到的 prompt 形状（与生产同源：AI SDK v4 spec 的语言模型入参） */
type Prompt = Parameters<KyclawModel['doGenerate']>[0]['prompt']

/** 内网网关回的那句人话（假网关照抄，测试断错也照抄） */
const GATEWAY_ERROR = 'System message must be at the beginning.'

/**
 * anthropic / deepseek **官方包**的替身：只用来断言"官方包那条路上没有套任何包装"
 * （它们怎么处理 system 归并 / cache_control 是官方包自己的事，我们不该在边界上插手）。
 */
const official = vi.hoisted(() => {
  const stub = (name: string): Record<string, unknown> => ({
    specificationVersion: 'v4',
    provider: name,
    modelId: `${name}-model`,
    supportedUrls: {},
    doGenerate: async () => ({
      content: [],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {},
      warnings: []
    }),
    doStream: async () => ({ stream: '替身流' })
  })
  return { anthropic: stub('anthropic-stub'), deepseek: stub('deepseek-stub') }
})

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => ({ chat: () => official.anthropic })
}))

vi.mock('@ai-sdk/deepseek', () => ({
  createDeepSeek: () => ({ chat: () => official.deepseek })
}))

/** 规矩处理器的正文标记（证明"多条 system"里也有它一份） */
const RULES_MARKER = 'rules-wire-marker'

interface WireMessage {
  role?: string
  content?: unknown
}

interface WireBody {
  messages?: WireMessage[]
  tools?: unknown[]
}

/** 假网关收到的请求体（按到达顺序） */
const bodies: WireBody[] = []
/** 每条请求回什么（按序取；取完回纯文本）：返回 SSE 正文 */
let scripts: Array<() => string> = []

/**
 * 假网关的严格规则：system 消息**恰好一条且在最前**。
 * 返回空串 = 合规；否则返回给客户端的错误说明（测试断错时能看出是哪种违规）。
 */
function strictSystemViolation(body: WireBody): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const positions = messages.flatMap((message, index) => (message.role === 'system' ? [index] : []))
  if (positions.length === 0) return 'no system message'
  if (positions.length > 1) return `got ${positions.length} system messages`
  return positions[0] === 0 ? '' : `system message at index ${positions[0]}`
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function sseText(text: string): string {
  return (
    sseChunk({
      id: 'chatcmpl-strict',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'strict-gateway',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
    }) +
    sseChunk({
      id: 'chatcmpl-strict',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'strict-gateway',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }) +
    'data: [DONE]\n\n'
  )
}

function sseToolCall(toolCallId: string, toolName: string, input: unknown): string {
  return (
    sseChunk({
      id: 'chatcmpl-strict',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'strict-gateway',
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: toolCallId,
                type: 'function',
                function: { name: toolName, arguments: JSON.stringify(input) }
              }
            ]
          },
          finish_reason: null
        }
      ]
    }) +
    sseChunk({
      id: 'chatcmpl-strict',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'strict-gateway',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }) +
    'data: [DONE]\n\n'
  )
}

function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .flatMap((data) => {
      try {
        return [JSON.parse(data) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

/** 这一轮的请求体断言：恰好一条 system、在第一行 */
function expectSingleLeadingSystem(body: WireBody, label: string): string {
  const messages = body.messages ?? []
  const systems = messages.filter((message) => message.role === 'system')
  expect(
    systems.map((message) => typeof message.content === 'string'),
    `${label}：system 正文应当是字符串`
  ).toEqual(systems.map(() => true))
  expect(systems, `${label}：system 条数`).toHaveLength(1)
  expect(messages[0]?.role, `${label}：第一条必须是 system`).toBe('system')
  return String(systems[0]?.content ?? '')
}

function roles(body: WireBody): string {
  return (body.messages ?? []).map((message) => message.role).join(',')
}

let dir: string
let workspace: string
let stub: Server
let server: AgentServerHandle
/** 假网关的"只记录、不校验"入口（providerOptions 契约用） */
let looseBaseUrl = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-system-first-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))

  stub = createServer((request, response) => {
    const path = request.url ?? ''
    // `/loose/v1/...` = 只记录、不执行严格规则（providerOptions 契约用：那一轮刻意发多条 system）
    const loose = path.startsWith('/loose/v1/chat/completions')
    if (request.method !== 'POST' || (!loose && !path.startsWith('/v1/chat/completions'))) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":{"message":"not found"}}')
      return
    }
    let raw = ''
    request.on('data', (chunk) => {
      raw += String(chunk)
    })
    request.on('end', () => {
      let parsed: WireBody = {}
      try {
        parsed = JSON.parse(raw) as WireBody
      } catch {
        parsed = { messages: [] }
      }
      bodies.push(parsed)
      const violation = loose ? '' : strictSystemViolation(parsed)
      if (violation !== '') {
        console.log(`[system-first] 假网关 400（${violation}）roles=[${roles(parsed)}]`)
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({ error: { message: GATEWAY_ERROR, type: 'invalid_request_error' } })
        )
        return
      }
      const script = scripts.shift()
      console.log(`[system-first] 假网关 200 roles=[${roles(parsed)}]`)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(script === undefined ? sseText('（脚本用完了）') : script())
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const address = stub.address()
  if (address === null || typeof address === 'string') throw new Error('假网关监听失败')
  const baseUrl = `http://127.0.0.1:${address.port}/v1`
  looseBaseUrl = `http://127.0.0.1:${address.port}/loose/v1`

  server = await startAgentServer({
    dataDir: dir,
    // 与生产同一条装配路径：settings 里的 openai 兼容 provider → buildLanguageModel
    resolveModel: () =>
      buildLanguageModel(
        { id: 'strict', type: 'openai-compatible', isDefault: true, baseUrl, model: 'strict' },
        ''
      ),
    workspaces: () => [{ path: workspace, mode: 'ask' }],
    projects: () => [],
    rules: {
      readGlobalRules: () => ({ text: RULES_MARKER, diagnostics: [] }),
      readProjectRules: () => ({ text: '', diagnostics: [] })
    }
  })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  await new Promise<void>((resolve) => stub?.close(() => resolve()))
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

function reset(): void {
  bodies.length = 0
  scripts = []
}

/** 一条 chat 请求（UI 消息协议，与渲染端 useChat 同形状） */
async function chatTurn(threadId: string, text: string): Promise<Response> {
  return fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [{ id: `u-${threadId}-${text}`, role: 'user', parts: [{ type: 'text', text }] }],
      ...threadMemoryBody(threadId)
    })
  })
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body)
  })
}

async function waitUntil(check: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`等待超时：${label}`)
}

describe('假网关：唯一首条 system（真 provider + 真 agent）', () => {
  it('首次对话：一条 system 在最前，正文（指令 / 工作记忆 / 规矩）都在它里面', async () => {
    reset()
    scripts.push(() => sseText('好。'))

    const response = await chatTurn('thread-first', '你好')
    expect(response.status).toBe(200)
    await response.text()

    expect(bodies).toHaveLength(1)
    const system = expectSingleLeadingSystem(bodies[0]!, '首次')
    expect(roles(bodies[0]!)).toBe('system,user')
    expect(system).toContain('You are kyclaw')
    expect(system).toContain('WORKING_MEMORY_SYSTEM_INSTRUCTION')
    expect(system).toContain(RULES_MARKER)
    // 原顺序保留：agent 指令在最前，规矩的正文在被归并的那条 system 里靠后
    expect(system.indexOf('You are kyclaw')).toBeLessThan(system.indexOf(RULES_MARKER))
  }, 60_000)

  it('多步工具：每一步的请求体都满足同一条规则（第二步带 assistant/tool 也照旧）', async () => {
    reset()
    scripts.push(
      () =>
        sseToolCall('call-todo', 'todo', {
          action: 'replace',
          expectedRevision: 0,
          items: [{ title: '回归任务', status: 'pending' }]
        }),
      () => sseText('记好了。')
    )

    const response = await chatTurn('thread-steps', '帮我记一条任务')
    expect(response.status).toBe(200)
    await response.text()

    expect(bodies).toHaveLength(2)
    expectSingleLeadingSystem(bodies[0]!, '第一步')
    expectSingleLeadingSystem(bodies[1]!, '第二步')
    expect(roles(bodies[0]!)).toBe('system,user')
    expect(roles(bodies[1]!)).toBe('system,user,assistant,tool')
  }, 60_000)

  it('审批恢复：挂起那一轮与批准后的续跑轮，请求体都合规（bash 真执行）', async () => {
    reset()
    scripts.push(
      () => sseToolCall('call-bash', 'bash', { command: 'echo resumed-ok' }),
      () => sseText('已经跑完了。')
    )

    const chat = new Chat<UIMessage>({
      transport: new DefaultChatTransport({
        api: `${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`,
        headers: { authorization: `Bearer ${server.token}` }
      }),
      sendAutomaticallyWhen: ({ messages }) => canResumeAfterApproval(messages)
    })
    const options = { body: threadMemoryBody('thread-approval') }
    await chat.sendMessage({ text: '帮我跑个 echo' }, options)

    const bashPart = ():
      { state?: string; approval?: { id?: string }; output?: unknown } | undefined =>
      chat.messages
        .flatMap((message) => message.parts)
        .find((part) => (part as { type?: string }).type === 'tool-bash') as
        { state?: string; approval?: { id?: string }; output?: unknown } | undefined

    await waitUntil(
      () => chat.status === 'ready' && bashPart()?.state === 'approval-requested',
      '挂起流收完 + approval-requested'
    )
    const approvalId = bashPart()?.approval?.id
    expect(approvalId).toBeTruthy()
    await chat.addToolApprovalResponse({ id: String(approvalId), approved: true, options })
    await waitUntil(
      () =>
        bashPart()?.state === 'output-available' &&
        chat.messages.some((message) =>
          message.parts.some(
            (part) => part.type === 'text' && 'text' in part && part.text === '已经跑完了。'
          )
        ),
      '续跑后 bash 执行完成'
    )

    expect(String(bashPart()?.output)).toContain('resumed-ok')
    expect(bodies).toHaveLength(2)
    expectSingleLeadingSystem(bodies[0]!, '挂起那一轮')
    expectSingleLeadingSystem(bodies[1]!, '审批续跑那一轮')
    expect(roles(bodies[1]!)).toContain('tool')
  }, 90_000)

  it(`逃生门 ${SYSTEM_FIRST_ENV}=off：关掉归并就回到修复前的形状，假网关照旧 400`, async () => {
    reset()
    const previous = process.env[SYSTEM_FIRST_ENV]
    process.env[SYSTEM_FIRST_ENV] = 'off'
    try {
      const response = await chatTurn('thread-off', '你好')
      await response.text()

      // 修复前的现场：多条 system 直接发出去 → 假网关判定违规（真机就是那个 400）
      expect(bodies).toHaveLength(1)
      expect(strictSystemViolation(bodies[0]!)).not.toBe('')
      expect(roles(bodies[0]!)).toBe('system,system,system,user')
    } finally {
      if (previous === undefined) delete process.env[SYSTEM_FIRST_ENV]
      else process.env[SYSTEM_FIRST_ENV] = previous
    }
  }, 60_000)

  it('ask_user 恢复：回答卡片之后的续跑请求体同样合规', async () => {
    reset()
    scripts.push(
      () =>
        sseToolCall('call-ask', 'ask_user', {
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
        }),
      () => sseText('已收到你的选择。')
    )

    const response = await chatTurn('thread-ask', '请帮我选择格式')
    expect(response.status).toBe(200)
    const parts = sseParts(await response.text())
    const suspended = parts.find((part) => part.type === 'data-tool-call-suspended') as
      { data?: { runId?: string; toolCallId?: string } } | undefined
    expect(suspended?.data?.runId).toBeTruthy()
    expect(suspended?.data?.toolCallId).toBe('call-ask')

    const resumed = await post('/ask-user/resume', {
      threadId: 'thread-ask',
      runId: suspended?.data?.runId,
      toolCallId: 'call-ask',
      resumeData: {
        status: 'answered',
        answers: [{ questionId: 'format', selectedOptionIds: ['pdf'] }]
      }
    })
    expect(resumed.status).toBe(200)
    await resumed.text()

    expect(bodies).toHaveLength(2)
    expectSingleLeadingSystem(bodies[0]!, 'ask_user 挂起那一轮')
    expectSingleLeadingSystem(bodies[1]!, 'ask_user 续跑那一轮')
  }, 90_000)

  it('Plan 恢复：批准 Plan 之后的续跑请求体同样合规', async () => {
    reset()
    const planChat = async (script: () => string): Promise<void> => {
      scripts.push(script)
      const response = await chatTurn('thread-plan', '开始规划')
      expect(response.status).toBe(200)
      await response.text()
    }
    const planState = async (): Promise<SessionPlan> =>
      (
        (await (
          await fetch(`${server.baseUrl}/plans/state?threadId=thread-plan`, {
            headers: { authorization: `Bearer ${server.token}` }
          })
        ).json()) as { state: SessionPlan }
      ).state

    expect((await post('/api/threads', { threadId: 'thread-plan' })).status).toBe(200)
    const initial = await planState()
    expect(
      (await post('/plans/enter', { threadId: 'thread-plan', expectedVersion: initial.version }))
        .status
    ).toBe(200)

    const planning = await planState()
    await planChat(() =>
      sseToolCall('call-plan', 'submit_plan', {
        ...planRefOf(planning),
        body: '# 计划\n只读一遍再回话。'
      })
    )
    const submitted = await planState()
    expect(submitted.mode).toBe('awaiting_approval')
    expect(
      (
        await post('/plans/decision', {
          threadId: 'thread-plan',
          ref: planRefOf(submitted),
          decision: 'approve'
        })
      ).status
    ).toBe(200)
    const approved = await planState()

    scripts.push(() => sseText('按计划做完了。'))
    const resumed = await post('/plans/resume', {
      threadId: 'thread-plan',
      ref: planRefOf(approved)
    })
    expect(resumed.status).toBe(200)
    await resumed.text()

    expect(bodies.length).toBeGreaterThanOrEqual(2)
    bodies.forEach((body, index) => {
      expectSingleLeadingSystem(body, `Plan 第 ${index + 1} 次请求`)
    })
  }, 90_000)
})

describe('mergeSystemFirstPrompt：只动 system，别的（顺序 / 身份 / 输入）一律不动', () => {
  it('没有 system、或唯一 system 已在首位 —— 原样返回同一个数组（零开销）', () => {
    const noSystem: Prompt = [
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好' }] }
    ]
    expect(mergeSystemFirstPrompt(noSystem)).toBe(noSystem)

    const leading: Prompt = [
      { role: 'system', content: '指令' },
      { role: 'user', content: [{ type: 'text', text: '你好' }] }
    ]
    expect(mergeSystemFirstPrompt(leading)).toBe(leading)
  })

  it('唯一 system 在中间 —— 提到首位，其余消息顺序与对象身份不变', () => {
    const user = { role: 'user' as const, content: [{ type: 'text' as const, text: '你好' }] }
    const assistant = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: '好' }]
    }
    const tool = {
      role: 'tool' as const,
      content: [
        {
          type: 'tool-result' as const,
          toolCallId: 'call-1',
          toolName: 'read',
          output: { type: 'text' as const, value: '正文' }
        }
      ]
    }
    const prompt: Prompt = [user, { role: 'system', content: '中段的系统提示' }, assistant, tool]

    const merged = mergeSystemFirstPrompt(prompt)
    expect(merged.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(merged[0]).toMatchObject({ content: '中段的系统提示' })
    expect(merged[1]).toBe(user)
    expect(merged[2]).toBe(assistant)
    expect(merged[3]).toBe(tool)
  })

  it('多条 system（首条 + 中段 + 尾部）—— 归并成一条，正文按原相对顺序用空行连接', () => {
    const first = { role: 'system' as const, content: '指令', providerOptions: { probe: { k: 1 } } }
    const prompt: Prompt = [
      first,
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'system', content: '工作记忆' },
      { role: 'assistant', content: [{ type: 'text', text: '好' }] },
      { role: 'system', content: '规矩' }
    ]

    const merged = mergeSystemFirstPrompt(prompt)
    expect(merged.map((message) => message.role)).toEqual(['system', 'user', 'assistant'])
    expect(merged[0]?.content).toBe('指令\n\n工作记忆\n\n规矩')
    // providerOptions 取第一条（归并后只剩一条，元数据不能凭空丢）
    expect((merged[0] as { providerOptions?: unknown }).providerOptions).toEqual({
      probe: { k: 1 }
    })
    // 非 system 消息：顺序与身份都不动
    expect(merged[1]).toBe(prompt[1])
    expect(merged[2]).toBe(prompt[3])
  })

  it('正文为空的 system 不制造多余空行；重复执行结果不变（幂等）', () => {
    const prompt: Prompt = [
      { role: 'system', content: '' },
      { role: 'system', content: '指令' },
      { role: 'user', content: [{ type: 'text', text: '你好' }] }
    ]
    const merged = mergeSystemFirstPrompt(prompt)
    expect(merged[0]?.content).toBe('指令')
    expect(mergeSystemFirstPrompt(merged)).toBe(merged)
  })

  it('不改输入：原数组长度、元素引用与正文都保持原样', () => {
    const prompt: Prompt = [
      { role: 'system', content: '指令' },
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      { role: 'system', content: '规矩' }
    ]
    const snapshot = JSON.parse(JSON.stringify(prompt)) as unknown

    mergeSystemFirstPrompt(prompt)

    expect(prompt).toHaveLength(3)
    expect(prompt.map((message) => message.role)).toEqual(['system', 'user', 'system'])
    expect(JSON.parse(JSON.stringify(prompt))).toEqual(snapshot)
  })

  it(`逃生门 ${SYSTEM_FIRST_ENV}：只认 0 / off / false（其余都当开着）`, () => {
    expect(systemFirstEnabled({})).toBe(true)
    expect(systemFirstEnabled({ [SYSTEM_FIRST_ENV]: '' })).toBe(true)
    expect(systemFirstEnabled({ [SYSTEM_FIRST_ENV]: '1' })).toBe(true)
    expect(systemFirstEnabled({ [SYSTEM_FIRST_ENV]: 'on' })).toBe(true)
    expect(systemFirstEnabled({ [SYSTEM_FIRST_ENV]: '0' })).toBe(false)
    expect(systemFirstEnabled({ [SYSTEM_FIRST_ENV]: 'OFF' })).toBe(false)
    expect(systemFirstEnabled({ [SYSTEM_FIRST_ENV]: ' false ' })).toBe(false)
  })

  it('适用范围：anthropic / deepseek 官方包那条路一个包装都不套（同一引用）', async () => {
    const anthropic = await buildLanguageModel(
      { id: 'anthropic-test', type: 'anthropic', isDefault: true, model: 'claude-test' },
      'key'
    )
    expect(Object.is(anthropic.doStream, official.anthropic.doStream)).toBe(true)
    expect(Object.is(anthropic.doGenerate, official.anthropic.doGenerate)).toBe(true)
    expect(Object.is(anthropic.supportedUrls, official.anthropic.supportedUrls)).toBe(true)
    // 确认拿到的是**替身**（不是替身没生效导致的空断言）
    expect(anthropic.provider).toBe('anthropic-stub')

    const deepseek = await buildLanguageModel(
      {
        id: 'deepseek-test',
        type: 'openai-compatible',
        isDefault: true,
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat'
      },
      'key'
    )
    expect(Object.is(deepseek.doStream, official.deepseek.doStream)).toBe(true)
    expect(Object.is(deepseek.doGenerate, official.deepseek.doGenerate)).toBe(true)
    expect(deepseek.provider).toBe('deepseek-stub')
  })

  it('providerOptions 契约（真 provider + 假网关）：保留第一条，后续的会丢 —— 且该层只认 openaiCompatible 键', async () => {
    /** 一条真请求，回这次请求体（排空流，确保请求真的发完） */
    const requestBody = async (env: Record<string, string | undefined>): Promise<WireBody> => {
      reset()
      const model = await buildLanguageModel(
        {
          id: 'loose',
          type: 'openai-compatible',
          isDefault: true,
          baseUrl: looseBaseUrl,
          model: 'loose'
        },
        '',
        env
      )
      const prompt: Prompt = [
        {
          role: 'system',
          content: '指令',
          providerOptions: { openaiCompatible: { firstKey: 'kept' } }
        },
        {
          role: 'system',
          content: '规矩',
          providerOptions: {
            openaiCompatible: { secondKey: 'dropped' },
            'kyclaw-openai-compatible': { aliasKey: 'ignored' }
          }
        },
        { role: 'user', content: [{ type: 'text', text: '你好' }] }
      ]
      const { stream } = await model.doStream({ prompt })
      const reader = stream.getReader()
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
      const body = bodies.at(-1)
      if (body === undefined) throw new Error('假网关没收到请求')
      return body
    }

    const merged = (await requestBody({})).messages ?? []
    expect(merged.map((message) => message.role)).toEqual(['system', 'user'])
    expect(merged[0]).toMatchObject({ content: '指令\n\n规矩', firstKey: 'kept' })
    // 后续那条的 providerOptions 确实被丢掉（归并不做无损声明）
    expect(merged[0]).not.toHaveProperty('secondKey')
    // 非 openaiCompatible 键本来就不会被这个 provider 序列化（两层事实叠在一起）
    expect(merged[0]).not.toHaveProperty('aliasKey')

    const unmerged = (await requestBody({ [SYSTEM_FIRST_ENV]: 'off' })).messages ?? []
    expect(unmerged.map((message) => message.role)).toEqual(['system', 'system', 'user'])
    // provider 确实会序列化 system 上的 openaiCompatible（所以"保留第一条"这条口径有意义）
    expect(unmerged[0]).toMatchObject({ firstKey: 'kept' })
    expect(unmerged[1]).toMatchObject({ secondKey: 'dropped' })
    // 而 provider 名（kyclaw-openai-compatible）这个键，provider 压根不看（getOpenAIMetadata 写死 openaiCompatible）
    expect(unmerged[1]).not.toHaveProperty('aliasKey')
  })
})
