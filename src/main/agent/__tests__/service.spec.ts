// @vitest-environment node
/**
 * `startAgentServer` 的对外行为（T6 Review Focus #4 + T8 模型接入）：
 *   1. 默认（没配 provider）走内置 mock，把 chat 链路真跑起来；
 *   2. token 是唯一闸门：没带 / 带错 → 401，带对 → 200；
 *   3. 端口被占 → 自动换端口（≤ 上限次）；用尽 → 抛错而不是静默失败；
 *   4. stop() 会真的断开监听（端口可立即复用），且可重复调用；
 *   5. 模型**每轮重新解析**（配好 provider 不用重启）；配了 provider 却没密钥时对话报错，
 *      不回 mock 文案（T8 裁决：不得静默回落）。
 * 整个文件共用一个临时 dataDir（用例串行，各自起停自己的服务），收尾时统一清。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MOCK_REPLY_CHUNKS } from '../../../mastra/model'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { settingsPath, writeSettings } from '../../settings'
import {
  startAgentServer,
  teardownQuietly,
  type AgentServerHandle,
  type AgentServerOptions
} from '../service'

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
    expect(server.rules).toEqual({ processorRegistered: true })
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

  it('tasks 经过 Bearer 闸门；本机线程 GET/PUT 可用，外部资源与不存在线程拒绝', async () => {
    const server = await start()
    const threadId = 'service-tasks-owned'
    const url = `${server.baseUrl}/api/tasks/${threadId}`
    const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }
    const write = {
      action: 'replace',
      expectedRevision: 0,
      items: [{ title: '服务任务', status: 'pending' }]
    }
    expect((await fetch(url)).status).toBe(401)
    expect(
      (
        await fetch(url, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(write)
        })
      ).status
    ).toBe(401)
    expect((await fetch(url, { headers: { authorization: 'Bearer wrong-token' } })).status).toBe(
      401
    )
    expect((await fetch(url, { headers })).status).toBe(404)
    const created = await fetch(`${server.baseUrl}/api/threads`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ threadId })
    })
    expect(created.status).toBe(200)
    const initial = await fetch(url, { headers })
    expect(initial.status).toBe(200)
    expect(await initial.json()).toMatchObject({ revision: 0, items: [] })
    const saved = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(write) })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({
      revision: 1,
      items: [{ title: '服务任务', status: 'pending' }]
    })
    expect(await (await fetch(url, { headers })).json()).toMatchObject({ revision: 1 })

    const { LibSQLStore } = await import('@mastra/libsql')
    const storage = new LibSQLStore({
      id: 'tasks-ownership-probe',
      url: `file:${join(dir, 'kyclaw.db').replace(/\\/g, '/')}`
    })
    try {
      const memory = await storage.getStore('memory')
      if (memory === undefined) throw new Error('memory store unavailable')
      const now = new Date()
      await memory.saveThread({
        thread: {
          id: 'service-tasks-foreign',
          resourceId: 'other-user',
          title: '外部资源',
          createdAt: now,
          updatedAt: now
        }
      })
      for (const id of ['service-tasks-foreign', 'service-tasks-missing']) {
        expect((await fetch(`${server.baseUrl}/api/tasks/${id}`, { headers })).status).toBe(404)
        expect(
          (
            await fetch(`${server.baseUrl}/api/tasks/${id}`, {
              method: 'PUT',
              headers,
              body: JSON.stringify(write)
            })
          ).status
        ).toBe(404)
      }
    } finally {
      await storage.close()
    }
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

  it('stop() 不被挂着的流式连接拖住：先 closeAllConnections，再关监听（T6 随修）', async () => {
    const { MockLanguageModelV4 } = await import('ai/test')
    // 永不推数据、也不结束的流：等价于 T7 里"用户正看着的 SSE 长连接"（mock 模型本身瞬间结束，测不出来）
    const stalling = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start() {
            /* 挂着不动 */
          }
        })
      })
    })
    const server = await start({ model: stalling as never })

    const streaming = chat(server.baseUrl, {
      headers: { authorization: `Bearer ${server.token}` }
    })
    // 响应头已回 = 请求真的挂在服务端的流上
    const response = await streaming

    const outcome = await Promise.race([
      server.stop().then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 3000))
    ])
    expect(outcome).toBe('stopped')

    // 连接被强制收掉：客户端读响应体拿到终止错误，而不是一直挂着
    await expect(response.text()).rejects.toThrow()
  }, 60_000)

  it('teardownQuietly：Mastra shutdown 抛错时也要关掉 storage（try/finally），且不往外抛', async () => {
    const calls: string[] = []
    const mastra = {
      shutdown: async (): Promise<void> => {
        calls.push('shutdown')
        throw new Error('shutdown 炸了')
      }
    }
    const storage = {
      close: async (): Promise<void> => {
        calls.push('close')
      }
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(teardownQuietly(mastra as never, storage as never)).resolves.toBeUndefined()

    expect(calls).toEqual(['shutdown', 'close'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  }, 60_000)

  it('模型每轮重新解析：resolveModel 换一条，下一轮回复就跟着换（配好 provider 不用重启，T8）', async () => {
    const { MockLanguageModelV4, simulateReadableStream } = await import('ai/test')

    /** 一段就吐完的 mock：文本带轮次标记，用来分辨"这轮用的是哪条配置" */
    function mockSaying(text: string): InstanceType<typeof MockLanguageModelV4> {
      return new MockLanguageModelV4({
        provider: 'kyclaw-test-mock',
        modelId: 'kyclaw-test-mock',
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: text },
              { type: 'text-end', id: 't1' },
              {
                type: 'finish',
                finishReason: { unified: 'stop' as const, raw: 'stop' },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 }
                }
              }
            ],
            initialDelayInMs: 0,
            chunkDelayInMs: 0
          })
        })
      })
    }

    let current = mockSaying('第一轮：mock 配置')
    const server = await start({ resolveModel: async () => current as never })

    const first = await chat(server.baseUrl, {
      headers: { authorization: `Bearer ${server.token}` }
    })
    const firstBody = await first.text()

    current = mockSaying('第二轮：真 provider 生效')
    const second = await chat(server.baseUrl, {
      headers: { authorization: `Bearer ${server.token}` }
    })
    const secondBody = await second.text()

    expect(firstBody).toContain('第一轮：mock 配置')
    expect(secondBody).toContain('第二轮：真 provider 生效')
    expect(secondBody).not.toContain('第一轮')
  }, 60_000)

  it('配了必须密钥的渠道（anthropic）却读不到密钥 → 对话报错（400 + 中文人话），不回 mock 文案与假成功（T8 裁决 + C-1）', async () => {
    // 缺省 resolver 没有密钥来源：anthropic 必须密钥 → settings 里配了它必然"配置不完整"
    const withProvider = mkdtempSync(join(tmpdir(), 'kyclaw-agent-configured-'))
    writeSettings(settingsPath(withProvider), {
      ...DEFAULT_SETTINGS,
      providers: [
        {
          id: 'anthropic',
          type: 'anthropic',
          model: 'claude-sonnet-4-5',
          isDefault: true
        }
      ]
    })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const server = await start({ dataDir: withProvider })

      const response = await chat(server.baseUrl, {
        headers: { authorization: `Bearer ${server.token}` }
      })
      const body = await response.text()

      expect(response.status).toBe(400)
      // C-1：错误卡原样渲染响应体（ai@7 把 body 设为 error.message），所以响应必须是人话——
      // 缺什么、去哪里补都写在响应里；后端原文/JSON blob 不许上卡（设计雷点 2.2）
      expect(body).toContain('配置不完整')
      expect(body).toContain('缺 API 密钥')
      expect(body).toContain('设置')
      expect(body).not.toContain('Internal Server Error')
      expect(body).not.toContain('{')
      expect(body).not.toContain(MOCK_REPLY_CHUNKS[0])
      // 真实错误仍留在主进程日志（提供自定义 onError 后库不再自己记，验证没被吞）
      expect(errorLog.mock.calls.some((call) => JSON.stringify(call).includes('配置不完整'))).toBe(
        true
      )
    } finally {
      errorLog.mockRestore()
      try {
        rmSync(withProvider, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）')
      }
    }
  }, 60_000)

  it('打包态实报：无密钥的本机端点也能**真对话**（openai 兼容自定义渠道，真 HTTP/SSE，且不发 Authorization 头）', async () => {
    // 真起一个 OpenAI 兼容的假端点（只回 SSE 正文），并记下每一条请求的 Authorization 头
    const seen: Array<string | undefined> = []
    const provider = createServer((request, response) => {
      seen.push(request.headers.authorization)
      request.on('data', () => {})
      request.on('end', () => {
        const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
          `data: ${JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'local-model',
            choices: [{ index: 0, delta, finish_reason: finish }]
          })}\n\n`
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(
          [
            chunk({ role: 'assistant' }),
            chunk({ content: '本机端点回复：你好' }),
            chunk({}, 'stop'),
            'data: [DONE]\n\n'
          ].join('')
        )
      })
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
    const port = (provider.address() as AddressInfo).port

    const dataDir = mkdtempSync(join(tmpdir(), 'kyclaw-agent-keyless-'))
    writeSettings(settingsPath(dataDir), {
      ...DEFAULT_SETTINGS,
      providers: [
        {
          id: 'custom-1',
          type: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: 'local-model',
          isDefault: true
        }
      ]
    })

    try {
      // 默认 resolver 没有密钥来源 = 这条 provider 一个密钥都没有（正是 LM Studio 那类本机服务）
      const server = await start({ dataDir })

      const response = await chat(server.baseUrl, {
        headers: { authorization: `Bearer ${server.token}` }
      })
      const body = await response.text()

      expect(response.status).toBe(200)
      // 真的走通了对话（不是 mock 文案、也不是 400 的假成功）
      expect(body).toContain('本机端点回复：你好')
      expect(body).not.toContain(MOCK_REPLY_CHUNKS[0])
      // 关键证据：整轮对话一个 Authorization 头都没发出去（空密钥 → SDK 不发头，而不是空的 Bearer）
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((value) => value === undefined)).toBe(true)
    } finally {
      await closeServer(provider)
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] 临时目录未能立刻删除（libsql 句柄延迟释放，交给系统清理）')
      }
    }
  }, 60_000)

  it('未知错误 → 仍 500，但响应体也是中文通用文案（不是原文/JSON blob）；真实错误进日志（C-1）', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const server = await start({
        resolveModel: async () => {
          throw new Error('boom: internal detail')
        }
      })

      const response = await chat(server.baseUrl, {
        headers: { authorization: `Bearer ${server.token}` }
      })
      const body = await response.text()

      expect(response.status).toBe(500)
      expect(body).not.toContain('boom')
      expect(body).not.toContain('Internal Server Error')
      expect(body).not.toContain('{')
      expect(body).toMatch(/[\u4e00-\u9fff]/)
      expect(errorLog.mock.calls.some((call) => JSON.stringify(call).includes('boom'))).toBe(true)
    } finally {
      errorLog.mockRestore()
    }
  }, 60_000)
})
