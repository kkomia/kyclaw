// @vitest-environment node
/**
 * H2 / B3.2-B4：**错误轮必须保留已交付帧**（R11 基线）。
 *
 * 场景：stub 先流出一段文本，然后**破坏连接**（不发 message_stop）→ 内核轮次失败。
 * 断言（当前树）：`startTurn` resolve（不 reject）、frames 里有已交付的 text-delta、Error 信息在
 * `result.error` / 末尾 error 帧里；**文本帧不丢**。
 *
 * 在 956338a（B3.1a）上同一场景会 **reject 且拿不到 frames**，即红（见 evidence 文档）。
 *
 * 开启：
 *   $env:KYCLAW_KERNEL_E2E='1'
 *   $env:KYCLAW_KERNEL_ELECTRON='F:\\deepseekharness\\DeepSeek Harness.exe'
 *   $env:KYCLAW_KERNEL_ASAR='F:\\deepseekharness\\resources\\app.asar'
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startKernelAdapter } from '../kernel-adapter'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'F:\\deepseekharness\\resources\\app.asar'
const PARTIAL = '已经交付的部分回答。'

/**
 * 慢速 stub：先流出一段文本，然后**保持连接不结束**（等内核来取消）。
 * 这样能稳定复现"文本已交付 → 轮次被取消/失败"的场景，而不是依赖断链时序。
 */
function startFailingStub(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += String(chunk)
    })
    req.on('end', () => {
      void body
      if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url ?? '')) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const send = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      send('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_stub_fail',
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
        delta: { type: 'text_delta', text: PARTIAL }
      })
      // 不结束：等内核（或测试）取消；socket 被关时随之释放
      req.on('close', () => {
        res.destroy()
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('stub: no address')
      resolve({ server, baseUrl: `http://127.0.0.1:${String(address.port)}` })
    })
  })
}

describe.runIf(ENABLED)('H2：错误/取消轮保留已交付帧（R11）', () => {
  it('取消后 startTurn 不 reject；已交付文本仍在 frames，错误/取消只追加', async () => {
    const stub = await startFailingStub()
    const appDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-h2-error-'))
    try {
      const adapter = await startKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir,
        extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
        readyTimeoutMs: 30_000,
        turnTimeoutMs: 30_000
      })
      try {
        const pending = adapter.startTurn('say hi')
        // 等文本帧到达 follow（当前 adapter 是缓冲式；B3.2 会换成 onFrame 精确等待）
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        await adapter.cancelTurn()
        const result = await pending
        const text = result.frames
          .flatMap((frame) => (frame.type === 'text-delta' ? [frame.delta] : []))
          .join('')
        expect(text).toContain(PARTIAL)
        expect(
          result.cancelled === true ||
            result.error !== undefined ||
            result.frames.some((frame) => frame.type === 'error')
        ).toBe(true)
        // 文本帧必须在 error 帧之前（已交付内容不被错误吃掉）
        const types = result.frames.map((frame) => frame.type)
        const textIndex = types.indexOf('text-delta')
        const errorIndex = types.indexOf('error')
        if (errorIndex >= 0) expect(textIndex).toBeLessThan(errorIndex)
      } finally {
        await adapter.stop()
      }
    } finally {
      await new Promise<void>((resolve) => {
        stub.server.close(() => {
          resolve()
        })
      })
      try {
        rmSync(appDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] h2 temp cleanup deferred', appDataDir)
      }
    }
  }, 180_000)

  it('文本已交付后模型失败：frames 保留文本，错误只追加（不 reject）', async () => {
    const stub = await startFailAfterTextStub()
    const appDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-h2-after-text-'))
    try {
      const adapter = await startKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir,
        extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
        readyTimeoutMs: 30_000,
        turnTimeoutMs: 60_000
      })
      try {
        const result = await adapter.startTurn('say hi')
        const text = result.frames
          .flatMap((frame) => (frame.type === 'text-delta' ? [frame.delta] : []))
          .join('')
        expect(text).toContain('第一部分')
        expect(
          result.error !== undefined || result.frames.some((frame) => frame.type === 'error')
        ).toBe(true)
        const types = result.frames.map((frame) => frame.type)
        const textIndex = types.indexOf('text-delta')
        const errorIndex = types.indexOf('error')
        if (errorIndex >= 0) expect(textIndex).toBeLessThan(errorIndex)
      } finally {
        await adapter.stop()
      }
    } finally {
      await new Promise<void>((resolve) => {
        stub.server.close(() => {
          resolve()
        })
      })
      try {
        rmSync(appDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] h2 temp cleanup deferred (after-text)', appDataDir)
      }
    }
  }, 180_000)
})

/**
 * 先交付文本 + 一次工具调用，随后模型请求返回 500（内核重试后判失败）。
 * 用来复现"已交付文本之后轮次失败"的 R11 场景。
 */
function startFailAfterTextStub(): Promise<{ server: Server; baseUrl: string }> {
  let calls = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += String(chunk)
    })
    req.on('end', () => {
      void body
      if (req.method !== 'POST' || !/\/v1\/messages/.test(req.url ?? '')) {
        res.writeHead(404).end('not found')
        return
      }
      calls += 1
      if (calls > 1) {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const send = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      send('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_stub_after_text',
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
        delta: { type: 'text_delta', text: '第一部分' }
      })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_goal', input: {} }
      })
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{}' }
      })
      send('content_block_stop', { type: 'content_block_stop', index: 1 })
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { output_tokens: 8 }
      })
      send('message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) throw new Error('stub: no address')
      resolve({ server, baseUrl: `http://127.0.0.1:${String(address.port)}` })
    })
  })
}
