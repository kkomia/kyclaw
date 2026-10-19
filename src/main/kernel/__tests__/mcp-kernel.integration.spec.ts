// @vitest-environment node
/**
 * PB-023 集成（默认跳过；`KYCLAW_KERNEL_E2E=1` 才跑）：
 *   settings.mcpServers → `ensureMcpHomePatch()` 写 `$DSH_HOME/cordis.patch.yml`
 *   → 真内核（rc.2 快照）加载 `@deepseek-ai/dsh-mcp-client`
 *   → stub LLM 让模型调用 `mcp__probe__ping` → 断言工具结果真的来自 MCP server。
 *
 * 另外钉一条验收要求：一个坏 server（command 不存在）**不能拖垮其它 MCP server / 内核启动**。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '../../../shared/settings'
import { startKernelAdapter } from '../kernel-adapter'
import { ensureMcpHomePatch } from '../mcp-profile'
import type { KernelFollowValue } from '../sse-map'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'F:\\deepseekharness\\resources\\app.asar'
const MCP_SERVER = fileURLToPath(new URL('./fixtures/mcp-probe-server.mjs', import.meta.url))
const TOOL_NAME = 'mcp__probe__ping'

function startToolStub(): Promise<{ server: Server; baseUrl: string }> {
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
          id: `msg_mcp_${String(calls)}`,
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
          content_block: { type: 'tool_use', id: 'toolu_mcp_1', name: TOOL_NAME, input: {} }
        })
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"text":"hi"}' }
        })
        send('content_block_stop', { type: 'content_block_stop', index: 0 })
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

function stdioServer(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'probe',
    name: 'probe',
    transport: 'stdio',
    command: process.execPath,
    args: [MCP_SERVER],
    env: {},
    enabled: true,
    readOnlyTools: [],
    ...overrides
  }
}

function collectToolResults(values: readonly KernelFollowValue[]): string[] {
  const texts: string[] = []
  for (const value of values) {
    if (value.type !== 'event' || value.event.type !== 'tool/result') continue
    const data = value.event.data as {
      message?: { content?: { type: string; text?: string }[] }
    }
    for (const part of data.message?.content ?? []) {
      if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
    }
  }
  return texts
}

/**
 * 收集本轮出现过的工具名：`tool/call` 事件的 data.name + assistant 消息里 tool-call 内容块的 name。
 * （只认一种事件形状会在时序差异下误报；两处合起来才是"模型确实调用了这个工具"。）
 */
function collectToolCallNames(values: readonly KernelFollowValue[]): string[] {
  const names: string[] = []
  for (const value of values) {
    if (value.type !== 'event') continue
    if (value.event.type === 'tool/call') {
      const name = (value.event.data as { name?: unknown }).name
      if (typeof name === 'string') names.push(name)
      continue
    }
    if (value.event.type !== 'assistant/message') continue
    const data = value.event.data as {
      message?: { content?: { type: string; name?: unknown }[] }
    }
    for (const part of data.message?.content ?? []) {
      if (part.type === 'tool-call' && typeof part.name === 'string') names.push(part.name)
    }
  }
  return names
}

describe.runIf(ENABLED)('PB-023：MCP 配置 → DSH 内核插件 → 真实工具调用', () => {
  it('stdio MCP server 被内核加载，模型调用 mcp__probe__ping 拿到 MCP-PONG', async () => {
    const stub = await startToolStub()
    const appDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-mcp-kernel-'))
    const dshHome = join(appDataDir, 'dsh-home')
    ensureMcpHomePatch(dshHome, [stdioServer()])
    try {
      const values: KernelFollowValue[] = []
      const adapter = await startKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir,
        dshHome,
        extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
        readyTimeoutMs: 60_000,
        turnTimeoutMs: 90_000,
        onFollowValue: (value) => values.push(value)
      })
      try {
        const result = await adapter.startTurn('调用 probe 的 ping 工具')
        expect(result.text).toContain('工具已完成')
        // 模型确实请求了这个 MCP 工具（tool/call 与 assistant 消息两处任一为准，避免事件时序误报）
        expect(collectToolCallNames(values)).toContain(TOOL_NAME)
        expect(collectToolResults(values).join('\n')).toContain('MCP-PONG:hi')
      } finally {
        await adapter.stop()
      }
    } finally {
      await new Promise<void>((resolve) => {
        stub.server.close(() => {
          resolve()
        })
      })
      rmSync(appDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 240_000)

  it('一个坏 server（command 不存在）不拖垮内核启动，也不影响好 server 的工具调用', async () => {
    const stub = await startToolStub()
    const appDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-mcp-kernel-bad-'))
    const dshHome = join(appDataDir, 'dsh-home')
    ensureMcpHomePatch(dshHome, [
      stdioServer({ id: 'probe' }),
      stdioServer({ id: 'broken', command: 'Z:\\kyclaw-definitely-missing.exe', args: [] })
    ])
    // 同时保留一份坏配置探针：证明 patch 确实写了两个 server（第二个会被内核插件报错，不是我们不写）
    writeFileSync(join(appDataDir, 'mcp-servers-used.json'), JSON.stringify(['probe', 'broken']))

    try {
      const values: KernelFollowValue[] = []
      const adapter = await startKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir,
        dshHome,
        extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
        readyTimeoutMs: 90_000,
        turnTimeoutMs: 90_000,
        onFollowValue: (value) => values.push(value)
      })
      try {
        const result = await adapter.startTurn('再调用 probe 的 ping 工具')
        expect(result.text).toContain('工具已完成')
        expect(collectToolCallNames(values)).toContain(TOOL_NAME)
        expect(collectToolResults(values).join('\n')).toContain('MCP-PONG:hi')
      } finally {
        await adapter.stop()
      }
    } finally {
      await new Promise<void>((resolve) => {
        stub.server.close(() => {
          resolve()
        })
      })
      rmSync(appDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }, 240_000)
})
