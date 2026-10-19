// @vitest-environment node
/**
 * B3.1a 端到端（**默认跳过**，需显式开启）：
 * 起真内核（Electron-as-node + asar 内 bin，隔离 DSH_HOME）→ `/connect` → session → follow → prompt，
 * 用本地 stub provider 跑一轮，把映射出的 SSE 帧与 0.1.6 参考帧逐字段 diff。
 *
 * 开启：
 *   $env:KYCLAW_KERNEL_E2E='1'
 *   $env:KYCLAW_KERNEL_ELECTRON='F:\\deepseekharness\\DeepSeek Harness.exe'
 *   $env:KYCLAW_KERNEL_ASAR='F:\\deepseekharness\\resources\\app.asar'
 *   vitest run src/main/kernel/__tests__/kernel-e2e.integration.spec.ts
 *
 * 生命周期断言：正常 stop 后**主进程 + Electron 辅助进程**都退出、端口不可连；kill 后也不留孤儿。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { startKernelAdapter, type KernelAdapter } from '../kernel-adapter'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'F:\\deepseekharness\\resources\\app.asar'
const REFERENCE = fileURLToPath(
  new URL('./fixtures/renderer-sse-kyclaw-0.1.6.json', import.meta.url)
)
const POC_TEXT = 'POC-OK：内核 RPC 与事件流可用。'
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 本地 Anthropic Messages 兼容 stub（只监听回环；离线） */
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
          id: 'msg_stub_e2e',
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

function normalizeRecords(frames: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return frames.map((frame) => {
    const clone = JSON.parse(JSON.stringify(frame)) as Record<string, unknown>
    if (typeof clone.messageId === 'string') clone.messageId = '<id>'
    if (typeof clone.id === 'string') clone.id = '<id>'
    if (typeof clone.delta === 'string') clone.delta = '<text>'
    return clone
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid: number | undefined): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (pid === undefined || !isAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`kernel process ${String(pid)} is still alive`)
}

/** 用 PowerShell 精确查"命令行里带本次唯一 appDataDir"的进程（含 Electron 辅助进程）。
 * 路径经环境变量传入，避免 PowerShell 自己的命令行命中该路径造成自匹配。 */
function pidsForAppData(appDataDir: string): number[] {
  const command =
    "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + $env:KYCLAW_SCAN_DIR + '*') } | Select-Object -ExpandProperty ProcessId) -join ','"
  const output = execFileSync(POWERSHELL, ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, KYCLAW_SCAN_DIR: appDataDir }
  }).trim()
  return output === '' ? [] : output.split(',').map((value) => Number(value))
}

async function waitNoProcesses(appDataDir: string): Promise<number[]> {
  let remaining: number[] = []
  for (let attempt = 0; attempt < 50; attempt += 1) {
    remaining = pidsForAppData(appDataDir)
    if (remaining.length === 0) return []
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return remaining
}

describe.runIf(ENABLED)('B3.1a 真内核端到端（stub provider）', () => {
  it('一轮帧与 0.1.6 参考逐字段一致；stop 后无进程/端口残留', async () => {
    const stub = await startStub()
    const appDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-kernel-e2e-'))
    let adapter: KernelAdapter | undefined
    try {
      adapter = await startKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir,
        extraEnv: {
          DEEPSEEK_API_KEY: 'test',
          DEEPSEEK_BASE_URL: stub.baseUrl
        },
        readyTimeoutMs: 30_000,
        turnTimeoutMs: 60_000
      })
      expect(adapter.port).toBeGreaterThan(0)

      const result = await adapter.startTurn('say hi')
      expect(result.text).toBe(POC_TEXT)

      const reference = JSON.parse(readFileSync(REFERENCE, 'utf8')) as Record<string, unknown>[]
      expect(normalizeRecords(result.frames as unknown as Record<string, unknown>[])).toEqual(
        normalizeRecords(reference)
      )

      const pid = adapter.pid
      const port = adapter.port
      await adapter.stop()
      adapter = undefined
      await waitGone(pid)
      // Electron-as-node 也可能留下辅助进程：以"本次唯一 home 路径"为准全查
      expect(await waitNoProcesses(appDataDir), 'stop 后仍有内核进程存活').toEqual([])
      await expect(
        fetch(`http://127.0.0.1:${String(port)}/`, { redirect: 'manual' })
      ).rejects.toThrow()
    } finally {
      await adapter?.stop()
      await new Promise<void>((resolve) => {
        stub.server.close(() => {
          resolve()
        })
      })
      rmSync(appDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 180_000)

  it('子进程被外部 kill 后 stop() 仍能收尾（不留孤儿）', async () => {
    const stub = await startStub()
    const appDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-kernel-e2e-kill-'))
    let adapter: KernelAdapter | undefined
    try {
      adapter = await startKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir,
        extraEnv: {
          DEEPSEEK_API_KEY: 'test',
          DEEPSEEK_BASE_URL: stub.baseUrl
        },
        readyTimeoutMs: 30_000
      })
      const pid = adapter.pid
      expect(pid).toBeTypeOf('number')
      if (pid !== undefined) process.kill(pid)
      await adapter.stop()
      adapter = undefined
      await waitGone(pid)
      expect(await waitNoProcesses(appDataDir), 'kill 后仍有内核进程存活').toEqual([])
    } finally {
      await adapter?.stop()
      await new Promise<void>((resolve) => {
        stub.server.close(() => {
          resolve()
        })
      })
      rmSync(appDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 180_000)
})
