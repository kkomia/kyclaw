// @vitest-environment node
/**
 * 复现用例：工具调用 → 工具结果 → 第二轮生成 的整链路（真实 mastra server + stub 模型）。
 *
 * 现场（15:42:56 的 run）：第一轮 deepseek-flash 生成 → `glob` 工具成功 → 工具结果到达客户端后
 * 1ms 整条流被掐断，后面没有第二次生成、没有 error span。该 run 的环境：两个工作区（都 mode=full）、
 * 模块 1 的新工具集与新指令、模块 3-v2 的 Memory 装配。本 spec 把这几条拼齐：
 *   1. 基本链路：glob（带路径）成功 → 第二轮生成跑完（证明「工具结果 → 续跑」没断）；
 *   2. 双工作区不带路径：glob 返回工具错误 → 第二轮生成照样跑完；
 *   3. 双工作区 + 结果落在第二个工作区：同上。
 * 任何一条出现「工具结果后没有第二轮」就说明命中了现场的掐断面。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { threadMemoryBody } from '../../shared/threads'
import type { Workspace } from '../../shared/settings'

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }
const FINISH_TOOLS = { unified: 'tool-calls' as const, raw: 'tool_calls' }
const FINISH_LENGTH = { unified: 'length' as const, raw: 'length' }
const FINISH_ERROR = { unified: 'error' as const, raw: 'error' }

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

/** 工具调用 + finishReason=length（输出被长度截断时模型仍可能吐出完整工具调用） */
function lengthToolCallScript(toolCallId: string, toolName: string, input: unknown): StreamPart[] {
  const json = JSON.stringify(input)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: json },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input: json },
    { type: 'finish', finishReason: FINISH_LENGTH, usage: USAGE }
  ]
}

/** 工具调用 + finishReason=error（对照组：供应商侧出错） */
function errorToolCallScript(toolCallId: string, toolName: string, input: unknown): StreamPart[] {
  const json = JSON.stringify(input)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: json },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input: json },
    { type: 'finish', finishReason: FINISH_ERROR, usage: USAGE }
  ]
}

/** SSE 响应体 → 结构化 part 列表（跳过 [DONE] 终结行） */
function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

let dir: string
let workspaceA: string
let workspaceB: string
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []

async function chat(messages: unknown[], threadId: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ messages, ...threadMemoryBody(threadId) })
  })
  expect(response.status).toBe(200)
  return await response.text()
}

function user(text: string): Record<string, unknown> {
  return { id: 'u-1', role: 'user', parts: [{ type: 'text', text }] }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-roundtrip-'))
  mkdirSync(join(dir, 'ws-a'), { recursive: true })
  mkdirSync(join(dir, 'ws-b'), { recursive: true })
  workspaceA = realpathSync.native(join(dir, 'ws-a'))
  workspaceB = realpathSync.native(join(dir, 'ws-b'))
  writeFileSync(join(workspaceA, 'alpha.txt'), 'a', 'utf8')
  writeFileSync(join(workspaceB, 'beta.txt'), 'b', 'utf8')

  // 现场的工作区列表：两个、都 mode=full（写类不弹审批；工具直接执行）
  const workspaces: Workspace[] = [
    { path: workspaceA, mode: 'full' },
    { path: workspaceB, mode: 'full' }
  ]

  const model = new MockLanguageModelV4({
    provider: 'kyclaw-roundtrip-mock',
    modelId: 'kyclaw-roundtrip-mock',
    doStream: async () => {
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({
          chunks: script(),
          initialDelayInMs: 0,
          chunkDelayInMs: 0
        })
      }
    }
  })

  server = await startAgentServer({
    dataDir: dir,
    model,
    workspaces: () => workspaces,
    projects: () => []
  })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('工具结果 → 第二轮生成（复现 15:42:56 的掐断面）', () => {
  it('glob（带路径，第一个工作区）成功 → 第二轮生成跑完、流正常收尾', async () => {
    scripts.length = 0
    scripts.push(() => toolCallScript('call-glob', 'glob', { pattern: '**/*', path: workspaceA }))
    scripts.push(() => textScript('已经看完目录了。'))

    const body = await chat([user('看看这个文件夹里有什么')], 'thread-roundtrip-1')
    const parts = sseParts(body)

    const output = parts.find(
      (part) => part.type === 'tool-output-available' && part.toolCallId === 'call-glob'
    )
    expect(output).toBeDefined()
    expect(String(output?.output)).toContain('alpha.txt')
    // 关键判据：工具结果之后还有第二轮文本（现场是这里没了）
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
      '已经看完目录了。'
    ])
    expect(parts.some((part) => part.type === 'tool-output-error')).toBe(false)
    expect(parts.some((part) => part.type === 'error')).toBe(false)
    expect(body).toContain('[DONE]')
  }, 30_000)

  it('glob 不带路径（双工作区 → 工具错误结果）→ 第二轮生成照样跑完', async () => {
    scripts.length = 0
    scripts.push(() => toolCallScript('call-glob-nopath', 'glob', { pattern: '**/*' }))
    scripts.push(() => textScript('我分不清在哪个工作区里搜。'))

    const parts = sseParts(await chat([user('列一下文件')], 'thread-roundtrip-2'))

    const error = parts.find(
      (part) => part.type === 'tool-output-error' && part.toolCallId === 'call-glob-nopath'
    )
    expect(error).toBeDefined()
    expect(String(error?.errorText)).toContain('多个授权工作区')
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
      '我分不清在哪个工作区里搜。'
    ])
  }, 30_000)

  it('glob（带路径，第二个工作区）成功 → 第二轮生成跑完', async () => {
    scripts.length = 0
    scripts.push(() => toolCallScript('call-glob-b', 'glob', { pattern: '**/*', path: workspaceB }))
    scripts.push(() => textScript('第二个工作区看完了。'))

    const parts = sseParts(await chat([user('另一个文件夹呢')], 'thread-roundtrip-3'))

    const output = parts.find(
      (part) => part.type === 'tool-output-available' && part.toolCallId === 'call-glob-b'
    )
    expect(output).toBeDefined()
    expect(String(output?.output)).toContain('beta.txt')
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
      '第二个工作区看完了。'
    ])
  }, 30_000)

  it('已知行为（钉住）：第一轮 finishReason=length（带工具调用）→ 工具仍执行，但不续跑', async () => {
    scripts.length = 0
    scripts.push(() =>
      lengthToolCallScript('call-len', 'glob', { pattern: '**/*', path: workspaceA })
    )
    scripts.push(() => textScript('不该出现'))

    const parts = sseParts(await chat([user('看看文件夹')], 'thread-roundtrip-len'))

    // Mastra 把 length 当终止档：工具照执行、结果照发，但没有第二轮生成、也没有 error part。
    // （这是引擎行为，不在本轮修复范围；钉住它，防以后把它当"静默掐断"再查一遍。）
    const output = parts.find(
      (part) => part.type === 'tool-output-available' && part.toolCallId === 'call-len'
    )
    expect(output).toBeDefined()
    expect(parts.filter((part) => part.type === 'text-delta')).toEqual([])
    expect(parts.some((part) => part.type === 'error')).toBe(false)
    expect(parts.find((part) => part.type === 'finish')).toMatchObject({ finishReason: 'length' })
    // 第二轮脚本没被消费 = 服务端确实没有再生成
    expect(scripts.length).toBe(1)
  }, 30_000)

  it('对照：finishReason=error（带工具调用）→ error 面会出来（客户端看得到，不是静默）', async () => {
    scripts.length = 0
    scripts.push(() =>
      errorToolCallScript('call-err', 'glob', { pattern: '**/*', path: workspaceA })
    )
    scripts.push(() => textScript('不该出现'))

    const parts = sseParts(await chat([user('看看文件夹')], 'thread-roundtrip-err'))

    expect(parts.some((part) => part.type === 'error')).toBe(true)
    expect(parts.find((part) => part.type === 'finish')).toMatchObject({ finishReason: 'error' })
    expect(scripts.length).toBe(1)
  }, 30_000)
})

describe('交付链路（round 50）：deliver_file 的结构化结果过线', () => {
  it('模型调 deliver_file：结果字段原样到客户端（渲染端交付卡读的就是它们）', async () => {
    scripts.length = 0
    scripts.push(() =>
      toolCallScript('call-deliver', 'deliver_file', { path: 'alpha.txt', note: '交接材料' })
    )
    scripts.push(() => textScript('已经交给你了。'))

    const parts = sseParts(await chat([user('把这份材料交付给我')], 'thread-roundtrip-deliver'))

    const output = parts.find(
      (part) => part.type === 'tool-output-available' && part.toolCallId === 'call-deliver'
    )
    expect(output).toBeDefined()
    // 卡片要的字段一个不少（`path` 是相对会话工作区的写法，正斜杠）
    expect(output?.output).toMatchObject({
      path: 'alpha.txt',
      name: 'alpha.txt',
      size: 1,
      mimeType: 'text/plain',
      note: '交接材料'
    })
    // 交付是读类：不出审批挂起、也不出错误面
    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(false)
    expect(parts.some((part) => part.type === 'tool-output-error')).toBe(false)
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
      '已经交给你了。'
    ])
  }, 30_000)

  it('一次给了多件：回的是可读回执（字符串），不是错误面也不是交付卡（round 70）', async () => {
    scripts.length = 0
    scripts.push(() =>
      toolCallScript('call-deliver-many', 'deliver_file', {
        path: 'alpha.txt\nbeta.txt'
      })
    )
    scripts.push(() => textScript('那我一件一件交。'))

    const parts = sseParts(await chat([user('这两份都交给我')], 'thread-roundtrip-deliver-many'))

    const output = parts.find(
      (part) => part.type === 'tool-output-available' && part.toolCallId === 'call-deliver-many'
    )
    expect(typeof output?.output).toBe('string')
    expect(String(output?.output)).toContain('一次只交付一件')
    // 回执不是错误：模型拿得到它，照常续跑（这就是"不抛错"的判据）
    expect(parts.some((part) => part.type === 'tool-output-error')).toBe(false)
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
      '那我一件一件交。'
    ])
  }, 30_000)
})
