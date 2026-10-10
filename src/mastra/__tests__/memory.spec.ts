// @vitest-environment node
/**
 * T14 Step 1：记忆路由（working memory 的查看 / 编辑 / 清空）。
 *
 * 走真服务（startAgentServer：chat 路由 v7 + libsql + Memory + 我们的 /api/memory）：
 *   - GET / PUT / DELETE 的读写与幂等；
 *   - 入参校验（坏形状 / 超长 → 400）；
 *   - **编辑后的记忆真的喂给了模型**：新线程的下一轮请求里，系统消息带着刚才写的内容
 *     （resource 作用域：跨会话共享）；
 *   - 助手通过 `updateWorkingMemory` 工具写入的记忆，在 GET 里能看到（记忆页看到的
 *     与模型看到的必须是同一份）。
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
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${server.baseUrl}/api/memory`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
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

describe('记忆 API：查看 / 编辑 / 清空', () => {
  it('空库：GET 回 content=null', async () => {
    const got = await memoryApi('GET')
    expect(got.status).toBe(200)
    expect(got.json).toEqual({ content: null })
  })

  it('PUT 写入后 GET 读回；再 PUT 全空白 = 清空', async () => {
    const written = '# 用户信息\n- 姓名：张三\n- 城市：杭州'
    const put = await memoryApi('PUT', { content: written })
    expect(put.status).toBe(200)
    expect(put.json).toEqual({ content: written })

    expect(await memoryApi('GET')).toMatchObject({ json: { content: written } })

    const blank = await memoryApi('PUT', { content: '   \n  ' })
    expect(blank.status).toBe(200)
    expect(blank.json).toEqual({ content: null })
    expect(await memoryApi('GET')).toMatchObject({ json: { content: null } })
  })

  it('DELETE 清空（幂等：本来就是空的也回 ok）', async () => {
    await memoryApi('PUT', { content: '# 用户信息\n- 姓名：张三' })

    const first = await memoryApi('DELETE')
    expect(first.status).toBe(200)
    expect(first.json).toEqual({ ok: true })
    expect(await memoryApi('GET')).toMatchObject({ json: { content: null } })

    const second = await memoryApi('DELETE')
    expect(second.status).toBe(200)
    expect(second.json).toEqual({ ok: true })
  })

  it('入参校验：缺字段 / 类型不对 / 超长 → 400', async () => {
    for (const body of [{}, { content: 123 }, { content: 'x'.repeat(20001) }, { text: 'a' }]) {
      const got = await memoryApi('PUT', body)
      expect(got.status, JSON.stringify(body)).toBe(400)
      expect(String(got.json.error)).toContain('invalid-input')
    }
  })
})

describe('记忆与对话是同一份（resource 作用域）', () => {
  it('在记忆页写入后，新线程的下一轮系统消息里带着它', async () => {
    const written = '# 用户信息\n- 姓名：张三\n- 偏好：简短回答'
    expect((await memoryApi('PUT', { content: written })).status).toBe(200)

    const before = calls.length
    await chat('thread-memory-read', '我叫什么？')

    expect(calls.length).toBe(before + 1)
    const injected = systemText(calls[calls.length - 1])
    expect(injected).toContain('张三')
    expect(injected).toContain('简短回答')
  }, 30_000)

  it('助手用 updateWorkingMemory 工具写下的内容，GET 里能看到（记忆页与模型同一份）', async () => {
    scripts.length = 0
    scripts.push(() =>
      toolCallScript('call-wm', 'updateWorkingMemory', {
        memory: '# 用户信息\n- 姓名：李四\n- 城市：上海'
      })
    )
    scripts.push(() => textScript('记住了。'))

    await chat('thread-memory-write', '我叫李四，住在上海')

    const got = await memoryApi('GET')
    expect(got.status).toBe(200)
    const content = String(got.json.content)
    expect(content).toContain('李四')
    expect(content).toContain('上海')
    // 模板口径是整块替换：上一条用例写的"张三"不该还在
    expect(content).not.toContain('张三')
  }, 30_000)
})
