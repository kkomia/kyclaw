// @vitest-environment node
/**
 * B3.2 · 工具事件夹具采集（默认跳过；`KYCLAW_CAPTURE_TOOL=1` 时写 fixture）。
 * 用真实内核 + stub（tool_use: get_goal → 工具结果 → 文本）采 `session/follow` 原样事件。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { startKernelAdapter } from '../kernel-adapter'
import type { KernelFollowValue } from '../sse-map'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const CAPTURE = process.env.KYCLAW_CAPTURE_TOOL === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'F:\\deepseekharness\\resources\\app.asar'
const FIXTURE = fileURLToPath(new URL('./fixtures/kernel-tool-follow-values.json', import.meta.url))
const ERROR_FIXTURE = fileURLToPath(
  new URL('./fixtures/kernel-tool-error-follow-values.json', import.meta.url)
)

function startToolStub(toolName = 'get_goal'): Promise<{ server: Server; baseUrl: string }> {
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
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      const send = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }
      send('message_start', {
        type: 'message_start',
        message: {
          id: `msg_tool_${String(calls)}`,
          type: 'message',
          role: 'assistant',
          model: 'deepseek-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 1 }
        }
      })
      if (calls === 1) {
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '先读一下目标。' }
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_1', name: toolName, input: {} }
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '' }
        })
        send('content_block_stop', { type: 'content_block_stop', index: 1 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 8 }
        })
      } else {
        send('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '工具已完成。' }
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 8 }
        })
      }
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

describe.runIf(ENABLED)('B3.2 工具事件采集', () => {
  it('采 get_goal 的 tool/call + tool/result 原样事件', async () => {
    const stub = await startToolStub()
    const appDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-tool-fixture-'))
    try {
      const values: KernelFollowValue[] = []
      const adapter = await startKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir,
        extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
        readyTimeoutMs: 30_000,
        turnTimeoutMs: 60_000,
        onFollowValue: (value) => {
          if (value.type === 'event' && /tool|assistant\/message|turn\/end/.test(value.event.type))
            values.push(value)
        }
      })
      try {
        const result = await adapter.startTurn('read goal')
        if (CAPTURE) writeFileSync(FIXTURE, `${JSON.stringify(values, null, 2)}\n`, 'utf8')
        expect(result.text).toContain('工具已完成')
        // 便于人工核对形状（写进日志）
        console.log(
          '[tool-events]',
          JSON.stringify(
            values.map((value) => (value.type === 'event' ? value.event.type : value.type))
          )
        )
        console.log('[tool-events-json]', JSON.stringify(values, null, 2).slice(0, 4000))
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
        console.warn('[kyclaw] tool fixture cleanup deferred', appDataDir)
      }
    }
  }, 180_000)

  it('采工具报错（not_a_tool）的 tool/call + tool/result 原样事件', async () => {
    const stub = await startToolStub('not_a_tool')
    const appDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-tool-error-fixture-'))
    try {
      const values: KernelFollowValue[] = []
      const adapter = await startKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir,
        extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
        readyTimeoutMs: 30_000,
        turnTimeoutMs: 60_000,
        onFollowValue: (value) => {
          if (value.type === 'event' && /tool/.test(value.event.type)) values.push(value)
        }
      })
      try {
        await adapter.startTurn('call a missing tool')
        if (CAPTURE) writeFileSync(ERROR_FIXTURE, `${JSON.stringify(values, null, 2)}\n`, 'utf8')
        expect(
          values.some((value) => value.type === 'event' && value.event.type === 'tool/result')
        ).toBe(true)
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
        console.warn('[kyclaw] tool error fixture cleanup deferred', appDataDir)
      }
    }
  }, 180_000)
})
