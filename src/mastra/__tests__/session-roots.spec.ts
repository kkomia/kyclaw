// @vitest-environment node
/**
 * 项目工作区 · 会话根的真服务用例（T18 Step 4）。
 *
 * 全部走真链路：settings.json 落盘（workspaces / defaultWorkspace / projects）+
 * libsql 的 session_projects 映射（PUT /api/projects/mappings）+ 真 agent 服务跑一轮工具调用。
 *
 * 钉住的口径（细节见 main/projects.ts 的 sessionRoots 与 tools/guard.ts 的 needsApproval 头注）：
 *   ① 会话属于某项目 → 文件工具的根就是项目路径（项目里写 = 按项目那条工作区的模式走审批）；
 *   ② 会话没有项目 → 默认工作区；默认工作区也没指认 → 整份授权列表（T10 口径不变）；
 *   ③ **执行层比审批层严**：目标在工作区外/会话范围外时执行 fail closed（工具错误、不落盘）——
 *      审批拿不到会话，所以按授权列表（超集）问，执行按会话根（子集）判；
 *   ④ 映射落在 libsql：换一个服务实例（= 重启）还读得回来（service 启动时 load 进镜像）；
 *   ⑤ 删除会话时它的映射一起清掉。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { readSettings, settingsPath, updateSettings } from '../../main/settings'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import type { KyclawModel } from '../model'
import { LOCAL_USER_RESOURCE_ID, threadMemoryBody } from '../../shared/threads'

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

function writeScript(toolCallId: string, path: string, content: string): StreamPart[] {
  const json = JSON.stringify({ path, content })
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id: toolCallId, toolName: 'write' },
    { type: 'tool-input-delta', id: toolCallId, delta: json },
    { type: 'tool-input-end', id: toolCallId },
    { type: 'tool-call', toolCallId, toolName: 'write', input: json },
    { type: 'finish', finishReason: FINISH_TOOLS, usage: USAGE }
  ]
}

function sseParts(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
}

let dir: string
let projectDir: string
let defaultDir: string
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []

const PROJECT = { id: 'p1', name: '插件', createdAt: '2026-10-11T00:00:00.000Z' }

function mockModel(): KyclawModel {
  return new MockLanguageModelV4({
    provider: 'kyclaw-projects-mock',
    modelId: 'kyclaw-projects-mock',
    doStream: async () => {
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({ chunks: script(), initialDelayInMs: 0, chunkDelayInMs: 0 })
      }
    }
  }) as unknown as KyclawModel
}

async function chat(threadId: string, messageId: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [{ id: messageId, role: 'user', parts: [{ type: 'text', text: '写一个文件' }] }],
      ...threadMemoryBody(threadId)
    })
  })
  expect(response.status).toBe(200)
  return sseParts(await response.text())
}

function authorized(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${server.baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${server.token}`,
      ...init.headers
    }
  })
}

async function mapSession(threadId: string, projectId: string | null): Promise<void> {
  const response = await authorized('/api/projects/mappings', {
    method: 'PUT',
    body: JSON.stringify({ threadId, projectId })
  })
  expect(response.status).toBe(200)
}

async function mappings(): Promise<Array<{ threadId: string; projectId: string }>> {
  const response = await authorized('/api/projects/mappings')
  expect(response.status).toBe(200)
  const body = (await response.json()) as {
    sessions: Array<{ threadId: string; projectId: string }>
  }
  return body.sessions
}

function toolError(parts: Array<Record<string, unknown>>): string {
  const error = parts.find((part) => part.type === 'tool-output-error')
  return String(error?.errorText ?? '')
}

/** 跑一轮"模型要写某个文件"的对话；返回 part 列表（审批卡/工具错误都在里面） */
async function runWrite(
  threadId: string,
  toolCallId: string,
  path: string,
  content: string
): Promise<Array<Record<string, unknown>>> {
  scripts.length = 0
  scripts.push(() => writeScript(toolCallId, path, content))
  scripts.push(() => textScript('好，处理完了。'))
  return await chat(threadId, `u-${toolCallId}`)
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-session-roots-'))
  mkdirSync(join(dir, '项目'), { recursive: true })
  mkdirSync(join(dir, '默认'), { recursive: true })
  projectDir = realpathSync.native(join(dir, '项目'))
  defaultDir = realpathSync.native(join(dir, '默认'))
  writeFileSync(join(dir, 'outside.txt'), 'X', 'utf8')
  // 两个目录都写一种"会在审批那层放行"的写法吗？不——默认档是 ask，用例自己按需改
  updateSettings(settingsPath(dir), {
    workspaces: [
      { path: projectDir, mode: 'ask' },
      { path: defaultDir, mode: 'ask' }
    ],
    defaultWorkspace: defaultDir,
    projects: [{ ...PROJECT, path: projectDir }]
  })

  server = await startAgentServer({ dataDir: dir, model: mockModel() })
}, 60_000)

afterAll(async () => {
  await server?.stop()
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

describe('会话↔项目映射的路由（T18）', () => {
  it('PUT 写一条、GET 读回来；再 PUT null 摘掉', async () => {
    await mapSession('thread-route', PROJECT.id)
    expect(await mappings()).toContainEqual({ threadId: 'thread-route', projectId: PROJECT.id })

    await mapSession('thread-route', null)
    expect(await mappings()).not.toContainEqual(
      expect.objectContaining({ threadId: 'thread-route' })
    )
  })

  it('入参不合法（缺字段 / 空串 / 多字段）→ 400', async () => {
    for (const body of [
      { threadId: 't' },
      { projectId: 'p' },
      { threadId: '', projectId: 'p' },
      { threadId: 't', projectId: 'p', extra: 1 }
    ]) {
      const response = await authorized('/api/projects/mappings', {
        method: 'PUT',
        body: JSON.stringify(body)
      })
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
  })
})

describe('会话根：项目 → 默认工作区 → 授权列表（T18）', () => {
  it('① 会话属于项目：项目里的写按项目那条工作区的模式走审批（ask → 弹卡、不落盘）', async () => {
    await mapSession('thread-project', PROJECT.id)

    const asked = await runWrite(
      'thread-project',
      'p-inside',
      join(projectDir, 'inside.txt'),
      '项目里'
    )
    expect(asked.some((part) => part.type === 'tool-approval-request')).toBe(true)
    expect(existsSync(join(projectDir, 'inside.txt'))).toBe(false)
  })

  it('② 会话没有项目：默认工作区（full → 不弹卡、直接写成功）', async () => {
    updateSettings(settingsPath(dir), {
      workspaces: [
        { path: projectDir, mode: 'ask' },
        { path: defaultDir, mode: 'full' }
      ]
    })

    const done = await runWrite(
      'thread-default',
      'd-inside',
      join(defaultDir, 'inside.txt'),
      '默认里'
    )
    expect(done.some((part) => part.type === 'tool-approval-request')).toBe(false)
    expect(readFileSync(join(defaultDir, 'inside.txt'), 'utf8')).toBe('默认里')
  })

  it('③ 执行层比审批层严：项目会话写到默认工作区（full，不弹卡）→ 工具错误、fail closed', async () => {
    // 默认工作区此时是 full：审批那层（授权列表超集）不问；执行那层（会话根 = 项目）解析不到 → 拒
    const refused = await runWrite(
      'thread-project',
      'p-outside',
      join(defaultDir, 'outside.txt'),
      '越界'
    )

    expect(refused.some((part) => part.type === 'tool-approval-request')).toBe(false)
    expect(toolError(refused)).toContain('不在任何授权工作区内')
    expect(existsSync(join(defaultDir, 'outside.txt'))).toBe(false)
    // 项目里的文件不受影响；映射也还在
    expect(existsSync(join(projectDir, 'inside.txt'))).toBe(false)
  })

  it('③b 连"目标在授权列表外"也一样：项目会话写工作区外 → 工具错误（不问、不落盘）', async () => {
    const refused = await runWrite('thread-project', 'p-far', join(dir, 'outside.txt'), '更外面')

    expect(refused.some((part) => part.type === 'tool-approval-request')).toBe(false)
    expect(toolError(refused)).toContain('不在任何授权工作区内')
    expect(readFileSync(join(dir, 'outside.txt'), 'utf8')).toBe('X')
  })

  it('④ 没指认默认工作区、会话也没有项目：退回整份授权列表（T10 口径不变）', async () => {
    updateSettings(settingsPath(dir), { defaultWorkspace: null })

    const asked = await runWrite('thread-free', 'f-ask', join(projectDir, 'free.txt'), '自由')
    expect(asked.some((part) => part.type === 'tool-approval-request')).toBe(true)
    expect(existsSync(join(projectDir, 'free.txt'))).toBe(false)

    // 恢复默认工作区：同一个会话现在收窄到默认工作区（full）→ 写默认目录不问、写项目目录 fail closed
    updateSettings(settingsPath(dir), { defaultWorkspace: defaultDir })
    const done = await runWrite('thread-free', 'f-default', join(defaultDir, 'free.txt'), '收窄了')
    expect(done.some((part) => part.type === 'tool-approval-request')).toBe(false)
    expect(readFileSync(join(defaultDir, 'free.txt'), 'utf8')).toBe('收窄了')

    // 项目目录也切 full：审批（超集）不问、执行（会话根 = 默认工作区）解析不到 → 工具错误
    updateSettings(settingsPath(dir), {
      workspaces: [
        { path: projectDir, mode: 'full' },
        { path: defaultDir, mode: 'full' }
      ]
    })
    const refused = await runWrite('thread-free', 'f-project', join(projectDir, 'free.txt'), '越界')
    expect(refused.some((part) => part.type === 'tool-approval-request')).toBe(false)
    expect(toolError(refused)).toContain('不在任何授权工作区内')
    expect(existsSync(join(projectDir, 'free.txt'))).toBe(false)

    // 收尾：项目那条回到 ask（后面的用例按默认档跑）
    updateSettings(settingsPath(dir), {
      workspaces: [
        { path: projectDir, mode: 'ask' },
        { path: defaultDir, mode: 'full' }
      ]
    })
  })
})

describe('映射的持久化与清理（T18）', () => {
  it('⑤ 重启（换一个服务实例）后映射还在，会话根照样生效', async () => {
    await mapSession('thread-restart', PROJECT.id)
    await server.stop()

    server = await startAgentServer({ dataDir: dir, model: mockModel() })

    expect(await mappings()).toContainEqual({ threadId: 'thread-restart', projectId: PROJECT.id })
    // 生效判据：写默认工作区（full）仍然 fail closed（根是项目，不是默认工作区）
    const refused = await runWrite(
      'thread-restart',
      'r-out',
      join(defaultDir, 'restart.txt'),
      '越界'
    )
    expect(toolError(refused)).toContain('不在任何授权工作区内')
  }, 60_000)

  it('⑤b 删除会话：它的映射一起清掉', async () => {
    await mapSession('thread-doomed', PROJECT.id)
    // 让线程真的存在（删一个不存在的线程是幂等路径，不会触发清理）
    scripts.length = 0
    scripts.push(() => textScript('收到。'))
    await chat('thread-doomed', 'u-doomed')
    expect(readSettings(settingsPath(dir)).projects).toHaveLength(1)

    const response = await authorized(`/api/threads/${'thread-doomed'}`, { method: 'DELETE' })
    expect(response.status).toBe(200)

    await expect(mappings()).resolves.not.toContainEqual(
      expect.objectContaining({ threadId: 'thread-doomed' })
    )
  }, 60_000)

  it('删除项目的映射行不属于路由职责：摘映射走 PUT null（渲染端在删项目后做）', async () => {
    await mapSession('thread-x', PROJECT.id)
    await mapSession('thread-x', null)
    expect(await mappings()).not.toContainEqual(expect.objectContaining({ threadId: 'thread-x' }))
    expect(LOCAL_USER_RESOURCE_ID).toBe('local-user')
  })
})
