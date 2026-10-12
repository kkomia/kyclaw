// @vitest-environment node
/**
 * T14 Step 1：记忆路由（working memory 的查看 / 编辑 / 清空）；round 58 起**按会话隔离**。
 *
 * 走真服务（startAgentServer：chat 路由 v7 + libsql + Memory + 我们的 /api/memory）：
 *   - GET / PUT / DELETE 的读写与幂等（都带 threadId）；
 *   - 缺 threadId → 400（记忆按会话隔离，没有会话就没有可读可写的记忆）；
 *   - 入参校验（坏形状 / 超长 → 400）；
 *   - **会话隔离**：A 写的 B 读不到（thread 作用域，两个线程各一份）；
 *   - **编辑后的记忆真的喂给了模型**：同一个会话的下一轮请求里，系统消息带着刚才写的内容；
 *     别的会话那轮不带（同样钉住隔离）；
 *   - 助手通过 `updateWorkingMemory` 工具写入的记忆，在 GET（同一个 threadId）里能看到
 *     （记忆页看到的与模型看到的必须是同一份）。
 *
 * 工具脚本按队列回放（同 T11 审批 spec 的口径）；没排脚本时默认回一段文本。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { threadMemoryBody } from '../../shared/threads'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'

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

/** 一个"调用某工具"的脚本（参数一次性给全，不走增量） */
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

/** 从 mock 收到的调用参数里取系统消息文本（记忆是以系统消息注入的） */
function systemText(options: unknown): string {
  const prompt = (options as { prompt?: unknown }).prompt
  if (!Array.isArray(prompt)) return ''
  return prompt
    .filter((message) => (message as { role?: unknown }).role === 'system')
    .map((message) => JSON.stringify((message as { content?: unknown }).content))
    .join('\n')
}

let dir: string
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []
const calls: unknown[] = []

async function memoryApi(
  method: 'GET' | 'PUT' | 'DELETE',
  options: { threadId?: string; body?: unknown } = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const query =
    options.threadId === undefined ? '' : `?threadId=${encodeURIComponent(options.threadId)}`
  const response = await fetch(`${server.baseUrl}/api/memory${query}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

/** 建一个真实线程（round 58：记忆按会话隔离，写入要求线程已存在） */
async function createThread(threadId: string): Promise<void> {
  const response = await fetch(`${server.baseUrl}/api/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ threadId })
  })
  expect(response.status).toBe(200)
}

async function chat(threadId: string, text: string): Promise<void> {
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [{ id: `u-${threadId}`, role: 'user', parts: [{ type: 'text', text }] }],
      ...threadMemoryBody(threadId)
    })
  })
  expect(response.status).toBe(200)
  await response.text()
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-memory-'))
  const model = new MockLanguageModelV4({
    provider: 'kyclaw-memory-mock',
    modelId: 'kyclaw-memory-mock',
    doStream: async (options: unknown) => {
      calls.push(options)
      const script = scripts.shift()
      return {
        stream: simulateReadableStream({
          chunks: script === undefined ? textScript('好。') : script(),
          initialDelayInMs: 0,
          chunkDelayInMs: 0
        })
      }
    }
  })

  server = await startAgentServer({ dataDir: dir, model })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('记忆 API：查看 / 编辑 / 清空（按会话）', () => {
  it('缺 threadId：GET / PUT / DELETE 一律 400（没有会话就没有可读可写的记忆）', async () => {
    for (const call of [
      await memoryApi('GET'),
      await memoryApi('GET', { threadId: '   ' }),
      await memoryApi('PUT', { body: { content: 'x' } }),
      await memoryApi('DELETE')
    ]) {
      expect(call.status).toBe(400)
      expect(call.json.error).toBe('invalid-input: threadId')
    }
  })

  it('空库：GET 回 content=null', async () => {
    await createThread('thread-memory-empty')
    const got = await memoryApi('GET', { threadId: 'thread-memory-empty' })
    expect(got.status).toBe(200)
    expect(got.json).toEqual({ content: null })
  })

  it('PUT 写入后 GET 读回；再 PUT 全空白 = 清空', async () => {
    const threadId = 'thread-memory-roundtrip'
    await createThread(threadId)
    const written = '# 用户信息\n- 姓名：张三\n- 城市：杭州'
    const put = await memoryApi('PUT', { threadId, body: { content: written } })
    expect(put.status).toBe(200)
    expect(put.json).toEqual({ content: written })

    expect(await memoryApi('GET', { threadId })).toMatchObject({ json: { content: written } })

    const blank = await memoryApi('PUT', { threadId, body: { content: '   \n  ' } })
    expect(blank.status).toBe(200)
    expect(blank.json).toEqual({ content: null })
    expect(await memoryApi('GET', { threadId })).toMatchObject({ json: { content: null } })
  })

  it('DELETE 清空（幂等：本来就是空的也回 ok）', async () => {
    const threadId = 'thread-memory-delete'
    await createThread(threadId)
    await memoryApi('PUT', { threadId, body: { content: '# 用户信息\n- 姓名：张三' } })

    const first = await memoryApi('DELETE', { threadId })
    expect(first.status).toBe(200)
    expect(first.json).toEqual({ ok: true })
    expect(await memoryApi('GET', { threadId })).toMatchObject({ json: { content: null } })

    const second = await memoryApi('DELETE', { threadId })
    expect(second.status).toBe(200)
    expect(second.json).toEqual({ ok: true })
  })

  it('入参校验：缺字段 / 类型不对 / 超长 → 400', async () => {
    const threadId = 'thread-memory-invalid'
    await createThread(threadId)
    for (const body of [{}, { content: 123 }, { content: 'x'.repeat(20001) }, { text: 'a' }]) {
      const got = await memoryApi('PUT', { threadId, body })
      expect(got.status, JSON.stringify(body)).toBe(400)
      expect(String(got.json.error)).toContain('invalid-input')
    }
  })

  it('两个会话各一份（round 58）：A 写的 B 读不到，B 写的 A 不受影响', async () => {
    await createThread('thread-memory-iso-a')
    await createThread('thread-memory-iso-b')

    const a = '# 用户信息\n- 姓名：张三'
    const b = '# 用户信息\n- 姓名：李四'
    expect(
      (await memoryApi('PUT', { threadId: 'thread-memory-iso-a', body: { content: a } })).status
    ).toBe(200)
    expect(await memoryApi('GET', { threadId: 'thread-memory-iso-a' })).toMatchObject({
      json: { content: a }
    })
    // B 还没写过：读不到 A 的内容（跨会话不共享）
    expect(await memoryApi('GET', { threadId: 'thread-memory-iso-b' })).toMatchObject({
      json: { content: null }
    })

    expect(
      (await memoryApi('PUT', { threadId: 'thread-memory-iso-b', body: { content: b } })).status
    ).toBe(200)
    expect(await memoryApi('GET', { threadId: 'thread-memory-iso-a' })).toMatchObject({
      json: { content: a }
    })
    expect(await memoryApi('GET', { threadId: 'thread-memory-iso-b' })).toMatchObject({
      json: { content: b }
    })

    // 清空 B 不动 A
    expect((await memoryApi('DELETE', { threadId: 'thread-memory-iso-b' })).status).toBe(200)
    expect(await memoryApi('GET', { threadId: 'thread-memory-iso-b' })).toMatchObject({
      json: { content: null }
    })
    expect(await memoryApi('GET', { threadId: 'thread-memory-iso-a' })).toMatchObject({
      json: { content: a }
    })
  })
})

describe('记忆与对话是同一份（thread 作用域）', () => {
  it('在记忆页写入后，同一个会话的下一轮系统消息里带着它；别的会话不带', async () => {
    const threadId = 'thread-memory-read'
    await createThread(threadId)
    const written = '# 用户信息\n- 姓名：张三\n- 偏好：简短回答'
    expect((await memoryApi('PUT', { threadId, body: { content: written } })).status).toBe(200)

    const before = calls.length
    await chat(threadId, '我叫什么？')

    expect(calls.length).toBe(before + 1)
    const injected = systemText(calls[calls.length - 1])
    expect(injected).toContain('张三')
    expect(injected).toContain('简短回答')

    // 另一个会话（新线程）的下一轮：不该看到上面那份记忆
    await chat('thread-memory-other', '我叫什么？')
    const other = systemText(calls[calls.length - 1])
    expect(other).not.toContain('张三')
    expect(other).not.toContain('简短回答')
  }, 30_000)

  it('助手用 updateWorkingMemory 工具写下的内容，GET 里能看到（记忆页与模型同一份）', async () => {
    const threadId = 'thread-memory-write'
    scripts.length = 0
    scripts.push(() =>
      toolCallScript('call-wm', 'updateWorkingMemory', {
        memory: '# 用户信息\n- 姓名：李四\n- 城市：上海'
      })
    )
    scripts.push(() => textScript('记住了。'))

    await chat(threadId, '我叫李四，住在上海')

    const got = await memoryApi('GET', { threadId })
    expect(got.status).toBe(200)
    const content = String(got.json.content)
    expect(content).toContain('李四')
    expect(content).toContain('上海')
    // 模板口径是整块替换：上一条用例写在别的会话里的"张三"不该串到这里（会话隔离）
    expect(content).not.toContain('张三')
  }, 30_000)
})
