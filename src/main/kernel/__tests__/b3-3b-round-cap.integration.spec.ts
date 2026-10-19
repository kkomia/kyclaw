// @vitest-environment node
/**
 * B3.3b：内核真的在第 16 轮停（不是 UI 停）。
 *
 * 做法：把 `maxGoalRounds:16` 写进隔离 profile patch（`ensureGoalRoundCap`，不改内核包）；
 * stub 立即返回文本；`/goal` 创建后发一条 prompt，让内核 goal-round-driver 自动续跑；
 * 轮询 `session/projections` 记录每轮 roundsStarted/phase，直到 blocked/paused 或 16 轮。
 * 然后等 3s，证明**没有新的 turn/start**（内核自己停），并检查投影一致。
 *
 * 默认跳过（KYCLAW_KERNEL_E2E=1）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { startKernelAdapter, type KernelAdapter } from '../kernel-adapter'
import { projectGoalDock, type KernelGoalState } from '../goal-projection'
import type { KernelFollowValue } from '../sse-map'

const ENABLED = process.env.KYCLAW_KERNEL_E2E === '1'
const ELECTRON = process.env.KYCLAW_KERNEL_ELECTRON ?? 'F:\\deepseekharness\\DeepSeek Harness.exe'
const ASAR = process.env.KYCLAW_KERNEL_ASAR ?? 'F:\\deepseekharness\\resources\\app.asar'
const CAP = 16

function startStub(): Promise<{ server: Server; baseUrl: string; calls: () => number }> {
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
          id: `msg_cap_${String(calls)}`,
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
        delta: { type: 'text_delta', text: `第 ${String(calls)} 次模型调用。` }
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
      resolve({ server, baseUrl: `http://127.0.0.1:${String(address.port)}`, calls: () => calls })
    })
  })
}

describe.runIf(ENABLED)('B3.3b 内核第 16 轮停（配置钉死 + 实测）', () => {
  it('maxGoalRounds=16 生效；跑满 16 轮后内核不再发起新一轮', async () => {
    const stub = await startStub()
    const appDataDir = mkdtempSync(join(tmpdir(), 'kyclaw-b33b-cap-'))
    let adapter: KernelAdapter | undefined
    const turnStarts: number[] = []
    const roundsLog: Array<{ at: number; rounds: number; phase: string }> = []
    try {
      adapter = await startKernelAdapter({
        electronExecutable: ELECTRON,
        asarPath: ASAR,
        appDataDir,
        goalMaxRounds: CAP,
        extraEnv: { DEEPSEEK_API_KEY: 'test', DEEPSEEK_BASE_URL: stub.baseUrl },
        readyTimeoutMs: 30_000,
        turnTimeoutMs: 60_000,
        onFollowValue: (value: KernelFollowValue) => {
          if (value.type === 'event' && value.event.type === 'turn/start')
            turnStarts.push((value.event.data?.turn as number | undefined) ?? -1)
        }
      })

      await adapter.executeCommand(`/goal 16 轮安全阀实测`)
      const created = await adapter.readGoalState()
      expect(created?.goal.maxGoalRounds).toBe(CAP) // 配置真的生效
      expect(projectGoalDock(created).rounds?.label).toBe('0/16')

      const startedAt = Date.now()
      const pendingTurn = adapter.startTurn('开始')
      // 内核 goal-round-driver 自动续跑；轮询记录每轮
      let final: KernelGoalState | null = created
      for (let attempt = 0; attempt < 240; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        const state = await adapter.readGoalState()
        if (state !== null) {
          final = state
          const last = roundsLog.at(-1)
          if (last === undefined || last.rounds !== state.roundsStarted)
            roundsLog.push({
              at: Date.now() - startedAt,
              rounds: state.roundsStarted,
              phase: state.goal.phase
            })
          if (
            state.roundsStarted >= CAP ||
            state.goal.phase === 'blocked' ||
            state.goal.phase === 'paused'
          )
            break
        }
      }
      // 到 16 轮后继续等内核结算（blocked 可能晚一个事件）
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const state = await adapter.readGoalState()
        if (state !== null) {
          final = state
          const last = roundsLog.at(-1)
          if (last === undefined || last.rounds !== state.roundsStarted)
            roundsLog.push({
              at: Date.now() - startedAt,
              rounds: state.roundsStarted,
              phase: state.goal.phase
            })
          if (state.goal.phase === 'blocked' || state.goal.phase === 'paused') break
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      await pendingTurn.catch(() => null)
      const elapsedMs = Date.now() - startedAt
      console.log('[cap] turns', JSON.stringify(turnStarts))
      console.log('[cap] rounds', JSON.stringify(roundsLog))
      console.log(
        '[cap] final',
        JSON.stringify({
          phase: final?.goal.phase,
          roundsStarted: final?.roundsStarted,
          blockedReason: final?.goal.blockedReason,
          elapsedMs
        })
      )

      expect(final).not.toBeNull()
      expect(final?.roundsStarted).toBeGreaterThanOrEqual(CAP)
      expect(['blocked', 'paused']).toContain(final?.goal.phase)
      expect(final?.goal.blockedReason?.message ?? '').not.toBe('')

      // 内核自己停：等 3s，没有新的 turn/start（不是 UI 停）
      const turnsAtStop = turnStarts.length
      const roundsAtStop = final?.roundsStarted ?? 0
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      expect(turnStarts.length).toBe(turnsAtStop)
      expect((await adapter.readGoalState())?.roundsStarted).toBe(roundsAtStop)

      const dock = projectGoalDock(final ?? null)
      console.log('[cap] dock', JSON.stringify(dock.rows.map((row) => [row.id, row.value])))
      expect(dock.rounds?.label).toBe('16/16')
      expect(dock.rounds?.limit).toBe(CAP)
      expect(dock.rows.find((row) => row.id === 'activation')?.value).toContain('已停用')
      expect(dock.commands).toEqual(['goal clear'])
      console.log('[cap] modelCalls', stub.calls(), 'elapsedMs', elapsedMs)
    } finally {
      await adapter?.stop()
      try {
        rmSync(appDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
      } catch {
        console.warn('[kyclaw] b3-3b temp cleanup deferred', appDataDir)
      }
      await new Promise<void>((resolve) => {
        stub.server.close(() => {
          resolve()
        })
      })
    }
  }, 300_000)
})
