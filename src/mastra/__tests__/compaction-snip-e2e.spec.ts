// @vitest-environment node
/**
 * round 75 · snip 档的**端到端**验证（真服务：真 libsql + 真 Memory + 真 chat 路由 + stub 模型）。
 *
 * 单元测试能证明纯函数与处理器改的是"这一轮发给模型的那份"，但证明不了它在**真装配**下也成立
 * （处理器排在 memory 历史载入之后、消息来源标记、prompt 最终形态、存储是否被动过）。
 * 这条把整条链路跑一遍：
 *   1. 一轮 `read` 大文件（15 万字符）→ 工具结果落进存储；
 *   2. 再聊 6 轮（12 条消息）把那条结果挤出保留窗口；
 *   3. POST /compact → **level 是 snip**、摘要模型一次都没被调（这一版的省钱证据）；
 *   4. 再发一轮 → 模型这一轮收到的 prompt 里大文件正文已换成占位说明（深处的行不在了），
 *      而**存储里那条工具结果的原文一字未动**（GET /messages 仍能取回全文）。
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import {
  compactThreadResponseSchema,
  threadMemoryBody,
  type ThreadCompaction
} from '../../shared/threads'
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

const THREAD_ID = 'thread-snip-e2e'
/** 大文件的独特标记：开头那行会留在占位说明里，深处的与结尾那行必须被省掉 */
const HEAD_MARK = 'HUGE-HEAD-第一行'
const DEEP_MARK = 'HUGE-DEEP-第 900 行'
const TAIL_MARK = 'HUGE-TAIL-最后一行'
const HUGE_LINES = 1_200

function hugeFile(): string {
  const lines = Array.from({ length: HUGE_LINES }, (_, index) =>
    `第 ${index + 1} 行：${'z'.repeat(100)}${index === 899 ? DEEP_MARK : ''}`
  )
  return [`${HEAD_MARK}`, ...lines, TAIL_MARK].join('\n')
}

let dir: string
let workspace: string
let hugePath: string
let server: AgentServerHandle
const chatPrompts: unknown[] = []
const generateCalls: { system?: unknown; prompt?: unknown }[] = []
const scripts: Array<() => StreamPart[]> = []

function authed(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${server.token}`,
      ...init.headers
    }
  }
}

async function say(text: string): Promise<void> {
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    ...authed(),
    body: JSON.stringify({
      messages: [{ id: `u-${chatPrompts.length}`, role: 'user', parts: [{ type: 'text', text }] }],
      ...threadMemoryBody(THREAD_ID)
    })
  })
  expect(response.status).toBe(200)
  await response.text()
}

async function storedMessages(): Promise<{ id: string; role: string; content: unknown }[]> {
  const response = await fetch(`${server.baseUrl}/api/threads/${THREAD_ID}/messages`, authed())
  expect(response.status).toBe(200)
  return ((await response.json()) as { messages: { id: string; role: string; content: unknown }[] })
    .messages
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-snip-e2e-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))
  hugePath = join(workspace, 'huge.txt')
  writeFileSync(hugePath, hugeFile(), 'utf8')

  const workspaces: Workspace[] = [{ path: workspace, mode: 'full' }]
  const model = new MockLanguageModelV4({
    provider: 'kyclaw-snip-mock',
    modelId: 'kyclaw-snip-mock',
    doStream: async (options: { prompt: unknown }) => {
      chatPrompts.push(options.prompt)
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({
          chunks: script(),
          initialDelayInMs: 0,
          chunkDelayInMs: 0
        })
      }
    },
    doGenerate: async (options: { system?: unknown; prompt?: unknown }) => {
      generateCalls.push({ system: options.system, prompt: options.prompt })
      return {
        content: [{ type: 'text' as const, text: '## 要点\n- 这版不该走到摘要' }],
        finishReason: FINISH_STOP,
        usage: USAGE,
        warnings: []
      }
    }
  })

  server = await startAgentServer({
    dataDir: dir,
    model,
    workspaces: () => workspaces,
    projects: () => []
    // 注意：**不传 defaultWorkspace** —— 传了的话会话根会收窄成 <workspace>/tasks/<threadId 前 8 位>
    // （main/projects.ts 的 sessionRoots），上面那个绝对路径就落到了会话根之外、read 会按
    // "不在任何授权工作区内"拒掉。这条用例要测的是 snip，不是会话根解析，所以让根 = 工作区本身。
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

describe('端到端：大工具结果 → 压缩停在 snip → 模型不再看到全文、存储一字未动', () => {
  it('一整条链路', async () => {
    scripts.length = 0
    // 第 1 轮：模型调用 read 读大文件（结果落进存储），再收一句
    scripts.push(() => toolCallScript('call-read', 'read', { path: hugePath }))
    scripts.push(() => textScript('读完了，文件很长。'))
    await say('读一下 huge.txt')

    // 再聊 6 轮（12 条消息），把那条大结果挤出保留窗口（缺省保留最近 10 条）
    for (let index = 0; index < 6; index += 1) {
      scripts.push(() => textScript(`第 ${index + 2} 轮的回复。`))
      await say(`第 ${index + 2} 轮的问题`)
    }

    const before = await storedMessages()
    expect(before.length).toBeGreaterThanOrEqual(14)
    // 工具结果真落了库（原文在存储里，界面回灌靠它）
    expect(JSON.stringify(before)).toContain(TAIL_MARK)

    // —— 压缩：应该停在 snip 档，摘要模型一次都不调 ——
    generateCalls.length = 0
    const compactResponse = await fetch(
      `${server.baseUrl}/api/threads/${THREAD_ID}/compact`,
      authed({ method: 'POST', body: '{}' })
    )
    expect(compactResponse.status).toBe(200)
    const outcome = compactThreadResponseSchema.parse(await compactResponse.json())
    expect(outcome.compacted).toBe(true)
    const record: ThreadCompaction | null = outcome.compaction
    expect(record?.level).toBe('snip')

    // 省钱证据：整轮压缩里没有任何一次"会话压缩器"的生成调用
    const compactionCalls = generateCalls.filter((call) =>
      String(call.system ?? '').includes('你是会话压缩器')
    )
    expect(compactionCalls).toHaveLength(0)
    expect(record?.summary).toContain('没有调用模型')

    // 一条消息都没删（存储里仍是大文件全文 + 所有对话）
    const afterCompact = await storedMessages()
    expect(afterCompact).toHaveLength(before.length)
    expect(JSON.stringify(afterCompact)).toContain(TAIL_MARK)

    // —— 再发一轮：看模型这一轮真收到了什么 ——
    scripts.push(() => textScript('好，我按占位说明的指路来。'))
    await say('继续')
    const prompt = JSON.stringify(chatPrompts[chatPrompts.length - 1])
    const promptChars = prompt.length

    // ① 大文件的正文不在这一轮 prompt 里了（深处的行与结尾行都省掉了）
    expect(prompt).not.toContain(TAIL_MARK)
    expect(prompt).not.toContain(DEEP_MARK)
    // ② 占位说明在：模型知道这里曾经有什么、去哪找
    expect(prompt).toContain('[工具结果已精简]')
    expect(prompt).toContain('huge.txt')
    expect(prompt).toContain('重新执行')
    // ③ 用户原话一字未动
    expect(prompt).toContain('读一下 huge.txt')
    expect(prompt).toContain('继续')
    // ④ 存储/界面那一侧：原文仍然完整（GET /messages 回到的就是全文）
    const finalStored = await storedMessages()
    expect(JSON.stringify(finalStored)).toContain(TAIL_MARK)
    expect(JSON.stringify(finalStored)).toContain(DEEP_MARK)

    console.log(
      '[snip 端到端] 存储消息 %d 条；压缩档位 %s；摘要模型调用 %d 次；这一轮 prompt %d 字符（大文件 %d 字符被换成占位说明）',
      finalStored.length,
      String(record?.level),
      compactionCalls.length,
      promptChars,
      hugeFile().length
    )
  }, 60_000)
})
