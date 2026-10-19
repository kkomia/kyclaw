// @vitest-environment node
/**
 * B3.1b 端到端（**默认跳过**）：**真实 HTTP chat 端点** + 真内核 adapter（flag 开）。
 *
 * 与 kernel-e2e 的差别：这里走 `POST /chat/<agentId>`（renderer 真正用的入口、同一 token 闸门），
 * 拿到的就是 renderer 会读到的 SSE 文本；再与 0.1.6 参考帧逐字段 diff。
 *
 * 开启：
 *   $env:KYCLAW_KERNEL_E2E='1'
 *   $env:KYCLAW_KERNEL_ELECTRON='F:\\deepseekharness\\DeepSeek Harness.exe'
 *   $env:KYCLAW_KERNEL_ASAR='F:\\deepseekharness\\resources\\app.asar'
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { startAgentServer, type AgentServerHandle } from '../../agent/service'
import { KYCLAW_AGENT_ID } from '../../../mastra/agents/kyclaw'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'F:\\deepseekharness\\resources\\app.asar'
const REFERENCE = fileURLToPath(
  new URL('./fixtures/renderer-sse-kyclaw-0.1.6.json', import.meta.url)
)
const POC_TEXT = 'POC-OK：内核 RPC 与事件流可用。'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

function startStub(): Promise<{ server: Server; baseUrl: string }> {
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
          id: 'msg_stub_b31b',
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
        delta: { type: 'text_delta', text: POC_TEXT }
      })
      send('content_block_stop', { type: 'content_block_stop', index: 0 })
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
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

function parseSse(text: string): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []
  for (const block of text.split('\n\n')) {
    const line = block.split('\n').find((value) => value.startsWith('data:'))
    if (line === undefined) continue
    try {
      frames.push(JSON.parse(line.slice(5).trimStart()) as Record<string, unknown>)
    } catch {
      // ignore non-JSON
    }
  }
  return frames
}

function normalizeRecords(frames: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return frames.map((frame) => {
    const clone = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>
    if (typeof clone.messageId === 'string') clone.messageId = '<id>'
    if (typeof clone.id === 'string') clone.id = '<id>'
    if (typeof clone.delta === 'string') clone.delta = '<text>'
    return clone
  })
}

function pidsForDataDir(dataDir: string): number[] {
  const command =
    "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + $env:KYCLAW_SCAN_DIR + '*') } | Select-Object -ExpandProperty ProcessId) -join ','"
  const output = execFileSync(POWERSHELL, ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, KYCLAW_SCAN_DIR: dataDir }
  }).trim()
  return output === '' ? [] : output.split(',').map((value) => Number(value))
}

async function waitNoProcesses(dataDir: string): Promise<number[]> {
  let remaining: number[] = []
  for (let attempt = 0; attempt < 50; attempt += 1) {
    remaining = pidsForDataDir(dataDir)
    if (remaining.length === 0) return []
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return remaining
}

describe.runIf(ENABLED)('B3.1b：真实 HTTP chat 端点 + 真内核（flag 开）', () => {
  it('一轮 SSE 与 0.1.6 参考逐字段一致；stop 后无孤儿/端口残留', async () => {
    const stub = await startStub()
    const dataDir = mkdtempSync(join(tmpdir(), 'kyclaw-b31b-chat-'))
    const previous = process.env.KYCLAW_KERNEL_PORT
    process.env.KYCLAW_KERNEL_PORT = '1'
    let server: AgentServerHandle | undefined
    try {
      server = await startAgentServer({
        dataDir,
        kernel: {
          electronExecutable: ELECTRON,
          asarPath: ASAR,
          extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl }
        }
      })

      const response = await fetch(`${server.baseUrl}/chat/${KYCLAW_AGENT_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
        body: JSON.stringify({
          messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'say hi' }] }]
        })
      })
      expect(response.status).toBe(200)
      const frames = parseSse(await response.text())

      const reference = JSON.parse(readFileSync(REFERENCE, 'utf8')) as Record<string, unknown>[]
      expect(normalizeRecords(frames)).toEqual(normalizeRecords(reference))
      const text = frames.flatMap((frame) =>
        frame.type === 'text-delta' && typeof frame.delta === 'string' ? [frame.delta] : []
      )
      expect(text.join('')).toBe(POC_TEXT)

      const port = server.port
      await server.stop()
      server = undefined
      // 目录里带本次唯一 dataDir 的进程（主进程 + 辅助进程）都该没了
      expect(await waitNoProcesses(dataDir), 'stop 后仍有内核进程存活').toEqual([])
      await expect(
        fetch(`http://127.0.0.1:${String(port)}/`, { redirect: 'manual' })
      ).rejects.toThrow()
    } finally {
      await server?.stop()
      if (previous === undefined) delete process.env.KYCLAW_KERNEL_PORT
      else process.env.KYCLAW_KERNEL_PORT = previous
      await new Promise<void>((resolve) => {
        stub.server.close(() => {
          resolve()
        })
      })
      try {
        rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] b3-1b 临时目录未能立刻删除（交给系统清理）：', dataDir)
      }
    }
  }, 180_000)
})
