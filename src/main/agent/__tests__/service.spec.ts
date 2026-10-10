// @vitest-environment node
/**
 * `startAgentServer` 的对外行为（T6 Review Focus #4）：
 *   1. 默认（没配 provider）走内置 mock，把 chat 链路真跑起来；
 *   2. token 是唯一闸门：没带 / 带错 → 401，带对 → 200；
 *   3. 端口被占 → 自动换端口（≤ 上限次）；用尽 → 抛错而不是静默失败；
 *   4. stop() 会真的断开监听（端口可立即复用），且可重复调用。
 * 整个文件共用一个临时 dataDir（用例串行，各自起停自己的服务），收尾时统一清。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MOCK_REPLY_CHUNKS } from '../../../mastra/model'
import { startAgentServer, type AgentServerHandle, type AgentServerOptions } from '../service'

const AGENT_ID = 'kyclaw-agent'
const CHAT_BODY = JSON.stringify({
  messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: '在吗？' }] }]
})

let dir: string
const started: AgentServerHandle[] = []

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kyclaw-agent-'))
})

afterEach(async () => {
  for (const handle of started.splice(0)) await handle.stop()
})

afterAll(() => {
  // libsql（native）在 Windows 上要过几秒才真正放掉库文件句柄；删临时目录不是这些用例
  // 要验证的行为，删不掉就留个话（%TEMP% 里的一份一次性目录），不把用例判失败。
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch {
    console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）：', dir)
  }
})

/** 起一个服务并登记，用例结束时统一 stop */
async function start(overrides: Partial<AgentServerOptions> = {}): Promise<AgentServerHandle> {
  const handle = await startAgentServer({ dataDir: dir, ...overrides })
  started.push(handle)
  return handle
}

/** 占住一个端口（模拟"端口被别的程序/上一个实例占用"） */
async function occupyPort(): Promise<{ server: Server; port: number }> {
  const server = createServer((_req, res) => res.end('occupied'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

function chat(baseUrl: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}/chat/${AGENT_ID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...init.headers },
    body: CHAT_BODY,
    ...init
  })
}

describe('startAgentServer', () => {
  it('跑在 node 环境（文件头的 @vitest-environment node 不能摘：这里要真起 http 服务）', () => {
    expect(typeof window).toBe('undefined')
  })

  it('监听 127.0.0.1 随机端口；token 不对一律 401，带对才回 SSE', async () => {
    const server = await start()

    expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}`)
    expect(server.port).toBeGreaterThan(0)
    expect(server.token.length).toBeGreaterThanOrEqual(32)

    const anonymous = await chat(server.baseUrl)
    expect(anonymous.status).toBe(401)

    const wrongToken = await chat(server.baseUrl, {
      headers: { authorization: 'Bearer wrong-token' }
    })
    expect(wrongToken.status).toBe(401)

    const authorized = await chat(server.baseUrl, {
      headers: { authorization: `Bearer ${server.token}` }
    })
    expect(authorized.status).toBe(200)
    expect(authorized.headers.get('content-type')).toContain('text/event-stream')

    // 没配 provider → 内置 mock 的确定性文本（离线链路真的通）
    const body = await authorized.text()
    const deltas = body
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .filter((data) => data !== '[DONE]')
      .map((data) => JSON.parse(data) as { type: string; delta?: string })
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.delta)
      .join('')
    expect(deltas).toBe(MOCK_REPLY_CHUNKS.join(''))
    expect(body).toContain('data: [DONE]')
  }, 60_000)

  it('端口被占用 → 自动换端口（≤5 次尝试），占用者不受影响', async () => {
    const { server: blocker, port: occupied } = await occupyPort()

    const server = await start({ port: occupied })

    expect(server.port).not.toBe(occupied)
    expect(
      (await chat(server.baseUrl, { headers: { authorization: `Bearer ${server.token}` } })).status
    ).toBe(200)
    expect(blocker.listening).toBe(true)
    expect((blocker.address() as AddressInfo).port).toBe(occupied)

    await closeServer(blocker)
  }, 60_000)

  it('尝试次数用尽（attempts=1 且端口被占）→ 抛错，不静默换到更远的地方', async () => {
    const { server: blocker, port: occupied } = await occupyPort()

    await expect(startAgentServer({ dataDir: dir, port: occupied, attempts: 1 })).rejects.toThrow(
      /1 次都没能监听/
    )

    await closeServer(blocker)
  }, 60_000)

  it('stop() 断开监听（端口可立即复用），且可重复调用', async () => {
    const first = await start()
    const port = first.port

    await first.stop()
    await expect(chat(first.baseUrl)).rejects.toThrow()
    await expect(first.stop()).resolves.toBeUndefined()

    const second = await start({ port })
    expect(second.port).toBe(port)
    expect(second.token).not.toBe(first.token)
  }, 60_000)
})
