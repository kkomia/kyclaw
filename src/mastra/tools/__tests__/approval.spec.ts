// @vitest-environment node
/**
 * Step 2 集成（审批接线）：真服务（startAgentServer：chatRoute v7 + libsql + Memory + T11 工具集）
 * 上跑 mock 模型的工具调用。
 *
 * 判据（brief + spec §5.2）：
 *   - 写类工具在 mode='ask' 的工作区 → 服务端流里出现 `tool-approval-request`
 *     （AI SDK UI 协议里就是客户端的 `approval-requested` 状态）；
 *   - 批准回灌（approval-responded 消息，和 useChat 的发法一致）→ 工具执行、文件落盘、模型继续；
 *   - mode='full' 的工作区 → 不弹审批，直接执行；
 *   - 只读工具（glob）→ 不弹审批；
 *   - 工作区外的 write → 不弹审批，直接工具错误（fail closed，文件不落盘）。
 *
 * mock 模型按"脚本队列"回放：每个用例推进自己的脚本，跑完清空。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../../main/agent/service'
import { KYCLAW_AGENT_ID } from '../../agents/kyclaw'
import { threadMemoryBody } from '../../../shared/threads'
import type { Project } from '../../../shared/projects'
import type { Workspace } from '../../../shared/settings'

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 }
}
const FINISH_STOP = { unified: 'stop' as const, raw: 'stop' }
const FINISH_TOOLS = { unified: 'tool-calls' as const, raw: 'tool_calls' }

/** mock 流的 chunk 类型（从 MockLanguageModelV4 的 doStream 签名上取，避免手抄 spec） */
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
  return [
    { type: 'stream-start', warnings: [] },
    ...toolCallChunks(toolCallId, toolName, input),
    { type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE }
  ]
}

/** 一次工具调用的 chunk 段（不含 stream-start / finish，供"同一步多个调用"拼装） */
function toolCallChunks(toolCallId: string, toolName: string, input: unknown): StreamPart[] {
  const json = JSON.stringify(input)
  return [
    { type: 'tool-input-start', id: toolCallId, toolName },
    { type: 'tool-input-delta', id: toolCallId, delta: json },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName, input: json }
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
let workspace: string
let workspaces: Workspace[]
/** T18：项目清单（测试里可变；映射写入走真路由 /api/projects/mappings） */
const projects: Project[] = []
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []

function pushWriteScript(toolCallId: string, path: string, content: string): void {
  scripts.push(() => toolCallScript(toolCallId, 'write', { path, content }))
  scripts.push(() => textScript('好，处理完了。'))
}

async function chat(messages: unknown[], threadId: string): Promise<string> {
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ messages, ...threadMemoryBody(threadId) })
  })
  expect(response.status).toBe(200)
  return await response.text()
}

/** 用 AI SDK 客户端的口径回灌一条"审批已回应"的助手消息（和 useChat 发的一样） */
function approvedReply(
  messageId: unknown,
  toolCallId: string,
  input: unknown,
  approvalId: unknown,
  approved: boolean
): Record<string, unknown> {
  return {
    id: messageId,
    role: 'assistant',
    parts: [
      {
        type: `tool-write`,
        toolCallId,
        state: 'approval-responded',
        input,
        approval: {
          id: approvalId,
          approved,
          ...(approved ? {} : { reason: '先别写这个文件' })
        }
      }
    ]
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-approval-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  mkdirSync(join(dir, 'outside'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))
  workspaces = [{ path: workspace, mode: 'ask' }]

  const model = new MockLanguageModelV4({
    provider: 'kyclaw-approval-mock',
    modelId: 'kyclaw-approval-mock',
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
    projects: () => projects
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

describe('审批接线：写类工具 → approval-requested → 批准执行', () => {
  it('ask 工作区：流里出现 tool-approval-request；批准回灌后文件才落盘、模型继续', async () => {
    scripts.length = 0
    pushWriteScript('call-a', 'a.txt', 'hello 世界')
    const user = { id: 'u-a', role: 'user', parts: [{ type: 'text', text: '写个文件' }] }

    const first = sseParts(await chat([user], 'thread-approval-a'))
    const approval = first.find((part) => part.type === 'tool-approval-request')
    expect(approval).toBeDefined()
    expect(approval?.toolCallId).toBe('call-a')
    expect(String(approval?.approvalId)).toMatch(/::call-a$/)

    // 没批准之前：工具没执行，文件不存在
    expect(existsSync(join(workspace, 'a.txt'))).toBe(false)
    expect(first.some((part) => part.type === 'tool-output-available')).toBe(false)

    const messageId = first.find((part) => part.type === 'start')?.messageId
    const assistant = approvedReply(
      messageId,
      'call-a',
      { path: 'a.txt', content: 'hello 世界' },
      approval?.approvalId,
      true
    )
    const second = sseParts(await chat([user, assistant], 'thread-approval-a'))

    expect(second.some((part) => part.type === 'tool-output-available')).toBe(true)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello 世界')
    expect(second.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
      '好，处理完了。'
    ])
  }, 30_000)

  it('拒绝审批：工具不执行、文件不落盘，模型拿到拒绝后继续', async () => {
    scripts.length = 0
    pushWriteScript('call-b', 'b.txt', 'x')
    const user = { id: 'u-b', role: 'user', parts: [{ type: 'text', text: '写个文件' }] }

    const first = sseParts(await chat([user], 'thread-approval-b'))
    const approval = first.find((part) => part.type === 'tool-approval-request')
    const messageId = first.find((part) => part.type === 'start')?.messageId
    const assistant = approvedReply(
      messageId,
      'call-b',
      { path: 'b.txt', content: 'x' },
      approval?.approvalId,
      false
    )
    const second = sseParts(await chat([user, assistant], 'thread-approval-b'))

    expect(existsSync(join(workspace, 'b.txt'))).toBe(false)
    expect(second.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
      '好，处理完了。'
    ])
  }, 30_000)
})

describe('审批接线：不该弹的都不弹', () => {
  it('full 工作区：write 直接执行（无 approval-requested）', async () => {
    scripts.length = 0
    pushWriteScript('call-c', 'c.txt', 'full access')
    workspaces[0].mode = 'full'
    try {
      const parts = sseParts(
        await chat(
          [{ id: 'u-c', role: 'user', parts: [{ type: 'text', text: '写' }] }],
          'thread-full'
        )
      )
      expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(false)
      expect(parts.some((part) => part.type === 'tool-output-available')).toBe(true)
      expect(readFileSync(join(workspace, 'c.txt'), 'utf8')).toBe('full access')
    } finally {
      workspaces[0].mode = 'ask'
    }
  }, 30_000)

  it('只读工具（glob）：不弹审批，结果直接回来', async () => {
    scripts.length = 0
    scripts.push(() => toolCallScript('call-d', 'glob', { pattern: '*.txt' }))
    scripts.push(() => textScript('列完了。'))

    const parts = sseParts(
      await chat(
        [{ id: 'u-d', role: 'user', parts: [{ type: 'text', text: '列文件' }] }],
        'thread-read'
      )
    )
    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(false)
    const output = parts.find((part) => part.type === 'tool-output-available')
    expect(String(output?.output)).toContain('a.txt')
  }, 30_000)

  it('工作区外的 write：不弹审批，直接工具错误（fail closed）', async () => {
    scripts.length = 0
    const outside = join(dir, 'outside', 'evil.txt')
    pushWriteScript('call-e', outside, 'hacked')

    const parts = sseParts(
      await chat(
        [{ id: 'u-e', role: 'user', parts: [{ type: 'text', text: '写外面' }] }],
        'thread-outside'
      )
    )
    expect(parts.some((part) => part.type === 'tool-approval-request')).toBe(false)
    const error = parts.find((part) => part.type === 'tool-output-error')
    expect(error).toBeDefined()
    expect(String(error?.errorText)).toContain('授权工作区')
    expect(existsSync(outside)).toBe(false)
  }, 30_000)
})

describe('项目会话续跑（T18 复核 minor②）：项目里写 → 审批决策 → 文件落项目目录', () => {
  it('同一步 [记忆工具 + 待审批写]：批准回灌后续跑、notes.md 落在项目目录（不是数据目录）', async () => {
    const projectPath = realpathSync.native(mkdtempSync(join(dir, 'project-')))
    projects.push({
      id: 'p-notes',
      name: 'notes 项目',
      path: projectPath,
      createdAt: '2026-10-11T00:00:00.000Z'
    })
    workspaces.push({ path: projectPath, mode: 'ask' })
    try {
      // 会话 → 项目映射：走渲染端新建会话时写的那条真路由
      const mapping = await fetch(`${server.baseUrl}/api/projects/mappings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ threadId: 'thread-project', projectId: 'p-notes' })
      })
      expect(mapping.status).toBe(200)

      scripts.length = 0
      // 同一步两个调用：Mastra 记忆工具（服务端执行、UI 里停在 input-available）+ 待审批的项目写
      scripts.push(() => [
        { type: 'stream-start', warnings: [] },
        ...toolCallChunks('call-wm', 'updateWorkingMemory', { memory: '# 用户信息\n- 偏好：简短' }),
        ...toolCallChunks('call-w', 'write', { path: 'notes.md', content: '项目里的笔记' }),
        { type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE }
      ])
      scripts.push(() => textScript('好，处理完了。'))

      const user = {
        id: 'u-p',
        role: 'user',
        parts: [{ type: 'text', text: '记住我的偏好，然后在项目里写个 notes.md' }]
      }
      const first = sseParts(await chat([user], 'thread-project'))
      const approval = first.find((part) => part.type === 'tool-approval-request')
      expect(approval?.toolCallId).toBe('call-w')
      // 决策前不落盘
      expect(existsSync(join(projectPath, 'notes.md'))).toBe(false)

      // 决策后渲染端（useChat）回灌的那条助手消息：记忆 part 原样（永远停在 input-available）
      // + 写 part approval-responded —— 与 approval-flow.spec 里 mock transport 复现的形状一致。
      const messageId = first.find((part) => part.type === 'start')?.messageId
      const assistant = {
        id: messageId,
        role: 'assistant',
        parts: [
          {
            type: 'tool-updateWorkingMemory',
            toolCallId: 'call-wm',
            state: 'input-available',
            input: { memory: '# 用户信息\n- 偏好：简短' }
          },
          {
            type: 'tool-write',
            toolCallId: 'call-w',
            state: 'approval-responded',
            input: { path: 'notes.md', content: '项目里的笔记' },
            approval: { id: approval?.approvalId, approved: true }
          }
        ]
      }
      const second = sseParts(await chat([user, assistant], 'thread-project'))

      // 续跑：写工具执行、文件落**项目目录**（会话根用的是项目路径；没映射会落到别处）
      expect(
        second.some((part) => part.type === 'tool-output-available' && part.toolCallId === 'call-w')
      ).toBe(true)
      expect(readFileSync(join(projectPath, 'notes.md'), 'utf8')).toBe('项目里的笔记')
      expect(existsSync(join(dir, 'notes.md'))).toBe(false)
      expect(second.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual(
        ['好，处理完了。']
      )
    } finally {
      const index = workspaces.findIndex((candidate) => candidate.path === projectPath)
      if (index !== -1) workspaces.splice(index, 1)
      projects.length = 0
    }
  }, 30_000)
})
