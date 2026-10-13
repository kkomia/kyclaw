// @vitest-environment node
/**
 * round 66：**PPT 模板选择是会话级的**（用户实报的"新会话还预选着上一次挑的模板"）。
 *
 * 两半：
 *   ① **实证：instructions 回调拿不到会话 id**。真跑一轮（真 mastra agent + 真 chatRoute + stub 模型），
 *      把 instructions 回调收到的 requestContext 原样看一遍 —— 键是空的（`MastraMemory` /
 *      `mastra__threadId` 都没有）。所以"用户固定了模板 X"那一行**不可能**写成现算的指令，
 *      缺省模板的解析只能放进 create_ppt 的**工具执行**里（那时 `sessionKey(context)` 给得出 threadId）。
 *      这条钉住的是"为什么不在指令层做"，换 core 版本后若它有了键，这条会红 —— 那时再回来评估。
 *   ② **行为：两条会话各用自己那套**。走全链（真 agent 服务 + 真 HTTP 路由写映射 + 真 pptx 渲染）：
 *      给 thread-a 记一套模板 → 它这轮 create_ppt 不指定 theme 就用它；thread-b 没记 → 照旧自动挑
 *      （自动池只有六套基础主题，所以"没泄漏"在文件里也看得见）。
 *
 * 3 条取值优先级（显式 theme > 会话选择 > 自动）在这里也过一遍：显式 theme 那一轮压过会话选择。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import { startAgentServer, type AgentServerHandle } from '../../main/agent/service'
import { readSettings, settingsPath, updateSettings } from '../../main/settings'
import { KYCLAW_AGENT_ID } from '../agents/kyclaw'
import { readZipEntries } from '../tools/artifact-check'
import { zipText } from '../tools/__tests__/zip'
import { lookupTheme, PPT_THEMES, PPT_THEME_NAMES } from '../tools/ppt-themes'
import { threadMemoryBody } from '../../shared/threads'

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

function toolCallScript(id: string, name: string, input: unknown): StreamPart[] {
  const json = JSON.stringify(input)
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'tool-input-start', id, toolName: name },
    { type: 'tool-input-delta', id, delta: json },
    { type: 'tool-input-end', id },
    { type: 'tool-call', toolCallId: id, toolName: name, input: json },
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

/** 工具回执文本（输出被包成 part.output；拿不到就原样 JSON） */
function toolOutputText(parts: Array<Record<string, unknown>>): string {
  return parts
    .filter((part) => part.type === 'tool-output-available')
    .map((part) => (typeof part.output === 'string' ? part.output : JSON.stringify(part.output)))
    .join('\n')
}

function mockModel(scripts: Array<() => StreamPart[]>, id: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: id,
    modelId: id,
    doStream: async () => {
      const script = scripts.shift()
      if (script === undefined) throw new Error('mock 脚本用完了：用例没给够回放')
      return {
        stream: simulateReadableStream({ chunks: script(), initialDelayInMs: 0, chunkDelayInMs: 0 })
      }
    }
  })
}

describe('① 实证：instructions 回调里没有会话 id', () => {
  it('真跑一轮：requestContext 的键是空的（模板名进不了指令，只能在工具执行里解析）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kyclaw-ppt-instructions-'))
    const [
      { Hono },
      { serve },
      { MastraServer },
      { Mastra },
      { LibSQLStore },
      { Memory },
      { chatRoute },
      { Agent }
    ] = await Promise.all([
      import('hono'),
      import('@hono/node-server'),
      import('@mastra/hono'),
      import('@mastra/core/mastra'),
      import('@mastra/libsql'),
      import('@mastra/memory'),
      import('@mastra/ai-sdk'),
      import('@mastra/core/agent')
    ])

    const captured: Array<Record<string, unknown>> = []
    const storage = new LibSQLStore({
      id: 'kyclaw-ppt-instructions-storage',
      url: `file:${join(dir, 'probe.db').replace(/\\/g, '/')}`
    })
    const memory = new Memory({ storage, options: { lastMessages: 10 } })
    const model = mockModel([() => textScript('好的。')], 'kyclaw-ppt-instructions-mock')
    const agent = new Agent({
      id: 'ppt-instructions-probe',
      name: 'ppt-instructions-probe',
      instructions: ({ requestContext }) => {
        captured.push(Object.fromEntries(requestContext.entries()))
        return '只回一句话。'
      },
      model,
      memory
    })
    const mastra = new Mastra({
      agents: { 'ppt-instructions-probe': agent },
      storage,
      server: {
        apiRoutes: [
          chatRoute({
            path: '/chat/:agentId',
            version: 'v7',
            defaultOptions: { maxSteps: 5 }
          })
        ]
      }
    })
    const app = new Hono()
    const mastraServer = new MastraServer({ app, mastra })
    await mastraServer.init()
    const httpServer = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', () => resolve())
      httpServer.once('error', reject)
    })
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error('拿不到探针端口')

    const threadId = 'thread-ppt-instructions'
    const response = await fetch(`http://127.0.0.1:${address.port}/chat/ppt-instructions-probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: '在吗' }] }],
        ...threadMemoryBody(threadId)
      })
    })
    expect(response.status).toBe(200)
    await response.text()

    try {
      expect(captured.length).toBeGreaterThan(0)
      const keys = Object.keys(captured[0] ?? {})
      // 诊断（换 core 版本后这条失败就把实际情况抄回 kyclaw.ts 的头注）
      console.log('[kyclaw] instructions 回调的 requestContext 键：', JSON.stringify(keys))
      // 会话 id 的两个可能落点都没有：MastraMemory（memory 装配的那份）与 core 的单键
      expect(keys).not.toContain('MastraMemory')
      expect(keys).not.toContain('mastra__threadId')
    } finally {
      await mastra.shutdown().catch(() => {})
      await storage.close().catch(() => {})
      if ('closeAllConnections' in httpServer) httpServer.closeAllConnections()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放）：', dir)
      }
    }
  }, 60_000)
})

let dir: string
let workspace: string
let server: AgentServerHandle
const scripts: Array<() => StreamPart[]> = []

function user(id: string, text: string): Record<string, unknown> {
  return { id, role: 'user', parts: [{ type: 'text', text }] }
}

/** 一轮对话：先给工具脚本，再给收尾文本 */
async function runTurn(
  threadId: string,
  call: { id: string; name: string; input: unknown }
): Promise<Array<Record<string, unknown>>> {
  scripts.push(() => toolCallScript(call.id, call.name, call.input))
  scripts.push(() => textScript('好，处理完了。'))
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({
      messages: [user(`u-${threadId}`, '做一份 PPT')],
      ...threadMemoryBody(threadId)
    })
  })
  expect(response.status).toBe(200)
  return sseParts(await response.text())
}

/** 经真 HTTP 路由记一条会话级模板（渲染端胶囊走的就是这条路） */
async function putTemplate(threadId: string, template: string): Promise<void> {
  const response = await fetch(`${server.baseUrl}/api/ppt/templates`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ threadId, template })
  })
  expect(response.status).toBe(200)
}

/** 落盘回执里"最终用的模板名"（用户与测试靠它确认选的模板真用上了） */
function themeOf(parts: Array<Record<string, unknown>>): string {
  return /模板「(.+?)」/.exec(toolOutputText(parts))?.[1] ?? ''
}

/** 封面 XML（第 1 页）——"这套配色真进了文件"的硬证据 */
function coverXml(file: string): string {
  return zipText(readZipEntries(readFileSync(file)), 'ppt/slides/slide1.xml')
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-ppt-session-'))
  mkdirSync(join(dir, 'ws'), { recursive: true })
  workspace = realpathSync.native(join(dir, 'ws'))
  // full 档：产出物免审，一轮就能跑到落盘（本 spec 不看审批，只钉模板）
  updateSettings(settingsPath(dir), { workspaces: [{ path: workspace, mode: 'full' }] })
  expect(readSettings(settingsPath(dir)).workspaces[0]?.mode).toBe('full')

  server = await startAgentServer({
    dataDir: dir,
    model: mockModel(scripts, 'kyclaw-ppt-session-mock')
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

describe('② 行为：create_ppt 的缺省模板按会话取', () => {
  it('这个会话记了模板：不指定 theme 就用它（配色真落进文件）', async () => {
    scripts.length = 0
    await putTemplate('thread-a', '酒红')

    const parts = await runTurn('thread-a', {
      id: 'c-a',
      name: 'create_ppt',
      input: { title: '会话甲', slides: [{ title: '结论' }] }
    })

    expect(themeOf(parts)).toBe('酒红')
    expect(coverXml(join(workspace, '会话甲.pptx'))).toContain(`val="${PPT_THEMES['酒红'].accent}"`)
  }, 60_000)

  it('另一条会话没记模板：照旧自动挑（别人的选择一点都没漏过来）', async () => {
    scripts.length = 0
    // thread-a 在上一条用例里记过 酒红 —— 这一轮换一条会话，同一份内容
    const parts = await runTurn('thread-b', {
      id: 'c-b',
      name: 'create_ppt',
      input: { title: '会话乙', slides: [{ title: '结论' }] }
    })

    const theme = themeOf(parts)
    // 自动挑只在六套基础主题里挑（酒红 / 奶油 这类"要显式选"的模板不会自己冒出来）
    expect([...PPT_THEME_NAMES]).toContain(theme)
    const chosen = lookupTheme(theme)
    expect(chosen).toBeDefined()
    expect(coverXml(join(workspace, '会话乙.pptx'))).toContain(`val="${chosen?.accent}"`)
  }, 60_000)

  it('两条会话各是各的：thread-a 那一笔还在（thread-b 没把它顶掉）', async () => {
    const response = await fetch(`${server.baseUrl}/api/ppt/templates`, {
      headers: { authorization: `Bearer ${server.token}` }
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      sessions: Array<{ threadId: string; template: string }>
    }
    expect(body.sessions).toContainEqual({ threadId: 'thread-a', template: '酒红' })
    expect(body.sessions.some((entry) => entry.threadId === 'thread-b')).toBe(false)
  })

  it('清回自动：同一会话清掉之后，create_ppt 又回到自动挑', async () => {
    scripts.length = 0
    await putTemplate('thread-a', '')

    const parts = await runTurn('thread-a', {
      id: 'c-c',
      name: 'create_ppt',
      input: { title: '会话甲二次', slides: [{ title: '结论' }] }
    })

    expect([...PPT_THEME_NAMES]).toContain(themeOf(parts))
  }, 60_000)

  it('显式 theme 仍然压过会话选择（优先级不变）', async () => {
    scripts.length = 0
    await putTemplate('thread-a', '学术紫')

    const parts = await runTurn('thread-a', {
      id: 'c-d',
      name: 'create_ppt',
      input: { title: '会话甲三次', theme: '暖橙', slides: [{ title: '结论' }] }
    })

    expect(themeOf(parts)).toBe('暖橙')
    expect(coverXml(join(workspace, '会话甲三次.pptx'))).toContain(
      `val="${PPT_THEMES['暖橙'].accent}"`
    )
    expect(existsSync(join(workspace, '会话甲三次.pptx'))).toBe(true)
  }, 60_000)
})
