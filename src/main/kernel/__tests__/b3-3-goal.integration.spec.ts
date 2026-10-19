// @vitest-environment node
/**
 * B3.3 真机：goal 命令走内核命令平面（`commands/list` + `commands/execute`），
 * goal 数据来自内核 `session/page`，六行投影只读。
 * 默认跳过（KYCLAW_KERNEL_E2E=1）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startKernelAdapter, type KernelAdapter } from '../kernel-adapter'
import { projectGoalDock } from '../goal-projection'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'F:\\deepseekharness\\resources\\app.asar'

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
          id: 'msg_goal_cmd',
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
        delta: { type: 'text_delta', text: '收到。' }
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

describe.runIf(ENABLED)('B3.3 goal 命令与投影（内核权威）', () => {
  it('list 中含唯一 goal；create→query→pause→resume 四步都来自内核', async () => {
    const stub = await startStub()
    const appDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-b33-goal-'))
    let adapter: KernelAdapter | undefined
    try {
      adapter = await startKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir,
        extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
        readyTimeoutMs: 30_000,
        turnTimeoutMs: 60_000
      })
      const commands = await adapter.listCommands()
      console.log('[commands]', JSON.stringify(commands.map((command) => command.name)))
      expect(commands.filter((command) => command.name === 'goal')).toHaveLength(1)

      // 1) create
      const created = await adapter.executeCommand('/goal 完成迁移验证')
      console.log('[goal create]', JSON.stringify(created).slice(0, 800))
      const createdState = await adapter.readGoalState()
      expect(createdState?.goal.objective).toBe('完成迁移验证')
      expect(createdState?.goal.phase).toBe('active')
      const dock = projectGoalDock(createdState)
      console.log('[goal dock rounds]', dock.rounds?.label)
      expect(dock.rounds?.label).toContain(
        `/16（内核上限 ${String(createdState?.goal.maxGoalRounds ?? 0)}）`
      )

      // 2) query（裸 /goal）
      const queried = await adapter.executeCommand('/goal')
      console.log('[goal query]', JSON.stringify(queried).slice(0, 800))

      // 3) pause
      await adapter.executeCommand('/goal pause')
      expect((await adapter.readGoalState())?.goal.phase).toBe('paused')
      // 4) resume
      await adapter.executeCommand('/goal resume')
      expect((await adapter.readGoalState())?.goal.phase).toBe('active')

      // plan 归内核：读投影（只读），并走一次内核 /plan 命令
      const planBefore = await adapter.readPlanState()
      console.log('[plan before]', JSON.stringify(planBefore))
      const planResult = await adapter.executeCommand('/plan')
      console.log('[plan command]', JSON.stringify(planResult).slice(0, 600))
      const planAfter = await adapter.readPlanState()
      console.log('[plan after]', JSON.stringify(planAfter))
      expect(planBefore).toEqual({ active: false, pending: false })
      expect(planAfter).toEqual({ active: false, pending: true })
    } finally {
      await adapter?.stop()
      try {
        rmSync(appDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] b3-3 temp cleanup deferred', appDataDir)
      }
      await new Promise<void>((resolve) => {
        stub.server.close(() => {
          resolve()
        })
      })
    }
  }, 180_000)
})
