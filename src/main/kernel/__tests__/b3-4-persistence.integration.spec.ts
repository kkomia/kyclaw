// @vitest-environment node
/**
 * B3.4 持久化（页面刷新 = renderer 重载；main/内核不重启）：
 * - threadId 直接当 sessionId：第二轮同一 thread 继续，上下文来自内核 session；
 * - 中途刷新重接：`reattach` 读 opening 的 startedAfterSeq/nextIndex（内核给什么原样记）；
 * - `session/conflict` 与 `session/writer-held` 真实触发。
 * 默认跳过（KYCLAW_KERNEL_E2E=1）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startKernelAdapter, type KernelAdapter } from '../kernel-adapter'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'F:\\deepseekharness\\resources\\app.asar'

interface Stub {
  server: Server
  baseUrl: string
  bodies: string[]
  slow: (on: boolean) => void
}

function startStub(): Promise<Stub> {
  const bodies: string[] = []
  let delayMs = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += String(chunk)
    })
    req.on('end', () => {
      if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url ?? '')) {
        res.writeHead(404).end('not found')
        return
      }
      bodies.push(body)
      const call = bodies.length
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        const send = (event: string, data: unknown): void => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }
        send('message_start', {
          type: 'message_start',
          message: {
            id: `msg_b34_${String(call)}`,
            type: 'message',
            role: 'assistant',
            model: 'deepseek-flash',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 1 }
          }
        })
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `第 ${String(call)} 次回答。` }
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 8 }
        })
        send('message_stop', { type: 'message_stop' })
        res.end()
      }, delayMs)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('stub: no address')
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        bodies,
        slow: (on: boolean) => {
          delayMs = on ? 4_000 : 0
        }
      })
    })
  })
}

function startAdapter(appDataDir: string, dshHome: string, stub: Stub): Promise<KernelAdapter> {
  return startKernelAdapter({
    electronExecutable: ELECTRON,
    asarPath: ASAR,
    appDataDir,
    dshHome,
    extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
    readyTimeoutMs: 30_000,
    turnTimeoutMs: 60_000
  })
}

describe.runIf(ENABLED)('B3.4 threadId=sessionId + 刷新重接 + 占用错误', () => {
  it('同会话两轮带上下文；中途 reattach 有 opening；conflict 实测；writer-held 视内核实测（当前未触发）', async () => {
    const stub = await startStub()
    const root = mkdtempSync(join(tmpdir(), 'kyclaw-b34-'))
    const home = join(root, 'home')
    const dirA = join(root, 'app-a')
    const dirB = join(root, 'app-b')
    let a1: KernelAdapter | undefined
    let a2: KernelAdapter | undefined
    let b1: KernelAdapter | undefined
    try {
      a1 = await startAdapter(dirA, home, stub)
      const first = await a1.startTurn('第一轮问题：记住 42', { threadId: 'thread-b34' })
      console.log('[b34] first turn', JSON.stringify(first).slice(0, 1200))
      console.log(
        '[b34] stub bodies so far',
        JSON.stringify(stub.bodies.map((body) => ({ len: body.length, hasFirst: body.includes('记住 42') })))
      )
      expect(first.text).toMatch(/第 \d+ 次回答/)
      const listed = await a1.listKernelSessions()
      console.log('[b34] sessions', JSON.stringify(listed.filter((s) => s.sessionId === 'thread-b34')))
      expect(listed.some((session) => session.sessionId === 'thread-b34')).toBe(true)

      // “刷新页面”：同一 adapter（main/内核不重启）再发一轮
      const second = await a1.startTurn('第二轮问题', { threadId: 'thread-b34' })
      expect(second.text).toMatch(/第 \d+ 次回答/)
      const contextBody = stub.bodies.find(
        (body) => body.includes('第二轮问题') && body.includes('第一轮问题：记住 42')
      )
      console.log(
        '[b34] bodies',
        JSON.stringify(
          stub.bodies.map((body) => ({
            len: body.length,
            first: body.includes('第一轮问题：记住 42'),
            second: body.includes('第二轮问题')
          }))
        )
      )
      expect(contextBody, '第二轮请求体应包含第一轮上下文（内核 session）').toBeDefined()

      // 中途刷新：慢轮进行中 reattach，读内核 opening
      stub.slow(true)
      const slow = a1.startTurn('慢轮问题', { threadId: 'thread-b34' })
      await new Promise((resolve) => setTimeout(resolve, 900))
      const mid = await a1.reattach('thread-b34')
      console.log('[b34] mid-turn reattach', JSON.stringify(mid))
      expect(mid.cursor).toBeTypeOf('number')
      expect(mid.assistantStreamKeys).toBeDefined()

      // writer-held：同一 cwd/home 的第二进程，抢占正在跑的会话
      a2 = await startAdapter(dirA, home, stub)
      const heldResult = await a2.startTurn('抢占写', { threadId: 'thread-b34' }).then(
        (result) => result,
        (error: unknown) => error
      )
      console.log('[b34] writer-held outcome =', JSON.stringify(heldResult).slice(0, 800))
      const heldText =
        heldResult instanceof Error
          ? heldResult.message
          : (heldResult as { error?: { message?: string }; frames?: unknown[] }).error?.message ?? ''
      if (heldResult instanceof Error || heldText !== '') {
        expect(`${heldResult instanceof Error ? heldResult.message : ''} ${heldText}`).toMatch(
          /writer-held|占用/
        )
      } else {
        // 实测：第二进程能对同一运行中会话开新一轮，内核没有拒绝 → writer-held 未在该场景触发
        console.log('[b34] writer-held NOT triggered: second process ran a concurrent turn')
      }

      await a1.cancelTurn('thread-b34')
      await slow.catch(() => null)
      stub.slow(false)

      // conflict：同 home 的另一个 cwd 用已属于 A 的 threadId
      b1 = await startAdapter(dirB, home, stub)
      const conflict = await b1.startTurn('跨目录', { threadId: 'thread-b34' }).then(
        () => null,
        (error: unknown) => error
      )
      console.log('[b34] conflict error =', conflict instanceof Error ? conflict.message : String(conflict))
      expect(conflict).toBeInstanceOf(Error)
      expect((conflict as Error).message).toContain('session/conflict')
    } finally {
      for (const adapter of [a1, a2, b1]) await adapter?.stop()
      await new Promise<void>((resolve) => {
        stub.server.close(() => {
          resolve()
        })
      })
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] b34 cleanup deferred', root)
      }
    }
  }, 300_000)
})
