// @vitest-environment node
/**
 * round 73 补线：fetch 的**本机/内网白名单**走设置页那条路（settings.json → agent 装配 → 出站边界）。
 *
 * 为什么单开一份、而且要走真服务：上一轮把出站边界的判定做好了（拒环回/私网/链路本地、逐跳校验、
 * 解析 fail closed），白名单却只落在 `network.allowLocalHosts`（schema）与环境变量上 ——
 * **主进程那条路没接线**：设置里填了白名单，fetch 照样拦。这正是"单测全绿、功能不可用"的层间缝：
 * 工具层的 `tools/__tests__/_r73-fetch-egress.spec.ts` 注入的是 `egress.allowHosts`，
 * 证明不了 `settings.json → startAgentServer（缺省口径）→ createKyclawMastra → createKyclawAgent → fetch`
 * 这条链真的通。所以本 spec **一个选项都不注入**：白名单从头到尾只从 dataDir/settings.json 来，
 * 服务只起一次，中途只改那个文件（就是设置页 settings:update 落的那份）。
 *
 * 判据（真服务 + 真 HTTP，只用自己起的 127.0.0.1 桩，不碰任何真实站点）：
 *   A) 设置里空表 → 本机地址被拦，**本机服务一个字节都没收到**（拦在执行之前）；
 *   B) 白名单写进 settings.json → **同一个服务、不重启**，下一轮 fetch 就放行（读到本机服务的内容）；
 *   C) 撤销白名单 → 下一轮又拦下来（不是"放行一次就永久放行"）；
 *   D) 旧落盘文件（没有 `network` 这个键）按空表读 → 一样拦（fail closed）。
 *
 * 模型是本地假端点（第一轮回 `fetch` 的 tool_call，带工具结果的那一轮回正文收尾）：
 * 只借它把 fetch 真的跑起来，不碰任何真实 provider。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { startAgentServer, type AgentServerHandle } from '../service'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'
import { settingsPath, readSettings, updateSettings, writeSettings } from '../../settings'
import { defaultSettings } from '../../../shared/settings'
import { threadMemoryBody } from '../../../shared/threads'

/** 本机上的"秘密服务"（用户自己机器 / 内网里的服务）：只该在白名单放行时才被读到 */
let secretServer: Server
let secretPort = 0
let secretHits = 0

/** 假 provider：第一轮让模型去调 fetch，带工具结果的那一轮收尾 */
let stub: Server
/** 假 provider 收到的请求体（按顺序） */
const requests: Array<Record<string, unknown>> = []

let dir: string
let server: AgentServerHandle

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 这一轮的请求里已经有工具结果了吗（有 = 该收尾了） */
function hasToolResult(body: Record<string, unknown>): boolean {
  const messages = (body.messages ?? []) as Array<Record<string, unknown>>
  return messages.some((message) => message.role === 'tool')
}

function sseBody(body: Record<string, unknown>): string {
  if (!hasToolResult(body)) {
    return (
      sseChunk({
        id: 'chatcmpl-stub',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'stub-model',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call-fetch',
                  type: 'function',
                  function: {
                    name: 'fetch',
                    arguments: JSON.stringify({ url: `http://127.0.0.1:${secretPort}/secret` })
                  }
                }
              ]
            },
            finish_reason: null
          }
        ]
      }) +
      sseChunk({
        id: 'chatcmpl-stub',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'stub-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }) +
      'data: [DONE]\n\n'
    )
  }
  return (
    sseChunk({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'stub-model',
      choices: [
        { index: 0, delta: { role: 'assistant', content: '取完了。' }, finish_reason: null }
      ]
    }) +
    sseChunk({
      id: 'chatcmpl-stub',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'stub-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }) +
    'data: [DONE]\n\n'
  )
}

beforeAll(async () => {
  secretServer = createServer((_request, response) => {
    secretHits += 1
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('内网秘密')
  })
  await new Promise<void>((resolve) => secretServer.listen(0, '127.0.0.1', resolve))
  const secretAddress = secretServer.address()
  if (secretAddress === null || typeof secretAddress === 'string') {
    throw new Error('秘密服务监听失败')
  }
  secretPort = secretAddress.port

  stub = createServer((request, response) => {
    if (request.method !== 'POST' || !(request.url ?? '').endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":{"message":"not found"}}')
      return
    }
    let body = ''
    request.on('data', (chunk) => {
      body += String(chunk)
    })
    request.on('end', () => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(body) as Record<string, unknown>
      } catch {
        parsed = { raw: body }
      }
      requests.push(parsed)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(sseBody(parsed))
    })
  })
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
  const stubAddress = stub.address()
  if (stubAddress === null || typeof stubAddress === 'string') throw new Error('假端点监听失败')

  dir = mkdtempSync(join(tmpdir(), 'kyclaw-r73-fetch-allow-'))
  const ws = join(dir, 'ws')
  mkdirSync(ws, { recursive: true })
  // 生产那份设置：工作区给「完全访问」（fetch 这类能力工具在 full 工作区里不弹审批卡，
  // 免审与否不是本 spec 要证的事），**network 不写**（缺省口径 = 旧落盘文件那种形状）
  writeSettings(settingsPath(dir), {
    ...defaultSettings(),
    workspaces: [{ path: ws, mode: 'full' }],
    defaultWorkspace: ws
  })

  const model = createDeepSeek({
    apiKey: 'stub-key',
    baseURL: `http://127.0.0.1:${stubAddress.port}/v1`
  }).chat('stub-model')

  // **只给 model**：其余（工作区 / 网络白名单 / 权限）全走 settings.json 的缺省口径
  server = await startAgentServer({ dataDir: dir, model })
}, 180_000)

afterAll(async () => {
  await server?.stop()
  secretServer?.closeAllConnections()
  stub?.closeAllConnections()
  await new Promise<void>((resolve) => secretServer?.close(() => resolve()))
  await new Promise<void>((resolve) => stub?.close(() => resolve()))
  if (dir !== undefined) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch {
      console.warn('[kyclaw] r73 临时目录未能立刻删除（libsql 句柄延迟释放）', dir)
    }
  }
})

/** 走真 chat 路由跑一轮（模型由假端点拿定主意：调 fetch → 收尾） */
async function ask(threadId: string): Promise<void> {
  const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${server.token}`
    },
    body: JSON.stringify({
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: '把这个地址的内容取一下。' }] }
      ],
      ...threadMemoryBody(threadId)
    })
  })
  const stream = await response.text()
  process.stdout.write(
    `[r73-allow] ${threadId} → HTTP ${response.status}，流 ${stream.length} 字节\n`
  )
  expect(response.status).toBe(200)
}

/** 这一轮之后假端点收到的请求体（整段序列化：工具结果就在里面） */
function transcriptFrom(mark: number): string {
  return JSON.stringify(requests.slice(mark))
}

/** 这一轮假端点收到的**工具结果**正文（tool 角色的消息）——模型看到的就是它 */
function toolResultsFrom(mark: number): string {
  return requests
    .slice(mark)
    .flatMap((request) => (request.messages ?? []) as Array<Record<string, unknown>>)
    .filter((message) => message.role === 'tool')
    .map((message) => JSON.stringify(message.content))
    .join('\n')
}

/** 设置里当前的白名单（从**设置文件**读，不是从某个注入的闭包） */
function allowList(): readonly string[] {
  return readSettings(settingsPath(dir)).network?.allowLocalHosts ?? []
}

describe('fetch 本机/内网白名单：设置页那条路（真服务，不重启）', () => {
  it('A) 设置里空表 → 本机地址被拦，本机服务一个字节都没收到', async () => {
    expect(allowList()).toEqual([])
    const hitsBefore = secretHits
    const mark = requests.length
    await ask('r73-allow-a')

    const results = toolResultsFrom(mark)
    process.stdout.write(`[r73-allow:A] 工具结果 ${results.slice(0, 260)}\n`)
    expect(results).toContain('已阻断')
    expect(results).not.toContain('内网秘密')
    expect(secretHits).toBe(hitsBefore)
  }, 120_000)

  it('B) 白名单写进 settings.json → 同一个服务、不重启，下一轮就放行', async () => {
    // 就是设置页 settings:update 落的那份文件（渲染端 → IPC → updateSettings）
    updateSettings(settingsPath(dir), { network: { allowLocalHosts: [`127.0.0.1:${secretPort}`] } })
    expect(allowList()).toEqual([`127.0.0.1:${secretPort}`])

    const hitsBefore = secretHits
    const mark = requests.length
    await ask('r73-allow-b')

    const results = toolResultsFrom(mark)
    process.stdout.write(`[r73-allow:B] 工具结果 ${results.slice(0, 260)}\n`)
    expect(results).toContain('内网秘密')
    expect(results).not.toContain('已阻断')
    // 整轮请求里也不该再出现拦截说明（工具定义与系统提示里都没有这句话）
    expect(transcriptFrom(mark)).not.toContain('已阻断')
    expect(secretHits).toBe(hitsBefore + 1)
  }, 120_000)

  it('C) 撤销白名单 → 下一轮又拦下来（放行不是一劳永逸）', async () => {
    updateSettings(settingsPath(dir), { network: { allowLocalHosts: [] } })
    expect(allowList()).toEqual([])

    const hitsBefore = secretHits
    const mark = requests.length
    await ask('r73-allow-c')

    const results = toolResultsFrom(mark)
    process.stdout.write(`[r73-allow:C] 工具结果 ${results.slice(0, 260)}\n`)
    expect(results).toContain('已阻断')
    expect(secretHits).toBe(hitsBefore)
  }, 120_000)

  it('D) 旧落盘文件（没有 network 这个键）按空表读 → 一样拦（fail closed）', async () => {
    // 把 network 键整个删掉：模拟 round 73 之前落的那份 settings.json
    const raw = JSON.parse(readFileSync(settingsPath(dir), 'utf8')) as Record<string, unknown>
    delete raw.network
    writeFileSync(settingsPath(dir), `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    expect(readSettings(settingsPath(dir)).network).toBeUndefined()

    const hitsBefore = secretHits
    const mark = requests.length
    await ask('r73-allow-d')

    const results = toolResultsFrom(mark)
    process.stdout.write(`[r73-allow:D] 工具结果 ${results.slice(0, 260)}\n`)
    expect(results).toContain('已阻断')
    expect(secretHits).toBe(hitsBefore)
  }, 120_000)
})
